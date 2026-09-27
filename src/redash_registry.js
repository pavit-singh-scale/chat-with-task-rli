import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { runAdhoc, runSaved, RedashError } from './redash.js';

// The curated query registry — the "hybrid" half of the Redash integration.
//
// An entry is EITHER:
//   * { sql: 'file.sql', dataSourceId }  — SQL versioned in sql/redash/, run ad-hoc
//   * { savedQueryId }                   — SQL lives in Redash, editable without a deploy
//
// Callers name a query and pass params; they never see which mechanism ran it.
// To move an entry from one form to the other, swap the keys — nothing else changes.
//
// SAFETY: ad-hoc entries interpolate `{{param}}` placeholders into SQL text, so
// every parameter is validated against a declared type FIRST and rejected if it
// doesn't match exactly. The types below only ever emit 24-hex ids or bounded
// integers — there is no path from user input to arbitrary SQL text.

const SQL_DIR = path.join(config.projectRoot, 'sql', 'redash');
const TASK_ID_RE = /^[0-9a-f]{24}$/;

// ---------------------------------------------------------------------------
// Parameter types — each returns the literal SQL fragment to splice in, or throws.
// ---------------------------------------------------------------------------

const TYPES = {
  // A list of task ids -> 'aaa…','bbb…'   (quoted, comma-separated)
  taskIdList(value, { max = 500 } = {}) {
    const ids = (Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/))
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean);
    if (!ids.length) throw new RedashError('at least one task id is required', 400);
    if (ids.length > max) throw new RedashError(`too many task ids (${ids.length} > ${max})`, 400);
    const bad = ids.filter((id) => !TASK_ID_RE.test(id));
    if (bad.length) throw new RedashError(`not a 24-hex task id: ${bad.slice(0, 3).join(', ')}`, 400);
    // Sorted so equivalent id sets render identical SQL and hit the same cache key.
    return [...new Set(ids)].sort().map((id) => `'${id}'`).join(',');
  },

  // A single 24-hex object id, emitted bare (the SQL quotes it).
  objectId(value) {
    const id = String(value ?? '').trim().toLowerCase();
    if (!TASK_ID_RE.test(id)) throw new RedashError(`not a 24-hex id: ${String(value).slice(0, 40)}`, 400);
    return id;
  },

  // A bounded integer, emitted as a bare number. Defaults are already applied by
  // renderSql(), so `value` is always concrete here.
  int(value, { min = 0, max = 10_000 } = {}) {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new RedashError(`not an integer: ${String(value).slice(0, 40)}`, 400);
    if (n < min || n > max) throw new RedashError(`out of range (${min}–${max}): ${n}`, 400);
    return String(n);
  },
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const REGISTRY = {
  task_pipeline: {
    label: 'Task pipeline history',
    description: 'Every review level a task passed through, with worker and timings.',
    sql: 'task_pipeline.sql',
    params: { task_ids: { type: 'taskIdList', required: true } },
  },
  task_aht: {
    label: 'Task tracked time per level',
    description: 'Tracked and active hours per review level (TASKATTEMPTS clock — not billing), for specific tasks.',
    sql: 'task_aht.sql',
    params: { task_ids: { type: 'taskIdList', required: true } },
  },
  task_billable: {
    label: 'Task billable hours per level',
    description: 'Billable hours per review level from GEN_AI_ISR — the billing source of truth.',
    sql: 'task_billable.sql',
    params: { task_ids: { type: 'taskIdList', required: true } },
  },
  task_sbq: {
    label: 'SBQ status for tasks',
    description: 'Whether any completed review sent these tasks back, and when.',
    sql: 'task_sbq.sql',
    params: { task_ids: { type: 'taskIdList', required: true, max: 1000 } },
  },
  task_labels: {
    label: 'Platform label fields for tasks',
    description: 'The annotator label as platform holds it now — preference rating and winning side.',
    // ACC-era: reads A/B rank fields RLI records don't carry, so it returns nothing here.
    accOnly: true,
    sql: 'task_labels.sql',
    params: { task_ids: { type: 'taskIdList', required: true, max: 500 } },
  },
  task_current_level: {
    label: 'Current level for tasks',
    description: 'Where a given set of tasks sits in the pipeline right now.',
    sql: 'task_current_level.sql',
    params: { task_ids: { type: 'taskIdList', required: true, max: 1000 } },
  },
  level_distribution: {
    label: 'Pipeline level distribution',
    description: 'Task counts by current review level and status, project-wide.',
    sql: 'level_distribution.sql',
    params: { project_id: { type: 'objectId', default: () => config.redash.projectId } },
  },
  project_aht: {
    label: 'Cost per layer',
    description: 'Tasks, attempts and hours per review level over a trailing window.',
    sql: 'project_aht.sql',
    params: {
      project_id: { type: 'objectId', default: () => config.redash.projectId },
      days: { type: 'int', min: 1, max: 365, default: () => 30 },
    },
  },
  throughput: {
    label: 'Daily throughput',
    description: 'Distinct tasks attempted per day per review level.',
    sql: 'throughput.sql',
    params: {
      project_id: { type: 'objectId', default: () => config.redash.projectId },
      days: { type: 'int', min: 1, max: 180, default: () => 30 },
    },
  },

  // ---- the three the Overview page is built on ----

  deliveries: {
    label: 'Delivery batches',
    description: 'Bulk level-12 close-out sweeps — one row per delivery, in PT.',
    sql: 'deliveries.sql',
    params: {
      project_id: { type: 'objectId', default: () => config.redash.projectId },
      // Below this, a same-hour cluster is ordinary attrition rather than a
      // released batch. The smallest real delivery on record is 43.
      min_batch: { type: 'int', min: 2, max: 1000, default: () => 20 },
      limit: { type: 'int', min: 1, max: 200, default: () => 26 },
    },
  },
  queue_state: {
    label: 'Queue state and aging',
    description: 'Tasks pending per review level, with average, oldest and stale counts.',
    sql: 'queue_state.sql',
    params: {
      project_id: { type: 'objectId', default: () => config.redash.projectId },
      stale_days: { type: 'int', min: 1, max: 90, default: () => 7 },
    },
  },
  inflight_matchups: {
    label: 'In-flight tasks and matchups',
    description: 'Every task pending at any review level, with the A/B model pairing it compares.',
    // ACC-era: the pairing comes from agent_model in the ACC payload; RLI has none.
    accOnly: true,
    sql: 'inflight_matchups.sql',
    params: { project_id: { type: 'objectId', default: () => config.redash.projectId } },
  },
  l12_intake: {
    label: 'Deliverable intake',
    description: 'Tasks entering level 12 per day — the rate at which work becomes deliverable.',
    sql: 'l12_intake.sql',
    params: {
      project_id: { type: 'objectId', default: () => config.redash.projectId },
      days: { type: 'int', min: 1, max: 180, default: () => 30 },
    },
  },
  level_economics: {
    label: 'Cost and rework per level',
    description: 'Hours, attempts, rejection rate, billable-vs-wasted hours and QMS per review level.',
    sql: 'level_economics.sql',
    params: {
      project_id: { type: 'objectId', default: () => config.redash.projectId },
      days: { type: 'int', min: 1, max: 365, default: () => 30 },
    },
  },

  // ---- blocked work ----

  blocked_backlog: {
    label: 'Blocked backlog for one lane',
    description: 'Every task stuck in a review level, longest first, with who authored it and where it came from.',
    sql: 'blocked_backlog.sql',
    params: {
      project_id: { type: 'objectId', default: () => config.redash.projectId },
      // -1 (authoring) through 12 (final). 1 and 8 are the problem lanes.
      level: { type: 'int', min: -1, max: 12, default: () => 8 },
    },
  },
  lane_aging: {
    label: 'Queue aging buckets',
    description: 'Pending tasks per review level bucketed by how long they have waited.',
    sql: 'lane_aging.sql',
    params: { project_id: { type: 'objectId', default: () => config.redash.projectId } },
  },

  // ---- contributor quality ----
  //
  // All three read VIEW.GEN_AI_ISR rather than rebuilding quality from
  // WORKERCOMMENTS: it is one row per attempt and already carries the QMS score,
  // the send-back flag, wasted hours, email and team. See contributor_quality.sql.

  contributor_quality: {
    label: 'Contributor quality and actions',
    description: 'Per-contributor QMS score, poor-rating rate, tier and the recommended ops action.',
    sql: 'contributor_quality.sql',
    params: {
      project_id: { type: 'objectId', default: () => config.redash.projectId },
      days: { type: 'int', min: 1, max: 365, default: () => 30 },
    },
  },
  quality_trend: {
    label: 'Quality trend, window over window',
    description: 'Each contributor this window against the one before, flagging anyone whose quality slipped.',
    sql: 'quality_trend.sql',
    params: {
      project_id: { type: 'objectId', default: () => config.redash.projectId },
      window_days: { type: 'int', min: 1, max: 90, default: () => 7 },
    },
  },
  reviewer_scorecard: {
    label: 'Reviewer scorecard',
    description: 'Per reviewer: throughput, send-back rate, how hard they grade, and trusted status.',
    sql: 'reviewer_scorecard.sql',
    params: {
      project_id: { type: 'objectId', default: () => config.redash.projectId },
      level: { type: 'int', min: -1, max: 12, default: () => 0 },
      days: { type: 'int', min: 1, max: 365, default: () => 30 },
    },
  },
};

