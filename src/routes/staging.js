import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { listWorkspace, taskMeta, taskDir } from '../workspace.js';
import { laneOf, moveTaskToLane } from '../lanes.js';
import { recordAction } from '../actions.js';
import { runRegistryQuery } from '../redash_registry.js';
import { redashEnabled } from '../redash.js';
import { ptrGet, ptrSet, validateTask, writeJsonAtomic } from '../fixes.js';

// /api/staging/* and /api/backfill — the Staging lane's working surface
// (HANDOFF_STAGING_FIXES_BACKFILL.md §6-§8, flow per Pavit 2026-08-10):
// fixes are decided in Staging, the backfill export pulls FROM Staging, the
// check runs there, and all-confirmed tasks move to Resolved with the id list
// copied out for the platform-side L12 move.
export const stagingApi = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const HEX24 = /^[0-9a-f]{24}$/;

function readStudio(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '_studio.json'), 'utf8')); } catch { return {}; }
}

// task_sbq's OPEN flag — a send-back the task has not re-entered L10/L12
// since. Lifetime sbq_attempts alone flagged 13 already-fixed authoring-stage
// send-backs as "must be pulled" on the first live quadrant report.
const sbqOpen = (r) => r?.sbq_open === true || r?.sbq_open === 'true' || r?.sbq_open === 1;

// A task is IN L12 only while its latest node is a live one. A canceled L12
// node means the opposite of membership: the task was pulled (this whole
// batch's L12 nodes were mass-canceled upstream on 2026-08-05).
const inL12Active = (l) => !!l && String(l.review_level) === '12' && l.status !== 'canceled';

// How long after a backfill Redash may legitimately not reflect it yet.
// 30 minutes, per Pavit (§10.1) — inside the window a gap is PENDING, not
// MISMATCH.
export const PROPAGATION_WINDOW_MS = 30 * 60 * 1000;

