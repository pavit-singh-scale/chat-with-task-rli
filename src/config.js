import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so we don't need a dotenv dependency.
const envPath = path.join(projectRoot, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export const BUCKETS = ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED'];

export const config = {
  port: Number(process.env.PORT || 4100),
  projectRoot,
  workspaceRoot: path.resolve(projectRoot, expandHome(process.env.WORKSPACE_ROOT || './workspace')),
  // spec/ (customer docs, not in git) and data/ (users.json) — overridable so
  // containers can mount them as volumes
  specDir: path.resolve(projectRoot, expandHome(process.env.SPEC_DIR || './spec')),
  dataDir: path.resolve(projectRoot, expandHome(process.env.DATA_DIR || './data')),
  deliveryRoots: (process.env.DELIVERY_ROOTS || '~/Downloads')
    .split(':')
    .map((p) => path.resolve(expandHome(p.trim())))
    .filter(Boolean),
  litellm: {
    baseURL: (process.env.LITELLM_BASE_URL || 'http://localhost:4000').replace(/\/+$/, ''),
    apiKey: process.env.LITELLM_API_KEY,
    model: process.env.LITELLM_MODEL || 'claude-opus-5-5',
  },
  // Live Redash integration (src/redash.js): pipeline panels on L12 Stats, the
  // per-task Pipeline tab, the copilot's redash_query tool, and the in-app query
  // browser. Same REDASH_API_KEY as the pull below — it must be a Redash USER
  // key, since ad-hoc SQL (the sql/redash/*.sql half of the hybrid registry) is
  // rejected for query-scoped keys.
  redash: {
    baseUrl: (process.env.REDASH_BASE_URL || 'https://redash.scale.com').replace(/\/+$/, ''),
    apiKey: process.env.REDASH_API_KEY,
    // Data source the analytics SQL runs against. Distinct from the pull's
    // REDASH_DATA_SOURCE_ID (30) — the ACC pipeline queries live on 22.
    dataSourceId: Number(process.env.REDASH_ANALYTICS_DATA_SOURCE_ID || 22),
    // ACC project whose pipeline the dashboards describe.
    // RLI Custom (PKJA). ACC_PROJECT_ID is still honoured as a fallback.
    projectId: process.env.RLI_CUSTOM_PROJECT_ID || process.env.ACC_PROJECT_ID || '6a989ef00d42ba8e15aaac6c',
    cacheTtlMs: Number(process.env.REDASH_CACHE_TTL_SECONDS || 300) * 1000,
    pollIntervalMs: Number(process.env.REDASH_POLL_INTERVAL_MS || 1500),
    requestTimeoutMs: Number(process.env.REDASH_REQUEST_TIMEOUT_MS || 30_000),
    queryTimeoutMs: Number(process.env.REDASH_QUERY_TIMEOUT_SECONDS || 180) * 1000,
    // Ad-hoc SQL typed into the in-app browser is admin-only and off by default;
    // the curated registry and saved queries work either way.
    allowAdhoc: process.env.REDASH_ALLOW_ADHOC !== 'false',
  },
  // The Overview page (/overview.html): the weekly delivery rhythm it measures
  // everything against. Both are project facts rather than preferences, so they
  // live here instead of in the page — the copy, the target line on the delivery
  // chart and the readiness maths all read the same two numbers.
  overview: {
    // RLI delivers on Mondays. Volume is TBD: 50 is the working estimate for
    // the first delivery (Pavit, 0926) until the ramp plan lands.
    targetVolume: Number(process.env.OVERVIEW_TARGET_VOLUME || 50),
    // 0 = Sunday … 6 = Saturday. Cadence and greeting are anchored to
    // America/Los_Angeles in src/overview.js, so an evening packaging run isn't
    // pushed onto the next day by a UTC clock.
    deliveryWeekday: Number(process.env.OVERVIEW_DELIVERY_WEEKDAY || 1),
    staleDays: Number(process.env.OVERVIEW_STALE_DAYS || 7),
    // Who the Overview page writes action items for.
    //
    // The lead gets a different KIND of item, not a share of the queue: they own
    // cross-functional and directional calls (raising a broken gate with the
    // platform owners, committing to or resetting a delivery number), so handing
    // them 24 tasks to triage would be the wrong instruction.
    lead: process.env.OVERVIEW_LEAD || 'pavit',
    reviewers: (process.env.OVERVIEW_REVIEWERS || 'burak,frida,gabriela,garrett,jose,lenny,nevena,sandra,shafin,timothee,alberto')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },
  // On-demand pull of tasks from Redash (a whole review level, or an explicit id
  // list) into a downloadable zip. Needs REDASH_API_KEY in the environment, read
  // by tools/get_tasks/pull_l10.py. No schedule — admin-button triggered only.
  l10: {
    reviewLevel: Number(process.env.L10_REVIEW_LEVEL ?? 10),
    status: process.env.L10_STATUS || 'pending',
    limit: Number(process.env.L10_PULL_LIMIT ?? 0), // 0 = no cap
  },
};
