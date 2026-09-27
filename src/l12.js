import fs from 'node:fs';
import path from 'node:path';
import { config, BUCKETS } from './config.js';

// L12 analytics for RLI: aggregate every task's record (task.json — rubric
// scores, models, three-way preference) + _studio.json (reviewer decision) into
// one payload for the dashboard. Cheap enough (a few hundred JSON files) to
// compute per request — no caching needed.

const TASK_ID_RE = /^[0-9a-f]{24}$/;
const RESOLVED_VERDICTS = new Set(['NO_ISSUES', 'FIXES_MADE', 'SBQ']);
const SIDES = ['golden', 'ad1', 'ad2'];
const GATE = { golden: 97, ad1: 70, ad2: 50 };
const passesGate = (side, v) => (side === 'golden' ? v >= GATE.golden : v <= GATE[side]);
const PAIRS = [
  { pair: 'rd_vs_ad1', left: 'RD', right: 'AD1', l: 'golden', r: 'ad1' },
  { pair: 'rd_vs_ad2', left: 'RD', right: 'AD2', l: 'golden', r: 'ad2' },
  { pair: 'ad1_vs_ad2', left: 'AD1', right: 'AD2', l: 'ad1', r: 'ad2' },
];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

function collect(scope) {
  const rows = [];
  for (const bucket of BUCKETS) {
    const bdir = path.join(config.workspaceRoot, bucket);
    let names = [];
    try { names = fs.readdirSync(bdir); } catch { continue; }
    for (const id of names) {
      if (!TASK_ID_RE.test(id)) continue;
      const dir = path.join(bdir, id);
      const rec = readJson(path.join(dir, 'task.json'));
      if (!rec) continue;
      const studio = readJson(path.join(dir, '_studio.json')) || {};
      if (studio.tour) continue;
      const delivered = !!studio.delivered;
      const verdict = studio.verdict || null;
      if (scope === 'active' && delivered) continue;
      if (scope === 'completed' && (delivered || !(verdict && RESOLVED_VERDICTS.has(verdict)))) continue;
      rows.push({ id, bucket, delivered, verdict, rec });
    }
  }
  return rows;
}

