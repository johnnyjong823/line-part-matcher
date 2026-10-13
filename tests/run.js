// 用 Node 測試比對邏輯：node tests/run.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { module: undefined, console };
vm.createContext(ctx);
for (const f of ['Matcher.gs', 'Catalog.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', f), 'utf8'), ctx);
const values = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog_values.json'), 'utf8'));
const catalog = ctx.parseCatalogRows(values);
let fail = 0;
const assert = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fail++; };

assert(catalog.length > 700, 'catalog parsed: ' + catalog.length);
const tpn = catalog.find(c => c.part === 'TPN2R203NC');
assert(tpn && tpn.rds10 === 2.2 && tpn.rds45 === 3.6 && tpn.polarity === 'N' && tpn.w === 3.1, 'TPN2R203NC fields ' + JSON.stringify(tpn));
const ssm = catalog.find(c => c.part === 'SSM3K388R');
assert(ssm && ssm.rds10 === 82, 'SSM3K388R rds10 from description = ' + (ssm && ssm.rds10));
const pol = {};
catalog.forEach(c => pol[c.polarityRaw + ' -> ' + c.polarity] = 1);
console.log(Object.keys(pol));
assert(ctx.normPolarity('P-channel') === 'P' && ctx.normPolarity('N-ch x 2') === 'NN' && ctx.normPolarity('N-ch + P-ch') === 'NP', 'normPolarity');

// RH6E040BGTB1（ROHM, HSMT8）近似參數
const target = { part: 'RH6E040BGTB1', polarity: 'N', vdss: 30, id: 125, pd: 78, rds10: 2.9, rds45: 4.4, qg: 30, smd: true, pins: 8, w: 3.3, l: 3.3, h: 0.8 };
const res = ctx.findMatches(target, catalog, 5);
res.forEach((m, i) => console.log(i + 1, m.part, (m.score * 100).toFixed(1), m.item.pkg, m.item.rds10, m.item.id, JSON.stringify(m.sims)));
assert(res.slice(0, 3).some(m => m.part === 'TPN2R203NC'), 'TPN2R203NC in top 3');
process.exit(fail ? 1 : 0);
