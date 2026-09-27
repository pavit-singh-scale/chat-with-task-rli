import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { REGISTRY, describeRegistry, renderSql, runRegistryQuery } from './redash_registry.js';
import { runAdhoc, redashEnabled, assertReadOnly, RedashError } from './redash.js';

// Acey's analyst toolkit: the ability to answer a question nobody wrote a query
// for yet.
//
// The curated registry answers the questions we anticipated. Everything else —
// which is most of what a QM actually asks — needs SQL written on the spot. So
// these three tools are deliberately a LEARNING LOOP rather than a bare SQL box:
//
//   list_queries  what already exists (don't rewrite level_economics from scratch)
//   read_query    the full SQL of any of them, comments included
//   run_sql       compose and execute, read-only
//
// read_query is the important one. The .sql files in sql/redash/ carry the table
// names, the join keys, the project filter, the timezone convention and — in
// their comments — the traps that cost real time to find (age from CREATED_AT not
// UPDATED_AT; gen_ai_isr rather than a four-way WORKERCOMMENTS join; the levels
// that are blocked rather than sequential). A model that reads two of them before
// writing its own inherits all of that. One that starts from an empty buffer
// reinvents the mistakes those comments were written to prevent.
//
// SAFETY: every run_sql call goes through the same assertReadOnly gate as the
// admin SQL box — SELECT/WITH only, single statement, no DDL/DML keywords —
// against a data source that should be read-only regardless. The SQL is returned
// to the caller alongside the answer, so a wrong number is always traceable to
// the query that produced it rather than being an unfalsifiable assertion.

const SQL_DIR = path.join(config.projectRoot, 'sql', 'redash');

// Schema notes the model cannot infer from the query files alone, because they
// describe which source to prefer rather than what any one file does. Kept short
// on purpose: this rides in the system prompt on every analyst turn.
export const SCHEMA_BRIEF = `
UPSTREAM SCHEMA (Snowflake via Redash, data source ${config.redash.dataSourceId}). RLI project id
'${config.redash.projectId}' — filter EVERY query by it.

  VIEW.GEN_AI_ISR          one row per attempt, already denormalised. Prefer this for anything
                           about people, quality or cost. Columns: WORKER, EMAIL, WORKER_TEAM_NAME,
                           WORK_LEVEL, WORK_DAY, WORK_HOURS_SPENT (billable), USELESS (bool —
                           hours thrown away), AVG_QMS_SCORE (1-5), SBQ_FLAG, REVIEW_STATUS,
                           BATCH_NAME, TASK_ID, ATTEMPT_ID, LAST_ACTIVE_PT.
                           Always filter TYPE_ENTRY = 'fwa'. SBQ_FLAG is REVIEW_STATUS='rejected'.
  PUBLIC.PIPELINEV3HUMANNODES  one row per task per review level. TASK, REVIEW_LEVEL, STATUS
                           ('pending'/'paused'/'completed'/'canceled' — live = pending OR paused),
                           CREATED_AT (entered the level),
                           UPDATED_AT (last touched — NOT entry, do not age from it), WORKER.
  PUBLIC.TASKATTEMPTS      TASK, ATTEMPTED_BY, ATTEMPTED_AT, ATTEMPTED_AT_REVIEW_LEVEL,
                           V2_TIME_SPENT_SECS (tracked, not billable), V2_ACTIVE_TIME_SPENT_SECS,
                           REVIEW_OUTCOME, IS_SEND_BACK_TO_QUEUE, REVIEWED_ATTEMPT (the attempt
                           this review graded), RESPONSE (the annotation payload, a big VARIANT).
  PUBLIC.WORKERCOMMENTS    QMS ratings. SOURCE='qualityMeasurement', TYPE='rating',
                           TITLE IN ('Quality: Overall Task','Turn Quality: Final Response'),
                           COMMENT = the 1-5 score as text, AUTHOR = the rater,
                           ATTEMPT_TO_REVIEW = the attempt graded.
  VIEW.DIM_USERS           USER_ID, EMAIL, FULL_NAME, WORKER_TEAM_NAME, TAGS_NAME (array),
                           LAST_ACTIVE_PT.
  VIEW.REVIEW_TASK_MOVEMENT_V3  movement events with PREVIOUS_REVIEW_LEVEL and TRANSITION_TYPE.
                           Accurate but SLOW (~30s) — only when previous-level is genuinely needed.

REVIEW LEVELS (RLI): L-1 authoring (brief/input sufficiency + rubric), L0 first review, L1 review
(sends tasks on to L10), L10 QM review, L12 delivery pool. L4, L8 and L11 are off the forward path
and their meaning is not confirmed — L8 looks like a fresh pool awaiting eval; say "unconfirmed"
rather than inventing a role for L4 / L11. Refer to levels by number, never invented stage names.
`.trim();

