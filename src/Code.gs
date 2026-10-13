/**
 * LINE 料號比對機器人 — 主程式
 *
 * 指令碼屬性（專案設定 → 指令碼屬性）：
 *   LINE_CHANNEL_ACCESS_TOKEN  必填
 *   GEMINI_API_KEY             必填（之後換成客戶的 Key 只要改這裡）
 *   GEMINI_MODEL               選填，預設 gemini-3.8-flash
 *   WEBHOOK_TOKEN              選填，設定後 Webhook 網址需加 ?token=xxx
 *   SHEET_ID                   選填，獨立專案才需要；綁定在試算表上則免填
 *   TOP_N                      選填，回覆幾筆，預設 5
 *   CACHE_DAYS                 選填，查詢結果快取天數，預設 30
 */

function getConfig_() {
  var p = PropertiesService.getScriptProperties().getProperties();
  return {
    LINE_CHANNEL_ACCESS_TOKEN: p.LINE_CHANNEL_ACCESS_TOKEN || '',
    GEMINI_API_KEY: p.GEMINI_API_KEY || '',
    GEMINI_MODEL: p.GEMINI_MODEL || 'gemini-3.8-flash',
    WEBHOOK_TOKEN: p.WEBHOOK_TOKEN || '',
    SHEET_ID: p.SHEET_ID || '',
    TOP_N: parseInt(p.TOP_N, 10) || 5,
    CACHE_DAYS: parseFloat(p.CACHE_DAYS) || 30
  };
}

function getSpreadsheet_() {
  var id = getConfig_().SHEET_ID;
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

// ======================== Webhook 入口 ========================

function doGet() {
  return ContentService.createTextOutput('LINE part-matching bot is running.');
}

function doPost(e) {
  var cfg = getConfig_();
  // Apps Script 讀不到 X-Line-Signature 標頭，改用網址上的 token 驗證來源
  if (cfg.WEBHOOK_TOKEN && (!e.parameter || e.parameter.token !== cfg.WEBHOOK_TOKEN)) {
    console.warn('Webhook token 不符，已拒絕。請確認 LINE Webhook URL 結尾為 ?token=（WEBHOOK_TOKEN 的值）');
    return ContentService.createTextOutput('forbidden');
  }
  var body = JSON.parse((e.postData && e.postData.contents) || '{}');
  var cache = CacheService.getScriptCache();
  var jobs = [];

  // 先把每個事件都回覆完（reply token 要盡快用），需要上網查的料號最後再跑
  (body.events || []).forEach(function (ev) {
    // LINE 重送的事件略過，避免重複查詢
    if (ev.deliveryContext && ev.deliveryContext.isRedelivery) return;
    if (ev.webhookEventId) {
      if (cache.get('ev_' + ev.webhookEventId)) return;
      cache.put('ev_' + ev.webhookEventId, '1', 600);
    }
    try {
      var job = handleEvent_(ev);
      if (job) jobs.push(job);
    } catch (err) {
      console.error(err && err.stack || err);
      if (ev.replyToken) replyText_(ev.replyToken, '⚠️ 發生錯誤：' + (err.message || err));
    }
  });
  jobs.forEach(function (job) { runJob_(job.part, job.force); });
  return ContentService.createTextOutput('ok');
}

/** 處理單一事件；需要上網查詢時回傳 {part, force}，由 doPost 在回覆完後執行 */
function handleEvent_(ev) {
  if (ev.type === 'follow') {
    replyText_(ev.replyToken, helpText_());
    return null;
  }
  if (ev.type !== 'message' || ev.message.type !== 'text') return null;

  var text = String(ev.message.text || '').trim();
  if (/^(help|說明|使用說明|\?|？)$/i.test(text)) {
    replyText_(ev.replyToken, helpText_());
    return null;
  }
  var cache = CacheService.getScriptCache();
  var chat = ev.source && (ev.source.groupId || ev.source.roomId || ev.source.userId);

  // 「結果」= 再問一次這個聊天室最後查詢的料號
  if (/^(結果|查詢結果|result)$/i.test(text)) {
    var last = chat && cache.get('last_' + chat);
    if (!last) {
      replyText_(ev.replyToken, '目前沒有查詢中的料號，請先輸入料號，例如：RH6E040BGTB1');
      return null;
    }
    text = last;
  }

  var force = false;
  var m = text.match(/^(重查|refresh)\s+(.+)$/i);
  if (m) { force = true; text = m[2].trim(); }

  var part = text.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9\-\/.#_+,()]{2,39}$/.test(part) || !/\d/.test(part)) {
    // 群組裡的一般聊天不回應；1 對 1 才提示
    if (ev.source && ev.source.type === 'user') replyText_(ev.replyToken, '請輸入料號，例如：RH6E040BGTB1\n輸入「說明」看使用方式');
    return null;
  }
  if (chat) cache.put('last_' + chat, part, JOB_TTL_SEC_);

  var job = force ? null : getJob_(part);
  // 還在查詢中
  if (job && job.status === 'running' && Date.now() - job.start < JOB_TIMEOUT_MS_) {
    replyText_(ev.replyToken, '⏳ ' + part + ' 還在查詢中（已 ' + Math.round((Date.now() - job.start) / 1000) +
      ' 秒）\n請稍後再輸入「結果」');
    return null;
  }
  // 查詢已完成（或失敗）→ 回覆結果，只送一次；之後再問就從清單/快取直接回
  if (job && job.status !== 'running') {
    cache.remove(JOB_PREFIX_ + part);
    replyText_(ev.replyToken, job.text);
    return null;
  }
  // 清單內料號或快取裡已有參數 → 不用上網，直接回
  var quick = force ? null : lookupAndMatch(part, false, true);
  if (quick) {
    replyText_(ev.replyToken, quick);
    return null;
  }
  // 需要上網查：先回「已開始查詢」，回覆完再背景查
  cache.put(JOB_PREFIX_ + part, JSON.stringify({ status: 'running', start: Date.now() }), JOB_TTL_SEC_);
  replyText_(ev.replyToken, '🔎 已開始上網查詢 ' + part + '\n約需 10~30 秒，請稍後輸入「結果」查看\n（或再傳一次料號）');
  return { part: part, force: force };
}