function stagingTasks() {
  const ws = listWorkspace();
  const out = [];
  for (const [bucket, list] of Object.entries(ws)) {
    for (const t of list) {
      if (t.tour) continue;
      const meta = taskMeta(bucket, t.id);
      if (laneOf(meta) === 'STAGING') out.push(meta);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The check behind the lane's button
// ---------------------------------------------------------------------------

// Readiness + upstream reconciliation for every task in Staging. "Ready" is a
// conjunction the popup can explain per task: no pending fixes, no validation
// warnings, and Redash does not show the task sent back. Redash being
// unreachable degrades to board-only checks, loudly.
stagingApi.get('/verify', wrap(async (req, res) => {
  const tasks = stagingTasks();
  if (!tasks.length) return res.json({ items: [], redash: redashEnabled(), generatedAt: new Date().toISOString() });

  let sbq = new Map();
  let level = new Map();
  let labels = new Map();
  let redashError = null;
  if (redashEnabled()) {
    try {
      const ids = tasks.map((t) => t.id).filter((id) => HEX24.test(id));
      const [sbqRes, lvlRes, labelRes] = await Promise.all([
        runRegistryQuery('task_sbq', { task_ids: ids }, { fresh: req.query.fresh === '1' }),
        runRegistryQuery('task_current_level', { task_ids: ids }, { fresh: req.query.fresh === '1' }),
        runRegistryQuery('task_labels', { task_ids: ids }, { fresh: req.query.fresh === '1' }),
      ]);
      sbq = new Map(sbqRes.rows.map((r) => [r.task_id, r]));
      level = new Map(lvlRes.rows.map((r) => [r.task_id, r]));
      labels = new Map(labelRes.rows.map((r) => [r.task_id, r]));
    } catch (e) {
      redashError = e.message;
    }
  }

  const items = tasks.map((m) => {
    const dir = taskDir(m.bucket, m.id);
    const s = sbq.get(m.id);
    const l = level.get(m.id);
    const upstreamSbq = sbqOpen(s); // OPEN send-backs only — historical ones were fixed upstream
    // Recomputed live, not read from the ingest-time snapshot — fixes decided
    // since ingest change what validateTask finds, and a frozen warning would
    // block a task from ever becoming ready.
    const auditRow = m.audit?.verdict !== undefined ? m.audit : null;
    const warningDetails = validateTask(dir, auditRow);
    const warnings = warningDetails.length;
    const blockers = [];
    if (m.pendingFixes > 0) blockers.push(`${m.pendingFixes} fix${m.pendingFixes === 1 ? '' : 'es'} pending`);
    if (warnings) blockers.push(`${warnings} validation warning${warnings === 1 ? '' : 's'}`);
    if (upstreamSbq) blockers.push('SBQ upstream — pull, do not backfill');
    return {
      id: m.id,
      bucket: m.bucket,
      severity: m.bucket,
      tags: m.audit?.tags || [],
      grammarOnly: !!m.audit?.grammar_only_fail || m.grammarOnly,
      pendingFixes: m.pendingFixes,
      warnings,
      warningDetails,
      sbqAttempts: Number(s?.sbq_attempts || 0),
      upstream: l ? { level: String(l.review_level), status: l.status } : null,
      sbq: upstreamSbq,
      lastSbqAt: s?.last_sbq_at || null,
      hasSourceRow: fs.existsSync(path.join(dir, '_source_row.json')),
      // Did the board's label land on platform? Covers the two 1:1-mappable
      // fields (preference rating, winning side); prose fields have no platform
      // field map yet — the eval-side reconciler owns that (§7.5). Informational,
      // not a gate: a grammar-only task matches trivially, a re-ranked one shows
      // ✗ until the backfill lands.
      labelMatch: withPropagationWindow(labelMatch(dir, labels.get(m.id)), readStudio(dir)),
      ready: blockers.length === 0,
      blockers,
    };
  });

  res.json({
    items,
    confirmed: items.filter((i) => i.ready).map((i) => i.id),
    redash: redashEnabled() && !redashError,
    redashError,
    propagationWindowMs: PROPAGATION_WINDOW_MS,
    generatedAt: new Date().toISOString(),
  });
}));

// "Move all confirmed": the popup's button. Resolves each task — grammar-only
// as GRAMMAR_ONLY, everything else as FIXES_MADE — through the same
// moveTaskToLane + recordAction path every other lane change takes, so each
// move shows in Recent actions and is undoable.
stagingApi.post('/resolve', wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids required' });

  const inStaging = new Map(stagingTasks().map((m) => [m.id, m]));
  const moved = [];
  const skipped = [];
  for (const id of ids) {
    const m = inStaging.get(id);
    if (!m) { skipped.push({ id, reason: 'not in Staging' }); continue; }
    if (m.pendingFixes > 0) { skipped.push({ id, reason: 'pending fixes' }); continue; }
    const verdict = 'FIXES_MADE'; // RLI has no grammar-only resolution
    const item = moveTaskToLane(m.bucket, id, 'RESOLVED', { verdict, username: req.user.username });
    if (item) {
      // The backfill stamp lives beside the verdict so the export manifest and
      // the eval-side reconciler can see when the move happened.
      const p = path.join(taskDir(m.bucket, id), '_studio.json');
      try {
        const state = JSON.parse(fs.readFileSync(p, 'utf8'));
        state.backfilled_at = new Date().toISOString();
        state.backfilled_by = req.user.username;
        writeJsonAtomic(p, state);
      } catch { /* stamp is advisory */ }
      moved.push(item);
    } else skipped.push({ id, reason: 'no change' });
  }
  if (moved.length) {
    recordAction({
      by: req.user.username,
      kind: 'bulk_move',
      label: `Staging backfill: ${moved.length} confirmed → Resolved`,
      items: moved,
    });
  }
  res.json({ moved: moved.map((m) => m.id), skipped });
}));

// A MISMATCH right after a backfill is usually propagation lag, not a failure —
// inside the window it reports PENDING so the popup doesn't cry wolf (§7.3).
// The stamps come from _studio.json: backfill_retrieved_at (export pulled) and
// backfilled_at (moved to Resolved).
function withPropagationWindow(match, studio) {
  if (match?.status !== 'MISMATCH') return match;
  const stamp = Date.parse(studio.backfill_retrieved_at || studio.backfilled_at || '');
  if (!Number.isFinite(stamp)) return match;
  const until = stamp + PROPAGATION_WINDOW_MS;
  if (Date.now() >= until) return match;
  return { ...match, status: 'PENDING', pending_until: new Date(until).toISOString() };
}

// Normalize-then-compare for the two mappable label fields (§8: normalize both
// sides; a naive === cries wolf on formatting).
// Both sides can carry the wire-shaped string ("+2: moderately prefer model b")
// or a bare number — Number() on the string form is NaN, which used to drop
// the field from comparison entirely and report MATCH on winner alone.
const parsePref = (v) => (typeof v === 'number' ? v : parseInt(String(v ?? '').trim(), 10));

function labelMatch(dir, platform) {
  if (!platform) return { status: 'NOT_FOUND' };
  let live;
  try { live = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json'), 'utf8')); } catch { return { status: 'NO_RANK' }; }

  const fields = [];
  // preference: "+2: moderately prefer model b" -> +2, matched numerically.
  const platPref = parsePref(platform.preference_rating);
  const boardPref = parsePref(live.preference_rating);
  if (!Number.isNaN(platPref) && !Number.isNaN(boardPref)) {
    fields.push({ field: 'preference_rating', match: platPref === boardPref, board: boardPref, platform: platPref });
  }
  // winner: platform says "model a"/"model b"; the board's rank-1 result key
  // maps to a side directly (model_1/model_2) or via model_assignments.
  const winKey = Object.entries(live.results || {}).find(([, r]) => Number(r.rank) === 1)?.[0];
  if (winKey) {
    let side = null;
    if (/^model_[12]$/i.test(winKey)) side = winKey.endsWith('1') ? 'model a' : 'model b';
    else {
      const assign = live.model_assignments || {};
      const entry = Object.entries(assign).find(([, code]) => code === winKey);
      if (entry) side = entry[0] === 'model_a' ? 'model a' : 'model b';
    }
    const plat = String(platform.model_ranking || '').trim().toLowerCase();
    if (side && plat) fields.push({ field: 'winner', match: plat === side, board: side, platform: plat });
  }
  if (!fields.length) return { status: 'UNMAPPED' };
  return { status: fields.every((f) => f.match) ? 'MATCH' : 'MISMATCH', fields };
}

// Upstream layer for EVERY task on the board — the per-card tag (§7.1). One
// batched query, served from the registry's cache (5-minute TTL); fresh=1 is
// the manual refresh. Tasks carrying a backfill stamp also get a backfill
// entry — when they were stamped plus the platform label match, from one extra
// task_labels query over just the stamped ids.
stagingApi.get('/layers', wrap(async (req, res) => {
  const ws = listWorkspace();
  const all = Object.values(ws).flat().filter((t) => !t.tour);
  // Stray non-task directories would fail the registry's id validation and
  // take the whole batched query down with them — skip, don't 500 the board.
  const ids = all.map((t) => t.id).filter((id) => HEX24.test(id));

  // Backfill stamps are board-local facts, collected before any Redash call so
  // the tag survives the warehouse being down: match degrades to null
  // (backfilled, match unknown), never a false mismatch.
  const backfill = {};
  const stamped = [];
  for (const t of all) {
    const dir = taskDir(t.bucket, t.id);
    const studio = readStudio(dir);
    if (!studio.backfilled_at && !studio.backfill_retrieved_at) continue;
    backfill[t.id] = {
      backfilledAt: studio.backfilled_at || null,
      retrievedAt: studio.backfill_retrieved_at || null,
      match: null,
    };
    if (HEX24.test(t.id)) stamped.push({ id: t.id, dir, studio });
  }

  if (!ids.length || !redashEnabled()) return res.json({ layers: {}, backfill, enabled: redashEnabled() });

  if (stamped.length) {
    try {
      const out = await runRegistryQuery('task_labels', { task_ids: stamped.map((t) => t.id) }, { fresh: req.query.fresh === '1' });
      const rows = new Map(out.rows.map((r) => [r.task_id, r]));
      for (const t of stamped) backfill[t.id].match = withPropagationWindow(labelMatch(t.dir, rows.get(t.id)), t.studio);
    } catch { /* match stays null */ }
  }

  try {
    const out = await runRegistryQuery('task_current_level', { task_ids: ids }, { fresh: req.query.fresh === '1' });
    res.json({
      layers: Object.fromEntries(out.rows.map((r) => [r.task_id, { level: String(r.review_level), status: r.status }])),
      backfill,
      cached: out.cached,
      retrievedAt: out.retrievedAt,
      enabled: true,
    });
  } catch (e) {
    res.json({ layers: {}, backfill, enabled: true, error: e.message });
  }
}));

// §7.2 quadrant reconciliation over the Resolved lane: SBQ status × L12
// membership, three outcomes not two (§7.3). Also the read surface for the
// eval-side reconciler (§7.5), which runs with a reviewer session — so this
// stays behind requireAuth only, no admin gate.
stagingApi.get('/quadrants', wrap(async (req, res) => {
  const ws = listWorkspace();
  const tasks = Object.values(ws).flat().filter((t) => !t.tour && laneOf(t) === 'RESOLVED');
  const generatedAt = new Date().toISOString();
  if (!redashEnabled()) return res.json({ redash: false, error: 'redash not configured', generatedAt });

  let sbq, level;
  try {
    const ids = tasks.map((t) => t.id).filter((id) => HEX24.test(id));
    const fresh = req.query.fresh === '1';
    const [sbqRes, lvlRes] = ids.length
      ? await Promise.all([
        runRegistryQuery('task_sbq', { task_ids: ids }, { fresh }),
        runRegistryQuery('task_current_level', { task_ids: ids }, { fresh }),
      ])
      : [{ rows: [] }, { rows: [] }];
    sbq = new Map(sbqRes.rows.map((r) => [r.task_id, r]));
    level = new Map(lvlRes.rows.map((r) => [r.task_id, r]));
  } catch (e) {
    return res.json({ redash: false, error: e.message, generatedAt });
  }

  const counts = { ok_in_l12: 0, ok_out: 0, must_pull: 0, backfill_missing: 0, pending: 0 };
  const items = tasks.map((m) => {
    const studio = readStudio(taskDir(m.bucket, m.id));
    const l = level.get(m.id);
    const s = sbq.get(m.id);
    // Membership means a LIVE L12 node; SBQ means an OPEN send-back. Testing
    // level alone and lifetime counts alone produced 13 phantom must-pulls on
    // tasks whose L0 send-backs were fixed weeks before delivery and whose
    // L12 nodes had been mass-canceled.
    const inL12 = inL12Active(l);
    const upstreamSbq = sbqOpen(s);
    // §7.4: Redash wins on SBQ but a board SBQ verdict is never silently
    // overridden — either source keeps the task out of the backfill quadrants,
    // and the board-only case is surfaced as awaiting confirmation.
    const boardSbq = m.verdict === 'SBQ';
    const isSbq = upstreamSbq || boardSbq;
    let quadrant = isSbq ? (inL12 ? 'must_pull' : 'ok_out') : (inL12 ? 'ok_in_l12' : 'backfill_missing');
    if (quadrant === 'backfill_missing') {
      // §7.3 third outcome: a backfill inside the propagation window
      // legitimately isn't in L12 yet — too early to judge, not missing.
      const stamp = Date.parse(studio.backfill_retrieved_at || studio.backfilled_at || '');
      if (Number.isFinite(stamp) && Date.now() < stamp + PROPAGATION_WINDOW_MS) quadrant = 'pending';
    }
    counts[quadrant] += 1;
    return {
      id: m.id,
      severity: m.bucket,
      verdict: m.verdict || null,
      quadrant,
      upstream: l ? { level: String(l.review_level), status: l.status } : null,
      note: !inL12 && l && String(l.review_level) === '12' && l.status === 'canceled'
        ? `pulled from L12 — node canceled ${String(l.updated_at || '').slice(0, 10)}`
        : null,
      sbq: isSbq,
      sbqAttempts: Number(s?.sbq_attempts || 0),
      sbqAwaitingConfirmation: boardSbq && !upstreamSbq,
      backfilledAt: studio.backfilled_at || studio.backfill_retrieved_at || null,
      delivered: m.delivered,
    };
  });

  res.json({ counts, items, redash: true, propagationWindowMs: PROPAGATION_WINDOW_MS, generatedAt });
}));

// ---------------------------------------------------------------------------
// Backfill export (§6)
// ---------------------------------------------------------------------------

// The only fields the board may overwrite in the wire row. Everything else is
// byte-preserved from _source_row.json — asserted, not assumed.
const WHITELIST_TOP = ['ranking_rationale', 'preference_rating', 'optional_clarification_comments', 'optional_other_comments'];
const WHITELIST_RESULT = ['rank', 'summary'];

function buildRow(dir, live) {
  const source = JSON.parse(fs.readFileSync(path.join(dir, '_source_row.json'), 'utf8'));
  const wire = source['rank.json'] || source.rank_json;
  if (!wire) throw new Error('_source_row.json has no rank.json payload');
  const out = JSON.parse(JSON.stringify(source));
  const rank = out['rank.json'] || out.rank_json;

  for (const f of WHITELIST_TOP) {
    if (live[f] !== undefined) rank[f] = live[f];
  }
  // results keys vary by batch (model_1/model_2 vs codenames) — iterate what
  // the SOURCE row has; never hardcode (§6.2).
  for (const key of Object.keys(rank.results || {})) {
    const liveR = live.results?.[key];
    if (!liveR) continue;
    for (const f of WHITELIST_RESULT) {
      if (liveR[f] !== undefined) rank.results[key][f] = liveR[f];
    }
    for (const dim of Object.keys(rank.results[key].grading || {})) {
      const liveDim = liveR.grading?.[dim];
      if (!liveDim) continue;
      if (liveDim.score !== undefined) rank.results[key].grading[dim].score = liveDim.score;
      if (liveDim.rationale !== undefined) rank.results[key].grading[dim].rationale = liveDim.rationale;
    }
    for (const mode of Object.keys(rank.results[key].failure_modes || {})) {
      if (liveR.failure_modes?.[mode] !== undefined) rank.results[key].failure_modes[mode] = liveR.failure_modes[mode];
    }
  }
  return { out, source };
}

// Whitelist assertion: outside the allowed pointers, the emitted row must be
// byte-identical to the source row (§6.3). Cheap, and it catches a pointer bug
// before platform does.
function assertOutsideUntouched(emitted, source) {
  const strip = (row) => {
    const r = JSON.parse(JSON.stringify(row));
    const rank = r['rank.json'] || r.rank_json;
    for (const f of WHITELIST_TOP) delete rank[f];
    for (const key of Object.keys(rank.results || {})) {
      for (const f of WHITELIST_RESULT) delete rank.results[key][f];
      delete rank.results[key].grading;
      delete rank.results[key].failure_modes;
    }
    return JSON.stringify(r);
  };
  return strip(emitted) === strip(source);
}

stagingApi.get('/backfill', wrap(async (req, res) => {
  const tasks = stagingTasks();

  // Upstream SBQ exclusion (§6.1) has to come from Redash — a board SBQ
  // verdict puts the task in RESOLVED, so it can never even reach this loop.
  // Redash being down degrades to exporting with a loud manifest note rather
  // than blocking the whole retrieval.
  const sbqIds = new Set();
  let sbqCheck = 'skipped';
  if (redashEnabled() && tasks.length) {
    try {
      const ids = tasks.map((t) => t.id).filter((id) => HEX24.test(id));
      const out = await runRegistryQuery('task_sbq', { task_ids: ids }, { fresh: req.query.fresh === '1' });
      for (const r of out.rows) if (sbqOpen(r)) sbqIds.add(r.task_id);
      sbqCheck = 'ok';
    } catch (e) {
      sbqCheck = `unavailable: ${e.message}`;
    }
  }

  const rows = [];
  const excluded = [];
  for (const m of tasks) {
    const dir = taskDir(m.bucket, m.id);
    if (sbqIds.has(m.id)) { excluded.push({ id: m.id, reason: 'sbq_upstream' }); continue; }
    if (m.pendingFixes > 0) { excluded.push({ id: m.id, reason: 'pending_fixes' }); continue; }
    if (!fs.existsSync(path.join(dir, '_source_row.json'))) { excluded.push({ id: m.id, reason: 'no_source_row' }); continue; }
    try {
      const live = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json'), 'utf8'));
      const { out, source } = buildRow(dir, live);
      if (!assertOutsideUntouched(out, source)) {
        excluded.push({ id: m.id, reason: 'whitelist_assertion_failed' });
        continue;
      }
      rows.push(out);
      // Start the propagation clock: label mismatches inside the window read
      // as PENDING, not failures.
      try {
        const state = readStudio(dir);
        state.backfill_retrieved_at = new Date().toISOString();
        state.backfill_retrieved_by = req.user.username;
        writeJsonAtomic(path.join(dir, '_studio.json'), state);
      } catch { /* stamp is advisory */ }
    } catch (e) {
      excluded.push({ id: m.id, reason: `build_failed: ${e.message}` });
    }
  }
  res.json({
    manifest: {
      generated_at: new Date().toISOString(),
      generated_by: req.user.username,
      lane: 'STAGING',
      tasks: rows.length,
      sbq_check: sbqCheck,
      excluded,
    },
    rows,
  });
}));

// Read endpoint for the eval-side reconciler (§7.5): where every task sits on
// the board, so the quadrant check runs off facts instead of re-deriving them.
stagingApi.get('/status', wrap(async (req, res) => {
  const ws = listWorkspace();
  const items = [];
  for (const [bucket, list] of Object.entries(ws)) {
    for (const t of list) {
      if (t.tour) continue;
      const m = taskMeta(bucket, t.id);
      const studio = readStudio(taskDir(bucket, t.id));
      items.push({
        id: m.id,
        severity: bucket,
        lane: laneOf(m),
        verdict: m.verdict || null,
        pendingFixes: m.pendingFixes,
        tags: m.audit?.tags || [],
        backfilledAt: studio.backfilled_at || null,
        backfillRetrievedAt: studio.backfill_retrieved_at || null,
        delivered: m.delivered,
      });
    }
  }
  res.json({ items, generatedAt: new Date().toISOString() });
}));