export const ANALYST_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_queries',
      description:
        'List the curated SQL queries this project already has, with what each one answers. '
        + 'Call this FIRST for any data question: if one of these already answers it, run it with '
        + 'redash_query instead of writing SQL. If none does, read the closest one or two with '
        + 'read_query before composing your own.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_query',
      description:
        'Return the full SQL of a curated query, comments included. Use it to learn the house '
        + 'conventions — table names, join keys, the project filter, timezone handling — and the '
        + 'documented traps, before writing your own SQL. Reading the two closest queries first is '
        + 'much cheaper than debugging a query written from nothing.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: Object.keys(REGISTRY), description: 'Registry query name.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'redash_query',
      description:
        'Run a curated registry query by name — its {{params}} are validated and filled server-side, '
        + 'so this is the safe way to run anything list_queries shows. Prefer it over run_sql when a '
        + 'curated query already answers the question; the .sql files carry templates run_sql cannot '
        + 'execute as-is.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: Object.keys(REGISTRY), description: 'Registry query name (from list_queries).' },
          params: {
            type: 'object',
            description: 'Parameters by name, e.g. {"task_ids": ["<24-hex id>", …]}. list_queries shows what each query takes; optional ones can be omitted.',
          },
          purpose: {
            type: 'string',
            description: 'One short line on what this run is meant to establish. Shown to the operator.',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_sql',
      description:
        'Run read-only SQL (SELECT / WITH only) against the upstream warehouse and get rows back. '
        + 'Use when no curated query answers the question. Filter by the RLI project id, put a LIMIT '
        + 'on exploratory queries, and prefer VIEW.GEN_AI_ISR for anything about people, quality or '
        + 'cost. The SQL you run is shown to the operator alongside your answer, so write it to be '
        + 'read. If it errors, fix and retry rather than guessing at the number.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A single SELECT/WITH statement.' },
          purpose: {
            type: 'string',
            description: 'One short line on what this query is meant to establish. Shown to the operator.',
          },
        },
        required: ['sql', 'purpose'],
      },
    },
  },
];

export const ANALYST_TOOL_NAMES = new Set(ANALYST_TOOL_DEFS.map((t) => t.function.name));

// Compact fixed-width table — far cheaper in tokens than JSON, and the model
// reads columns more reliably out of aligned text than nested objects.
function asTable(out, maxRows = 50) {
  const cols = out.columns.map((c) => c.name);
  const rows = out.rows.slice(0, maxRows);
  const cell = (r, c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]));
  const width = cols.map((c) => Math.min(42, Math.max(c.length, ...rows.map((r) => cell(r, c).length), 1)));
  const line = (vals) => vals.map((v, i) => String(v).slice(0, width[i]).padEnd(width[i])).join('  ').trimEnd();
  const body = [line(cols), line(width.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map((c) => cell(r, c))))];
  if (out.rows.length > maxRows) body.push(`… ${out.rows.length - maxRows} more row(s) not shown`);
  return body.join('\n');
}

// `onQuery` lets the route stream the SQL to the UI as it runs, so the operator
// watches the work rather than receiving an unsourced number at the end.
export function makeAnalystExecutor({ onQuery } = {}) {
  return async (name, args = {}) => {
    switch (name) {
      case 'list_queries':
        return describeRegistry()
          .map((q) => `${q.name}: ${q.description} [params: ${q.params.map((p) => p.name).join(', ') || 'none'}]`)
          .join('\n');

      case 'read_query': {
        const entry = REGISTRY[args.name];
        if (!entry) return `ERROR: unknown query ${JSON.stringify(args.name)}.`;
        if (!entry.sql) return `${args.name} is a saved Redash query (id ${entry.savedQueryId}), not local SQL.`;
        try {
          return `[sql/redash/${entry.sql}]\n` + fs.readFileSync(path.join(SQL_DIR, entry.sql), 'utf8');
        } catch (e) {
          return `ERROR reading ${entry.sql}: ${e.message}`;
        }
      }

      case 'redash_query': {
        if (!redashEnabled()) return 'ERROR: Redash is not configured on this server (REDASH_API_KEY unset).';
        const entry = REGISTRY[args.name];
        if (!entry) return `ERROR: unknown query ${JSON.stringify(args.name)} — call list_queries for the catalogue.`;
        // Stream the rendered SQL when it exists locally, so the number stays
        // traceable to the query that produced it — same contract as run_sql.
        let shown = `-- registry query: ${args.name}`;
        if (entry.sql) {
          try { shown = renderSql(args.name, args.params || {}); } catch { /* validation error surfaces below */ }
        }
        onQuery?.({ sql: shown, purpose: String(args.purpose || `curated query ${args.name}`) });
        try {
          const out = await runRegistryQuery(args.name, args.params || {}, {});
          if (!out.rowCount) return '[0 rows] The query ran and returned nothing. Say so — do not fill the gap with an estimate.';
          return `[${out.rowCount} row(s)${out.cached ? ', cached' : ''}]\n${asTable(out)}`;
        } catch (e) {
          const msg = e instanceof RedashError ? e.message : String(e.message || e);
          return `ERROR: ${msg}\nCheck the parameter names and types against list_queries, or read_query + run_sql instead.`;
        }
      }

      case 'run_sql': {
        if (!redashEnabled()) return 'ERROR: Redash is not configured on this server (REDASH_API_KEY unset).';
        let sql;
        try {
          sql = assertReadOnly(String(args.sql || ''));
        } catch (e) {
          return `REJECTED: ${e.message}. Only a single SELECT/WITH statement is allowed.`;
        }
        onQuery?.({ sql, purpose: String(args.purpose || '') });
        try {
          const out = await runAdhoc(config.redash.dataSourceId, sql, {});
          if (!out.rowCount) return '[0 rows] The query ran and returned nothing. Say so — do not fill the gap with an estimate.';
          return `[${out.rowCount} row(s)${out.cached ? ', cached' : ''}]\n${asTable(out)}`;
        } catch (e) {
          const msg = e instanceof RedashError ? e.message : String(e.message || e);
          return `ERROR: ${msg}\nFix the SQL and try again. Do not report a number you did not get back.`;
        }
      }

      default:
        return `ERROR: unknown tool ${name}`;
    }
  };
}

// Exposed for the route so it can name the curated queries in the system prompt
// without importing the registry itself.
export function queryCatalogue() {
  return describeRegistry().map((q) => `${q.name} — ${q.description}`).join('\n');
}

export { renderSql, runRegistryQuery };
