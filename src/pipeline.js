import { listWorkspace } from './workspace.js';
import { runRegistryQuery } from './redash_registry.js';
import { config } from './config.js';

// Blends the two sources of truth this app has about a task:
//   * the BOARD  — what a reviewer decided locally (bucket, verdict, claim)
//   * REDASH     — where the task actually is in the upstream ACC pipeline
//
// The board alone can't see that a task it marked HARD_FAIL has already moved on
// to L12, and Redash alone doesn't know a human called it a hard fail. Every
// panel worth having is a join of the two.

// Review levels sort numerically, not lexically — '10' must not land before '4'.
const lvlNum = (l) => {
  const n = Number(l);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
};

export const LEVEL_LABEL = {
  '-1': 'L-1 · Tasking',
  0: 'L0 · Review',
  1: 'L1 · Review',
  4: 'L4 · Review',
  8: 'L8 · Review',
  10: 'L10 · QM',
  12: 'L12 · Final',
};
export const levelLabel = (l) => LEVEL_LABEL[String(l)] ?? `L${l}`;

// A worker team path like "Outlier/Free Agent/Banned/Cheating" is audit-relevant
// context, so it is surfaced rather than buried in a tooltip.
const SUSPECT_TEAM_RE = /banned|cheat|fraud/i;

// ---------------------------------------------------------------------------
// One task: full pipeline history + time per level
// ---------------------------------------------------------------------------

export async function taskPipeline(taskId, opts = {}) {
  const [history, aht, billed] = await Promise.all([
    runRegistryQuery('task_pipeline', { task_ids: [taskId] }, opts),
    runRegistryQuery('task_aht', { task_ids: [taskId] }, opts),
    runRegistryQuery('task_billable', { task_ids: [taskId] }, opts),
  ]);

  const nodes = history.rows.map((r) => ({
    reviewLevel: r.review_level,
    status: r.status,
    nodeName: r.node_name,
    workerId: r.worker_id,
    workerName: r.worker_name,
    workerTeam: r.worker_team,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    attemptId: r.attempt_id,
    isCurrent: r.is_current === true || r.is_current === 'true',
    suspectTeam: !!r.worker_team && SUSPECT_TEAM_RE.test(r.worker_team),
  }));

  // Two clocks merged per level: BILLABLE from GEN_AI_ISR (the billing source
  // of truth) and tracked/active from TASKATTEMPTS. Some task generations have
  // no TASKATTEMPTS rows at all while their attempts are fully billed — the
  // tracked side then honestly reads 0 instead of zeroing out billing with it.
  const byLevel = new Map();
  const levelRow = (lvl) => {
    const key = String(lvl);
    if (!byLevel.has(key)) {
      byLevel.set(key, {
        reviewLevel: key, attempts: 0, billableHours: 0, uselessAttempts: 0,
        hours: 0, activeHours: 0, trackedAttempts: 0, lastAttemptAt: null,
      });
    }
    return byLevel.get(key);
  };
  for (const r of billed.rows) {
    const t = levelRow(r.review_level);
    t.attempts += Number(r.attempts) || 0;
    t.billableHours = +(t.billableHours + (Number(r.billable_hours) || 0)).toFixed(2);
    t.uselessAttempts += Number(r.useless_attempts) || 0;
    if (!t.lastAttemptAt || String(r.last_work_day) > String(t.lastAttemptAt)) t.lastAttemptAt = r.last_work_day;
  }
  for (const r of aht.rows) {
    const t = levelRow(r.review_level);
    t.trackedAttempts += Number(r.attempts) || 0;
    t.hours = +(t.hours + (Number(r.hours) || 0)).toFixed(2);
    t.activeHours = +(t.activeHours + (Number(r.active_hours) || 0)).toFixed(2);
    t.attempts = Math.max(t.attempts, t.trackedAttempts);
    if (!t.lastAttemptAt || String(r.last_attempt_at) > String(t.lastAttemptAt)) t.lastAttemptAt = r.last_attempt_at;
  }
  const time = [...byLevel.values()].sort((a, b) => lvlNum(a.reviewLevel) - lvlNum(b.reviewLevel));

  const totals = time.reduce(
    (acc, t) => ({
      attempts: acc.attempts + t.attempts,
      billableHours: +(acc.billableHours + t.billableHours).toFixed(2),
      hours: +(acc.hours + t.hours).toFixed(2),
      activeHours: +(acc.activeHours + t.activeHours).toFixed(2),
    }),
    { attempts: 0, billableHours: 0, hours: 0, activeHours: 0 },
  );

  // Distinct people who touched the task, newest contribution first.
  const workers = [];
  const seen = new Set();
  for (const n of [...nodes].reverse()) {
    if (!n.workerId || seen.has(n.workerId)) continue;
    seen.add(n.workerId);
    workers.push({
      id: n.workerId,
      name: n.workerName,
      team: n.workerTeam,
      reviewLevel: n.reviewLevel,
      suspectTeam: n.suspectTeam,
    });
  }

  return {
    taskId,
    current: nodes.find((n) => n.isCurrent) || null,
    history: nodes,
    time,
    totals,
    workers,
    cached: history.cached && aht.cached,
    retrievedAt: history.retrievedAt,
  };
}

