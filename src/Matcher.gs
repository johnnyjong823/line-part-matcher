/**
 * 料號參數比對（純運算，不呼叫任何 Google 服務，可在 Node 測試）
 *
 * target / candidate 統一格式（單位：V、A、W、mΩ、nC、pF、mm）：
 * {
 *   part, maker, polarity: 'N'|'P'|'NN'|'PP'|'NP'|...,
 *   vdss, vgss, id, pd, rds10, rds45, rds4, rds25, qg, ciss,
 *   pkg, pins, smd(true/false/null), w, l, h
 * }
 */

// 各參數權重（只計算雙方都有值的參數）
var MATCH_WEIGHTS = {
  vdss: 20,
  rds10: 22,
  rds45: 12,
  id: 14,
  pkg: 20,
  qg: 5,
  ciss: 4,
  pd: 3
};

/** 正規化極性字串 → 'N' / 'P' / 'NN' / 'PP' / 'NP' / 'N+Z' */
function normPolarity(s) {
  if (!s) return null;
  var t = String(s).toUpperCase().replace(/\s+/g, '');
  if (/ZENER|CLAMP/.test(t)) return 'N+Z';
  if (/COMPLEMENTARY/.test(t)) return 'NP';
  var hasN = /^N$|N-?CH/.test(t);
  var hasP = /^P$|P-?CH/.test(t);
  var dual = /X2|×2|DUAL|雙/.test(t);
  if (hasN && hasP) return 'NP';
  if (hasP) return dual ? 'PP' : 'P';
  if (hasN) return dual ? 'NN' : 'N';
  return null;
}

/** 數值比例相似度：a==b → 1，相差 maxRatio 倍以上 → 0（對數尺度） */
function ratioSim(a, b, maxRatio) {
  if (!(a > 0) || !(b > 0)) return null;
  var d = Math.abs(Math.log(a / b)) / Math.log(maxRatio);
  return Math.max(0, 1 - d);
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.\-eE]/g, ''));
  return isFinite(n) ? n : null;
}

/** 封裝相似度：優先比長寬（可旋轉），其次比 pin 數 */
function packageSim(t, c) {
  if (t.smd === true && c.smd === false) return 0;
  if (t.smd === false && c.smd === true) return 0;
  if (t.w > 0 && t.l > 0 && c.w > 0 && c.l > 0) {
    var d1 = Math.abs(t.w - c.w) + Math.abs(t.l - c.l);
    var d2 = Math.abs(t.w - c.l) + Math.abs(t.l - c.w);
    var d = Math.min(d1, d2);
    // 相差 0.5mm 內幾乎視為相同 footprint；相差 >= 平均邊長 60% 視為不同
    var tol = Math.max(1.5, 0.6 * (t.w + t.l) / 2);
    var s = Math.max(0, 1 - Math.max(0, d - 0.3) / tol);
    if (t.pins && c.pins && t.pins !== c.pins) s *= 0.7;
    return s;
  }
  if (t.pins && c.pins) return t.pins === c.pins ? 0.6 : 0.1;
  return null;
}

/** 單一候選料號評分，回傳 null 表示不符合硬性條件 */
function scoreCandidate(t, c) {
  if (t.polarity && c.polarity && t.polarity !== c.polarity) return null;
  // 耐壓不可低於原料號
  if (t.vdss && c.vdss && c.vdss < t.vdss * 0.98) return null;

  var sims = {};
  if (t.vdss && c.vdss) {
    // 同耐壓最好；較高耐壓可接受但扣分
    sims.vdss = c.vdss <= t.vdss * 1.02 ? 1 : Math.max(0, 1 - Math.log(c.vdss / t.vdss) / Math.log(3));
  }
  // RDS(on)：比原料號低（更好）時扣分較少
  ['rds10', 'rds45'].forEach(function (k) {
    if (t[k] && c[k]) sims[k] = ratioSim(t[k], c[k], c[k] < t[k] ? 4 : 2.5);
  });
  // 若某一顆只有 4.5V 或 4V 數據，退而求其次
  if (sims.rds45 === undefined && t.rds45 && c.rds4) sims.rds45 = ratioSim(t.rds45, c.rds4, 3) * 0.9;
  if (t.id && c.id) sims.id = ratioSim(t.id, c.id, c.id > t.id ? 4 : 2.5);
  if (t.qg && c.qg) sims.qg = ratioSim(t.qg, c.qg, 3);
  if (t.ciss && c.ciss) sims.ciss = ratioSim(t.ciss, c.ciss, 3);
  if (t.pd && c.pd) sims.pd = ratioSim(t.pd, c.pd, 4);
  var ps = packageSim(t, c);
  if (ps !== null) sims.pkg = ps;

  // 至少要有一個 RDS(on) 能比，不然沒有意義
  if (sims.rds10 === undefined && sims.rds45 === undefined) return null;

  var wSum = 0, sSum = 0, wAll = 0;
  Object.keys(MATCH_WEIGHTS).forEach(function (k) {
    wAll += MATCH_WEIGHTS[k];
    if (sims[k] !== undefined && sims[k] !== null) {
      wSum += MATCH_WEIGHTS[k];
      sSum += MATCH_WEIGHTS[k] * sims[k];
    }
  });
  var coverage = wSum / wAll;
  var score = (sSum / wSum) * (0.75 + 0.25 * coverage);
  return { part: c.part, score: score, sims: sims, item: c };
}

/** 回傳分數最高的前 topN 筆 */
function findMatches(target, catalog, topN) {
  var out = [];
  for (var i = 0; i < catalog.length; i++) {
    var c = catalog[i];
    if (target.part && c.part && c.part.toUpperCase() === String(target.part).toUpperCase()) continue;
    var r = scoreCandidate(target, c);
    if (r) out.push(r);
  }
  out.sort(function (a, b) { return b.score - a.score; });
  return out.slice(0, topN || 5);
}

// 讓 Node 測試可以 require（Apps Script 環境沒有 module，會略過）
if (typeof module !== 'undefined') {
  module.exports = { normPolarity: normPolarity, ratioSim: ratioSim, num: num, packageSim: packageSim, scoreCandidate: scoreCandidate, findMatches: findMatches };
}
