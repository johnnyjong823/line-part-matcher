/**
 * 讀取 Google 試算表中的料號清單（原 param_304_en.xlsx）並轉成比對用格式
 */

// 依表頭文字找欄位（不寫死欄位順序，之後 Excel 欄位調整也能用）
var CATALOG_COLUMNS = {
  part: /^part\s*number/i,
  desc: /^description/i,
  lifecycle: /^life-?cycle/i,
  polarity: /^polarity/i,
  vdss: /^vdss/i,
  vgss: /^vgss/i,
  id: /^id\s*\(/i,
  pd: /^pd\s*\(/i,
  ciss: /^ciss/i,
  qg: /^qg\s*\(/i,
  rds4: /rds.*=\s*4\s*v$/i,
  rds45: /rds.*=\s*4\.5\s*v$/i,
  rds6: /rds.*=\s*6\s*v$/i,
  rds8: /rds.*=\s*8\s*v$/i,
  rds10: /rds.*=\s*10\s*v$/i,
  pins: /^number of pins/i,
  smd: /^surface mount/i,
  pkg: /package name$/i,
  gen: /^generation/i,
  dims: /^width\s*x\s*length/i
};

/** values: 試算表 2D 陣列（第一列為表頭）→ 料號物件陣列 */
function parseCatalogRows(values) {
  var header = values[0].map(function (h) { return String(h).trim(); });
  var col = {};
  Object.keys(CATALOG_COLUMNS).forEach(function (k) {
    for (var i = 0; i < header.length; i++) {
      if (CATALOG_COLUMNS[k].test(header[i])) { col[k] = i; break; }
    }
  });
  if (col.part === undefined) throw new Error('找不到 "Part Number" 欄位，請確認試算表第一列是表頭');

  var get = function (row, k) { return col[k] === undefined ? '' : row[col[k]]; };
  var items = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var part = String(get(row, 'part') || '').trim();
    if (!part) continue;
    var desc = String(get(row, 'desc') || '');
    var ohm = function (k) { var v = num(get(row, k)); return v ? v * 1000 : null; }; // Ω → mΩ
    var it = {
      part: part,
      maker: 'Toshiba',
      desc: desc,
      lifecycle: String(get(row, 'lifecycle') || ''),
      polarityRaw: String(get(row, 'polarity') || ''),
      polarity: normPolarity(get(row, 'polarity')),
      vdss: num(get(row, 'vdss')),
      vgss: num(String(get(row, 'vgss')).replace(/\+\/-|±/g, '')),
      id: num(get(row, 'id')),
      pd: num(get(row, 'pd')),
      ciss: num(get(row, 'ciss')),
      qg: num(get(row, 'qg')),
      rds4: ohm('rds4'),
      rds45: ohm('rds45'),
      rds10: ohm('rds10'),
      pins: num(get(row, 'pins')),
      smd: /^y/i.test(String(get(row, 'smd'))) ? true : (/^n/i.test(String(get(row, 'smd'))) ? false : null),
      pkg: String(get(row, 'pkg') || ''),
      gen: String(get(row, 'gen') || '')
    };
    // 小訊號 MOSFET 常沒有填 RDS 欄，改從 Description 解析，例如 "82 mΩ@10 V"
    var re = /([\d.]+)\s*(m?)\s*[ΩΩ]\s*@\s*([\d.]+)\s*V/g, m;
    while ((m = re.exec(desc)) !== null) {
      var val = parseFloat(m[1]) * (m[2] ? 1 : 1000);
      var vgs = parseFloat(m[3]);
      if (vgs === 10 && !it.rds10) it.rds10 = val;
      else if (vgs === 4.5 && !it.rds45) it.rds45 = val;
      else if (vgs === 4 && !it.rds4) it.rds4 = val;
    }
    // 只有 6V / 8V 數據時，當作 10V 近似值
    if (!it.rds10) it.rds10 = ohm('rds8') || ohm('rds6');
    var dims = String(get(row, 'dims') || '').split(/\s*[x×]\s*/).map(parseFloat);
    if (dims.length >= 2 && dims[0] > 0 && dims[1] > 0) {
      it.w = dims[0]; it.l = dims[1]; it.h = dims[2] || null;
    }
    items.push(it);
  }
  return items;
}

/** 從試算表載入料號清單（快取 10 分鐘） */
function loadCatalog() {
  var cache = CacheService.getScriptCache();
  var cached = getChunkedCache_(cache, 'catalog_v1');
  if (cached) return JSON.parse(cached);

  var ss = getSpreadsheet_();
  var sheet = null;
  ss.getSheets().forEach(function (s) {
    if (!sheet && /^part\s*number/i.test(String(s.getRange(1, 1).getValue()))) sheet = s;
  });
  if (!sheet) throw new Error('試算表中找不到 A1 為 "Part Number" 的工作表');
  var items = parseCatalogRows(sheet.getDataRange().getValues());
  putChunkedCache_(cache, 'catalog_v1', JSON.stringify(items), 600);
  return items;
}

/** CacheService 單筆上限 100KB，切塊存放 */
function putChunkedCache_(cache, key, str, ttl) {
  var size = 90000, n = Math.ceil(str.length / size), obj = {};
  for (var i = 0; i < n; i++) obj[key + '_' + i] = str.substr(i * size, size);
  obj[key + '_n'] = String(n);
  cache.putAll(obj, ttl);
}

function getChunkedCache_(cache, key) {
  var n = parseInt(cache.get(key + '_n'), 10);
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '_' + i);
  var got = cache.getAll(keys), out = '';
  for (var j = 0; j < n; j++) {
    if (got[keys[j]] === undefined) return null;
    out += got[keys[j]];
  }
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { parseCatalogRows: parseCatalogRows };
}