// ======================== 背景查詢狀態（存在 CacheService）========================

var JOB_PREFIX_ = 'job_';
var JOB_TTL_SEC_ = 21600;          // 查詢狀態保留 6 小時（CacheService 上限）
var JOB_TIMEOUT_MS_ = 6 * 60000;   // 超過 Apps Script 6 分鐘執行上限仍是 running → 視為失敗，重新查

function getJob_(part) {
  var s = CacheService.getScriptCache().get(JOB_PREFIX_ + part);
  try { return s ? JSON.parse(s) : null; } catch (e) { return null; }
}

/** 上網查詢並把回覆文字存起來，等使用者來問 */
function runJob_(part, force) {
  var job;
  try {
    job = { status: 'done', text: lookupAndMatch(part, force) };
  } catch (err) {
    console.error(err && err.stack || err);
    job = { status: 'error', text: '⚠️ 查詢 ' + part + ' 時發生錯誤：' + (err.message || err) + '\n請再傳一次料號重試' };
  }
  CacheService.getScriptCache().put(JOB_PREFIX_ + part, JSON.stringify(job), JOB_TTL_SEC_);
}

/**
 * 主流程：查參數 → 比對 → 組回覆文字（也可在編輯器直接執行測試）
 * offlineOnly=true 時只用清單和查詢快取，需要上網才查得到就回傳 null
 */
