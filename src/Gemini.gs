/**
 * 用 Gemini + Google 搜尋查詢料號參數
 */

var GEMINI_PROMPT_ =
  'You are an electronic component engineer. Use Google Search to find the official datasheet ' +
  'or manufacturer product page of the MOSFET part number "{PART}", then extract its parameters.\n' +
  'Rules:\n' +
  '- Prefer the manufacturer datasheet; distributor pages only if the datasheet is unavailable.\n' +
  '- RDS(on) must be the MAXIMUM value in milliohms at the given VGS. If only typical is published, use typical and set rds_is_typical=true.\n' +
  '- ID is the continuous drain current at Tc=25C (or Ta=25C if Tc not given). PD likewise.\n' +
  '- Qg is total gate charge typical at VGS=10V (or 4.5V if 10V not given), in nC. Ciss typical in pF.\n' +
  '- width_mm/length_mm/height_mm are the package BODY outline dimensions in mm (e.g. HSMT8 = 3.3 x 3.3 x 0.8, SOP8 = 5.0 x 6.0, TO-220 = 10 x 15).\n' +
  '- polarity must be exactly one of: "N-ch", "P-ch", "N-ch x 2", "P-ch x 2", "N-ch + P-ch".\n' +
  '- Use null for any value you cannot find. Never guess numbers.\n' +
  '- If the part number does not exist or is not a MOSFET, set found=false and explain in note.\n' +
  'Reply with ONLY one JSON object, no markdown, with these keys:\n' +
  '{"found":true,"part_number":"","manufacturer":"","description":"","polarity":"",' +
  '"vdss_v":null,"vgss_v":null,"id_a":null,"pd_w":null,' +
  '"rds_on_10v_mohm":null,"rds_on_4v5_mohm":null,"rds_on_2v5_mohm":null,"rds_is_typical":false,' +
  '"qg_nc":null,"ciss_pf":null,"package":"","pins":null,"surface_mount":null,' +
  '"width_mm":null,"length_mm":null,"height_mm":null,"note":""}';

/** 呼叫 Gemini 取得料號參數（原始 JSON 物件 + 參考來源網址） */
function geminiLookup(part) {
  var cfg = getConfig_();
  if (!cfg.GEMINI_API_KEY) throw new Error('尚未設定 GEMINI_API_KEY（指令碼屬性）');
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(cfg.GEMINI_MODEL) + ':generateContent';
  var body = {
    contents: [{ role: 'user', parts: [{ text: GEMINI_PROMPT_.replace('{PART}', part) }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0 }
  };
  var res, code;
  for (var attempt = 0; attempt < 3; attempt++) {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': cfg.GEMINI_API_KEY },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    code = res.getResponseCode();
    if (code !== 429 && code < 500) break;
    Utilities.sleep(2000 * (attempt + 1));
  }
  if (code !== 200) throw new Error('Gemini API 錯誤 ' + code + '：' + res.getContentText().slice(0, 300));

  var data = JSON.parse(res.getContentText());
  var cand = (data.candidates || [])[0] || {};
  var text = ((cand.content || {}).parts || []).map(function (p) { return p.text || ''; }).join('');
  var spec = extractJson_(text);
  if (!spec) throw new Error('Gemini 回傳無法解析：' + text.slice(0, 200));

  var sources = [];
  var chunks = (cand.groundingMetadata || {}).groundingChunks || [];
  chunks.forEach(function (c) {
    if (c.web && c.web.uri && sources.length < 3) sources.push({ title: c.web.title || '', uri: c.web.uri });
  });
  spec.sources = sources;
  return spec;
}

/** 從模型回覆中抓出第一個 JSON 物件 */
function extractJson_(text) {
  if (!text) return null;
  var s = text.replace(/```(?:json)?/gi, '');
  var start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

/** Gemini JSON → 比對用格式（與 Catalog 相同欄位） */
function specToTarget(spec) {
  return {
    part: spec.part_number || '',
    maker: spec.manufacturer || '',
    desc: spec.description || '',
    polarityRaw: spec.polarity || '',
    polarity: normPolarity(spec.polarity),
    vdss: num(spec.vdss_v),
    vgss: num(spec.vgss_v),
    id: num(spec.id_a),
    pd: num(spec.pd_w),
    rds10: num(spec.rds_on_10v_mohm),
    rds45: num(spec.rds_on_4v5_mohm),
    rds25: num(spec.rds_on_2v5_mohm),
    rdsTyp: !!spec.rds_is_typical,
    qg: num(spec.qg_nc),
    ciss: num(spec.ciss_pf),
    pkg: spec.package || '',
    pins: num(spec.pins),
    smd: spec.surface_mount === true ? true : (spec.surface_mount === false ? false : null),
    w: num(spec.width_mm),
    l: num(spec.length_mm),
    h: num(spec.height_mm)
  };
}

// ---- 查詢結果快取（存在試算表的「查詢快取」分頁，省 API 費用）----

var CACHE_SHEET_ = '查詢快取';

function getCachedSpec_(part) {
  var sheet = getSpreadsheet_().getSheetByName(CACHE_SHEET_);
  if (!sheet || sheet.getLastRow() < 2) return null;
  var key = part.toUpperCase();
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  var maxAge = getConfig_().CACHE_DAYS * 86400000;
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0]).toUpperCase() === key) {
      var t = new Date(values[i][1]).getTime();
      if (Date.now() - t > maxAge) return null;
      try {
        var spec = JSON.parse(values[i][2]);
        spec._cachedAt = new Date(t + 8 * 3600000).toISOString().slice(0, 10);  // 台灣日期
        return spec;
      } catch (e) { return null; }
    }
  }
  return null;
}

function saveCachedSpec_(part, spec) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(CACHE_SHEET_);
  if (!sheet) {
    sheet = ss.insertSheet(CACHE_SHEET_);
    sheet.appendRow(['料號', '查詢時間', '參數 JSON（可手動修正）']);
    sheet.setFrozenRows(1);
  }
  var key = part.toUpperCase();
  var last = sheet.getLastRow();
  if (last >= 2) {
    var keys = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0]).toUpperCase() === key) {
        sheet.getRange(i + 2, 2, 1, 2).setValues([[new Date(), JSON.stringify(spec)]]);
        return;
      }
    }
  }
  sheet.appendRow([key, new Date(), JSON.stringify(spec)]);
}