// Public shape for the UI / copilot: what can be run and with which params.
export function describeRegistry() {
  // ACC-only queries stay runnable by name but are not offered — on RLI they
  // return nothing, and an analyst reading "winning side" will build a story on it.
  return Object.entries(REGISTRY).filter(([, entry]) => !entry.accOnly).map(([name, entry]) => ({
    name,
    label: entry.label,
    description: entry.description,
    source: entry.savedQueryId ? `redash:${entry.savedQueryId}` : `sql/redash/${entry.sql}`,
    params: Object.entries(entry.params || {}).map(([pname, p]) => ({
      name: pname,
      type: p.type,
      required: !!p.required,
      default: p.default ? p.default() : undefined,
    })),
  }));
}

// Keyed by file, invalidated on mtime.
//
// This used to memoize forever, which meant a change to a .sql file did not take
// effect until the process was restarted BY HAND: `node --watch` only watches
// what the module graph imports, and these are read with fs, so nothing here
// triggers a reload. The failure is quiet and expensive — you edit a query, the
// page keeps rendering the old numbers, and the natural conclusion is that the
// edit was wrong. A stat per call is nothing next to a Snowflake round trip.
const sqlCache = new Map();
function loadSql(file) {
  // Guard against a registry typo escaping sql/redash/.
  const abs = path.resolve(SQL_DIR, file);
  if (!abs.startsWith(SQL_DIR + path.sep)) throw new RedashError(`bad sql path: ${file}`, 500);

  const mtime = fs.statSync(abs).mtimeMs;
  const hit = sqlCache.get(file);
  if (hit && hit.mtime === mtime) return hit.sql;

  const sql = fs.readFileSync(abs, 'utf8');
  sqlCache.set(file, { mtime, sql });
  return sql;
}