export function computeL12(scope = 'active') {
  const rows = collect(scope);
  const severity = { PASS: 0, SOFT_FAIL: 0, HARD_FAIL: 0, UNSORTED: 0 };
  const verdicts = { NO_ISSUES: 0, FIXES_MADE: 0, SBQ: 0, SECOND_OPINION: 0, none: 0 };
  const scores = { golden: [], ad1: [], ad2: [] };
  const gates = { golden: 0, ad1: 0, ad2: 0, all: 0, scored: 0 };
  const models = new Map();   // name -> { tasks, slots, scores, gatePass, vsRd: [], h2h }
  const pairAgg = new Map(PAIRS.map((p) => [p.pair, { ...p, n: 0, dims: new Map(), agree: 0, decided: 0 }]));
  const domains = new Map();  // domain -> { tasks, scores{}, hard, soft }

  const modelRec = (name) => {
    if (!models.has(name)) models.set(name, { name, tasks: 0, slots: { ad1: 0, ad2: 0 }, scores: [], gatePass: 0, gated: 0, vsRd: [], h2h: { wins: 0, losses: 0, ties: 0 } });
    return models.get(name);
  };

  for (const r of rows) {
    severity[r.bucket] = (severity[r.bucket] || 0) + 1;
    verdicts[r.verdict || 'none'] = (verdicts[r.verdict || 'none'] || 0) + 1;
    const rec = r.rec;
    const pctOf = (s) => (typeof rec.rubric_eval?.scores?.[s]?.percentage === 'number' ? rec.rubric_eval.scores[s].percentage : null);
    const sc = Object.fromEntries(SIDES.map((s) => [s, pctOf(s)]));
    const model = { ad1: rec.ad1_model || rec.ad1_artifacts?.model || null, ad2: rec.ad2_model || rec.ad2_artifacts?.model || null };

    if (SIDES.every((s) => sc[s] != null)) {
      gates.scored += 1;
      let all = true;
      for (const s of SIDES) { scores[s].push(sc[s]); if (passesGate(s, sc[s])) gates[s] += 1; else all = false; }
      if (all) gates.all += 1;
    }

    for (const slot of ['ad1', 'ad2']) {
      if (!model[slot]) continue;
      const m = modelRec(model[slot]);
      m.tasks += 1; m.slots[slot] += 1;
      if (sc[slot] != null) { m.scores.push(sc[slot]); m.gated += 1; if (passesGate(slot, sc[slot])) m.gatePass += 1; }
    }

    const d = rec.domain || 'Unknown';
    const dom = domains.get(d) || { domain: d, tasks: 0, scores: { golden: [], ad1: [], ad2: [] }, hard: 0, soft: 0 };
    dom.tasks += 1;
    for (const s of SIDES) if (sc[s] != null) dom.scores[s].push(sc[s]);
    if (r.bucket === 'HARD_FAIL') dom.hard += 1;
    if (r.bucket === 'SOFT_FAIL') dom.soft += 1;
    domains.set(d, dom);

    // Pairwise preference: 1 = left better … 4 comparable … 7 = right better.
    for (const c of rec.pref_ranking?.comparisons || []) {
      const agg = pairAgg.get(c.pair);
      if (!agg) continue;
      const vals = (c.dimensions || []).map((x) => Number(x.score)).filter((x) => x >= 1 && x <= 7);
      if (!vals.length) continue;
      agg.n += 1;
      for (const x of c.dimensions || []) {
        const v = Number(x.score);
        if (!(v >= 1 && v <= 7)) continue;
        const dm = agg.dims.get(x.id) || { id: x.id, title: x.title || x.id, vals: [] };
        dm.vals.push(v);
        agg.dims.set(x.id, dm);
      }
      const avg = mean(vals);
      const prefers = avg < 3.5 ? 'left' : avg > 4.5 ? 'right' : null;
      const L = sc[agg.l], R = sc[agg.r];
      if (prefers && L != null && R != null && Math.abs(L - R) > 2) {
        agg.decided += 1;
        if ((L > R ? 'left' : 'right') === prefers) agg.agree += 1;
      }
      // Per model: how it fares against the golden, and head to head.
      if (agg.l === 'golden' && model[agg.r]) modelRec(model[agg.r]).vsRd.push(avg);
      if (c.pair === 'ad1_vs_ad2' && model.ad1 && model.ad2) {
        const a = modelRec(model.ad1).h2h, b = modelRec(model.ad2).h2h;
        if (prefers === 'left') { a.wins += 1; b.losses += 1; } else if (prefers === 'right') { b.wins += 1; a.losses += 1; } else { a.ties += 1; b.ties += 1; }
      }
    }
  }

  const leaderboard = [...models.values()].map((m) => ({
    name: m.name,
    tasks: m.tasks,
    slots: m.slots,
    avgScore: r2(mean(m.scores)),
    gatePassRate: m.gated ? m.gatePass / m.gated : null,
    // Mean RD-vs-model rating, 1 = RD much better … 4 = comparable.
    vsRd: r2(mean(m.vsRd)),
    h2h: m.h2h,
  })).sort((a, b) => (a.avgScore ?? 999) - (b.avgScore ?? 999));

  const prefs = [...pairAgg.values()].map((p) => ({
    pair: p.pair, left: p.left, right: p.right, n: p.n,
    dims: [...p.dims.values()].map((d) => ({
      id: d.id, title: d.title, mean: r2(mean(d.vals)),
      left: d.vals.filter((v) => v < 4).length, tie: d.vals.filter((v) => v === 4).length, right: d.vals.filter((v) => v > 4).length,
    })),
    agree: p.agree, decided: p.decided,
  }));

  return {
    scope,
    total: rows.length,
    severity,
    verdicts,
    avg: Object.fromEntries(SIDES.map((s) => [s, r2(mean(scores[s]))])),
    gates,
    leaderboard,
    prefs,
    domains: [...domains.values()].map((d) => ({
      domain: d.domain, tasks: d.tasks, hard: d.hard, soft: d.soft,
      avg: Object.fromEntries(SIDES.map((s) => [s, r2(mean(d.scores[s]))])),
    })).sort((a, b) => b.tasks - a.tasks),
  };
}