// ---------------------------------------------------------------------------
// Whole board: every task's upstream position, grouped by local verdict
// ---------------------------------------------------------------------------

export async function boardPipeline(opts = {}) {
  const scope = opts.scope === 'all' ? 'all' : 'active';
  const ws = listWorkspace();
  const tasks = Object.values(ws)
    .flat()
    .filter((t) => !t.tour && (scope === 'all' || !t.delivered));

  if (!tasks.length) {
    return { scope, total: 0, matched: 0, unmatched: 0, buckets: {}, levels: [], rows: [] };
  }

  // Chunked so a board larger than the registry's per-call id cap still works —
  // one IN (…) list of every task id would otherwise be rejected outright.
  // Non-task folder names are dropped up front: one stray directory would make
  // the registry reject the whole chunk and 500 the panel.
  const TASK_ID_RE = /^[0-9a-f]{24}$/;
  const skipped = tasks.filter((t) => !TASK_ID_RE.test(t.id)).map((t) => t.id);
  if (skipped.length) console.warn(`boardPipeline: skipping ${skipped.length} non-task-id folder(s): ${skipped.join(', ')}`);
  const ids = tasks.map((t) => t.id).filter((id) => TASK_ID_RE.test(id));
  const CHUNK = 500;
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) => runRegistryQuery('task_current_level', { task_ids: chunk }, opts)),
  );
  const res = {
    rows: results.flatMap((r) => r.rows),
    cached: results.every((r) => r.cached),
    retrievedAt: results[0]?.retrievedAt ?? null,
  };
  const byId = new Map(res.rows.map((r) => [r.task_id, r]));

  const rows = tasks.map((t) => {
    const up = byId.get(t.id);
    return {
      id: t.id,
      bucket: t.bucket,
      verdict: t.verdict || null,
      claimedBy: t.claimedBy || null,
      delivered: !!t.delivered,
      reviewLevel: up ? up.review_level : null,
      status: up ? up.status : null,
      enteredAt: up ? up.entered_at : null,
    };
  });

  // bucket -> { total, levels: { '12': n }, statuses: { pending: n } }
  const buckets = {};
  const levelSet = new Set();
  for (const r of rows) {
    const b = (buckets[r.bucket] ||= { total: 0, matched: 0, levels: {}, statuses: {} });
    b.total += 1;
    if (r.reviewLevel == null) continue;
    b.matched += 1;
    levelSet.add(String(r.reviewLevel));
    b.levels[r.reviewLevel] = (b.levels[r.reviewLevel] || 0) + 1;
    b.statuses[r.status] = (b.statuses[r.status] || 0) + 1;
  }

  const matched = rows.filter((r) => r.reviewLevel != null).length;
  return {
    scope,
    total: rows.length,
    matched,
    // A task on the board but absent upstream is normal for older deliveries
    // (archived/purged nodes) — reported, not treated as an error.
    unmatched: rows.length - matched,
    buckets,
    levels: [...levelSet].sort((a, b) => lvlNum(a) - lvlNum(b)),
    rows,
    cached: res.cached,
    retrievedAt: res.retrievedAt,
  };
}

// ---------------------------------------------------------------------------
// Project-wide upstream stats (independent of what's on the board)
// ---------------------------------------------------------------------------

export async function pipelineOverview(opts = {}) {
  const days = opts.days ?? 30;
  const [dist, aht] = await Promise.all([
    runRegistryQuery('level_distribution', {}, opts),
    runRegistryQuery('project_aht', { days }, opts),
  ]);

  const levels = new Map();
  const bump = (lvl, key, n) => {
    const rec = levels.get(lvl) || { reviewLevel: lvl, label: levelLabel(lvl), pending: 0, other: 0, total: 0 };
    rec[key] += n;
    rec.total += n;
    levels.set(lvl, rec);
  };
  for (const r of dist.rows) {
    bump(String(r.review_level), r.status === 'pending' || r.status === 'paused' ? 'pending' : 'other', Number(r.tasks) || 0);
  }
  for (const r of aht.rows) {
    const lvl = String(r.review_level);
    const rec = levels.get(lvl) || { reviewLevel: lvl, label: levelLabel(lvl), pending: 0, other: 0, total: 0 };
    rec.hours = Number(r.total_hours) || 0;
    rec.avgHours = Number(r.avg_hours_per_attempt) || 0;
    rec.attempts = Number(r.attempts) || 0;
    rec.tasksTouched = Number(r.tasks) || 0;
    levels.set(lvl, rec);
  }

  const list = [...levels.values()].sort((a, b) => lvlNum(a.reviewLevel) - lvlNum(b.reviewLevel));
  return {
    projectId: config.redash.projectId,
    days,
    levels: list,
    // "In flight" = still pending somewhere upstream, i.e. real remaining work.
    pending: list.reduce((s, l) => s + l.pending, 0),
    totalHours: +list.reduce((s, l) => s + (l.hours || 0), 0).toFixed(1),
    cached: dist.cached && aht.cached,
    retrievedAt: dist.retrievedAt,
  };
}