// Validate + interpolate. Every {{placeholder}} must be satisfied by a declared,
// type-checked param — an unresolved one is a hard error rather than a query
// that silently runs with a literal "{{days}}" in it.
export function renderSql(name, params = {}) {
  const entry = REGISTRY[name];
  if (!entry) throw new RedashError(`unknown query: ${name}`, 404);
  if (!entry.sql) throw new RedashError(`${name} is a saved query, not ad-hoc SQL`, 400);

  let sql = loadSql(entry.sql);
  for (const [pname, spec] of Object.entries(entry.params || {})) {
    const supplied = params[pname];
    const value = supplied === undefined || supplied === '' ? spec.default?.() : supplied;
    if (value === undefined) {
      if (spec.required) throw new RedashError(`missing required parameter: ${pname}`, 400);
      continue;
    }
    const fn = TYPES[spec.type];
    if (!fn) throw new RedashError(`unknown param type ${spec.type}`, 500);
    const literal = fn(value, spec);
    sql = sql.split(`{{${pname}}}`).join(literal);
  }

  const leftover = sql.match(/\{\{\s*([a-z0-9_]+)\s*\}\}/i);
  if (leftover) throw new RedashError(`parameter not supplied: ${leftover[1]}`, 400);
  return sql;
}

// Run a registry entry. Dispatches to saved-query or ad-hoc execution.
export function runRegistryQuery(name, params = {}, opts = {}) {
  const entry = REGISTRY[name];
  if (!entry) throw new RedashError(`unknown query: ${name}`, 404);
  if (entry.savedQueryId) return runSaved(entry.savedQueryId, params, opts);
  return runAdhoc(entry.dataSourceId || config.redash.dataSourceId, renderSql(name, params), opts);
}
