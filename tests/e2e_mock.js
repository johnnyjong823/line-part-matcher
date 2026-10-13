// 以假的 Apps Script 環境跑完整 doPost 流程：node tests/e2e_mock.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const values = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog_values.json'), 'utf8'));
const calls = [];
const store = {};
const cacheRows = [];
const mkSheet = (name, vals) => ({
  getName: () => name,
  getRange: (r, c, nr, nc) => ({
    getValue: () => vals()[r - 1][c - 1],
    getValues: () => vals().slice(r - 1, r - 1 + nr).map(x => x.slice(c - 1, c - 1 + nc)),
    setValues: v => { const rows = vals(); v.forEach((row, i) => row.forEach((x, j) => rows[r - 1 + i][c - 1 + j] = x)); }
  }),
  getDataRange: () => ({ getValues: () => vals() }),
  getLastRow: () => vals().length,
  appendRow: row => vals().push(row),
  setFrozenRows: () => {}
});
const sheets = [mkSheet('param', () => values)];
const ss = {
  getSheets: () => sheets,
  getSheetByName: n => sheets.find(s => s.getName() === n) || null,
  insertSheet: n => { const s = mkSheet(n, () => cacheRows); sheets.push(s); return s; }
};
const geminiReply = { candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify({
  found: true, part_number: 'RH6E040BGTB1', manufacturer: 'ROHM', polarity: 'N-ch', vdss_v: 30, vgss_v: 20, id_a: 125, pd_w: 78,
  rds_on_10v_mohm: 2.9, rds_on_4v5_mohm: 4.4, qg_nc: 30, ciss_pf: null, package: 'HSMT8', pins: 8, surface_mount: true,
  width_mm: 3.3, length_mm: 3.3, height_mm: 0.8 }) + '\n```' }] },
  groundingMetadata: { groundingChunks: [{ web: { uri: 'https://www.rohm.com/x', title: 'rohm.com' } }] } }] };
const ctx = {
  console,
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ LINE_CHANNEL_ACCESS_TOKEN: 't', GEMINI_API_KEY: 'k', WEBHOOK_TOKEN: 'sec' }) }) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
  CacheService: { getScriptCache: () => ({
    get: k => store[k] ?? null, put: (k, v) => store[k] = v, remove: k => delete store[k],
    putAll: o => Object.assign(store, o), getAll: ks => Object.fromEntries(ks.filter(k => k in store).map(k => [k, store[k]]))
  }) },
  ContentService: { createTextOutput: s => s },
  Utilities: { sleep: () => {} },
  UrlFetchApp: { fetch: (url, opt) => {
    calls.push({ url, body: JSON.parse(opt.payload) });
    const body = url.includes('generativelanguage') ? geminiReply : {};
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
  } }
};
vm.createContext(ctx);
for (const f of ['Matcher.gs', 'Catalog.gs', 'Gemini.gs', 'Code.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', f), 'utf8'), ctx, { filename: f });

const ev = (text, id) => ({ postData: { contents: JSON.stringify({ events: [{ type: 'message', webhookEventId: id, replyToken: 'rt', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text } }] }) }, parameter: { token: 'sec' } });
let fail = 0; const assert = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };

const replies = () => calls.filter(c => c.url.endsWith('message/reply')).map(c => c.body.messages[0].text);
assert(ctx.doPost({ postData: { contents: '{}' }, parameter: {} }) === 'forbidden', 'wrong token rejected');

// 1. 第一次問：先回「已開始查詢」，回覆完才呼叫 Gemini
ctx.doPost(ev('rh6e040bgtb1', 'e1'));
const iReply = calls.findIndex(c => c.url.endsWith('message/reply'));
const iGemini = calls.findIndex(c => c.url.includes('generativelanguage'));
assert(/已開始上網查詢 RH6E040BGTB1/.test(replies()[0]) && replies().length === 1, 'first ask: ack reply only');
assert(iReply >= 0 && iGemini > iReply, 'Gemini called after ack reply');
assert(!calls.some(c => c.url.includes('message/push')), 'no push used');
assert(cacheRows.length === 2, 'spec cached to sheet');

// 2. 輸入「結果」→ 回覆完整結果（含查詢過程）
calls.length = 0;
ctx.doPost(ev('結果', 'e2'));
const result = replies()[0];
console.log('----\n' + result + '\n----');
assert(/TPN2R203NC/.test(result), 'result contains TPN2R203NC');
assert(/Toshiba 清單：沒有此料號/.test(result) && /快取：沒有/.test(result) && /參數來源：rohm\.com/.test(result), 'trace: catalog miss, cache miss, source site');
assert(/cross-reference\.2\.EQUALS\.all\.RH6E040BGTB1\.html/.test(result), 'Toshiba cross-reference link');
assert(!calls.some(c => c.url.includes('generativelanguage')), 'result: no Gemini call');

// 3. 再問同料號 → 直接從試算表快取回覆
calls.length = 0;
ctx.doPost(ev('RH6E040BGTB1', 'e3'));
assert(!calls.some(c => c.url.includes('generativelanguage')) && /查詢快取：有（\d{4}-\d\d-\d\d/.test(replies()[0]), 'cache hit: direct reply with date');
calls.length = 0;
ctx.doPost(ev('RH6E040BGTB1', 'e3'));
assert(calls.length === 0, 'duplicate webhookEventId ignored');

// 4. 查詢中再問 → 回「還在查詢中」
calls.length = 0;
store['job_ABC123'] = JSON.stringify({ status: 'running', start: Date.now() - 5000 });
ctx.doPost(ev('ABC123', 'e4'));
assert(/還在查詢中/.test(replies()[0]) && !calls.some(c => c.url.includes('generativelanguage')), 'running job: pending reply');

// 5. 重查 → 忽略快取重新查
calls.length = 0;
ctx.doPost(ev('重查 RH6E040BGTB1', 'e5'));
assert(/已開始上網查詢/.test(replies()[0]) && calls.some(c => c.url.includes('generativelanguage')), 'force refresh re-queries');

// 6. 沒查過就問結果
calls.length = 0;
ctx.doPost({ postData: { contents: JSON.stringify({ events: [{ type: 'message', webhookEventId: 'e6', replyToken: 'rt', source: { type: 'user', userId: 'U2' }, message: { type: 'text', text: '結果' } }] }) }, parameter: { token: 'sec' } });
assert(/目前沒有查詢中的料號/.test(replies()[0]), 'result without prior query');

calls.length = 0;
ctx.doPost(ev('TPN2R203NC', 'e7'));
assert(!calls.some(c => c.url.includes('generativelanguage')) && /清單內/.test(replies()[0]), 'own part: direct reply, no Gemini');
calls.length = 0;
ctx.doPost(ev('你好', 'e8'));
assert(/請輸入料號/.test(replies()[0]), 'non-part text gets hint');
process.exit(fail ? 1 : 0);