function lookupAndMatch(part, force, offlineOnly) {
  var t0 = Date.now();
  var cfg = getConfig_();
  var catalog = loadCatalog();
  var trace = [];  // 查詢過程，顯示在回覆最後

  // 輸入的就是清單內的料號 → 直接用清單參數找相近料號，不用上網
  var own = catalog.filter(function (c) { return c.part.toUpperCase() === part; })[0];
  var target, spec = null;
  if (own) {
    target = own;
    trace.push('📋 Toshiba 清單：有此料號 → 直接用清單參數');
  } else {
    trace.push('📋 Toshiba 清單：沒有此料號');
    spec = force ? null : getCachedSpec_(part);
    if (spec) {
      trace.push('💾 查詢快取：有（' + (spec._cachedAt || '') + ' 查過，不重新上網）');
    } else {
      if (offlineOnly) return null;
      trace.push(force ? '💾 查詢快取：略過（重查）' : '💾 查詢快取：沒有');
      spec = geminiLookup(part);
      if (spec.found !== false) saveCachedSpec_(part, spec);
      trace.push('🌐 上網查詢：Gemini + Google 搜尋');
    }
    var sites = sourceSites_(spec);
    if (sites) trace.push('🔗 參數來源：' + sites);
  }
  trace.push('⏱ 耗時 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
  console.log('lookup ' + part + ' ' + (Date.now() - t0) + 'ms');

  if (spec && spec.found === false) {
    return '❓ 查不到 ' + part + ' 的 MOSFET 參數' + (spec.note ? '\n' + spec.note : '') + '\n請確認料號是否正確。' +
      '\n\n〔查詢過程〕\n' + trace.join('\n') + '\n' + toshibaXrefLine_(part);
  }
  if (spec) {
    target = specToTarget(spec);
    if (!target.part) target.part = part;
  }

  var matches = findMatches(target, catalog, cfg.TOP_N);
  return formatReply_(part, target, matches, !!own, trace);
}

/** 參考來源網站（Gemini 給的 uri 是 Google 轉址網址，所以改顯示網域名稱） */
function sourceSites_(spec) {
  var seen = {};
  return ((spec && spec.sources) || []).map(function (s) {
    return s.title || '';
  }).filter(function (t) {
    if (!t || seen[t]) return false;
    seen[t] = 1;
    return true;
  }).join('、');
}

/** Toshiba 官方 Cross Reference（需登入 Toshiba 帳號、會擋程式存取，所以只附連結讓使用者點） */
function toshibaXrefLine_(part) {
  return '🔗 Toshiba 官方對照（需登入）：\nhttps://toshiba.semicon-storage.com/tw/search/cross-reference.2.EQUALS.all.' +
    encodeURIComponent(part) + '.html';
}

// ======================== 回覆格式 ========================

function fmt_(v, unit) {
  if (v === null || v === undefined || v === '') return '-';
  var n = Number(v);
  var s = n >= 100 ? String(Math.round(n)) : String(+n.toPrecision(3));
  return s + unit;
}

function specLine_(x) {
  var parts = [
    x.polarityRaw || x.polarity || '?',
    fmt_(x.vdss, 'V'),
    fmt_(x.id, 'A'),
    'Rds ' + fmt_(x.rds10, 'mΩ') + '@10V' + (x.rds45 ? ' / ' + fmt_(x.rds45, 'mΩ') + '@4.5V' : '')
  ];
  if (x.qg) parts.push('Qg ' + fmt_(x.qg, 'nC'));
  return parts.join('｜');
}

function pkgLine_(x) {
  var s = x.pkg || '-';
  if (x.w && x.l) s += ' (' + x.w + '×' + x.l + (x.h ? '×' + x.h : '') + 'mm)';
  return s;
}

function formatReply_(input, t, matches, isOwn, trace) {
  var lines = [];
  lines.push('🔎 ' + input + (t.maker ? '（' + t.maker + '）' : ''));
  lines.push(specLine_(t) + (t.rdsTyp ? '（Rds 為 typ）' : ''));
  lines.push('📦 ' + pkgLine_(t));
  lines.push('');

  if (!matches.length) {
    lines.push('😢 清單中找不到極性/耐壓相符的料號');
  } else {
    lines.push('✅ 最相近的料號：');
    matches.forEach(function (m, i) {
      var c = m.item;
      lines.push('');
      lines.push((i + 1) + '. ' + c.part + '　相似度 ' + Math.round(m.score * 100) + '%');
      lines.push('   ' + specLine_(c));
      lines.push('   📦 ' + pkgLine_(c));
      if (c.lifecycle) lines.push('   ' + c.lifecycle);
    });
  }
  lines.push('');
  lines.push('〔查詢過程〕');
  lines.push.apply(lines, trace || []);
  if (!isOwn) lines.push(toshibaXrefLine_(input));
  lines.push('');
  lines.push(isOwn ? 'ℹ️ 此料號在清單內，以上為相近替代料號'
                   : '⚠️ 參數由 AI 從網路整理，請以原廠 datasheet 為準\n（輸入「重查 ' + input + '」可重新上網查詢）');
  return lines.join('\n');
}

function helpText_() {
  return '📘 料號比對機器人\n\n' +
    '輸入任一 MOSFET 料號，例如：\nRH6E040BGTB1\n\n' +
    '機器人會上網查詢參數，並從 Toshiba 料號清單中找出最相近的替代料號。\n' +
    '需要上網查詢時會先回「已開始查詢」，約 10~30 秒後輸入「結果」即可查看。\n\n' +
    '・比對項目：極性、VDSS、RDS(on)、ID、封裝尺寸、Qg、Ciss\n' +
    '・查詢結果會快取，輸入「重查 料號」可強制重新查詢';
}

// ======================== LINE API ========================

function lineApi_(path, payload) {
  return UrlFetchApp.fetch('https://api.line.me/v2/bot/' + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + getConfig_().LINE_CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

/** 只用 reply（不計入訊息額度），不使用 push */
function replyText_(replyToken, text) {
  if (!replyToken) return;
  var messages = [{ type: 'text', text: String(text).slice(0, 4900) }];
  var res = lineApi_('message/reply', { replyToken: replyToken, messages: messages });
  if (res.getResponseCode() !== 200) console.warn('reply 失敗 ' + res.getResponseCode() + ' ' + res.getContentText());
}

// ======================== 編輯器測試用 ========================

/** 在 Apps Script 編輯器選這個函式按「執行」，到「執行紀錄」看結果 */
function testLookup() {
  console.log(lookupAndMatch('RH6E040BGTB1', false));
}

function testCatalog() {
  var items = loadCatalog();
  console.log('料號筆數：' + items.length);
  console.log(JSON.stringify(items.filter(function (c) { return c.part === 'TPN2R203NC'; })[0]));
}
