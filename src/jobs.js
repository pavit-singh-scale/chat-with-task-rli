import { generateDocForDir } from './docgen.js';
import { taskDir, moveTask } from './workspace.js';
import { isRliTask } from './rli.js';
import { proposedBucket } from './rli_docgen.js';
import fs from 'node:fs';
import path from 'node:path';
import { recordUsage } from './usage.js';
import { config } from './config.js';

// Server-side doc-generation queue. Jobs run independently of the HTTP request
// that started them, so navigating away (or closing the tab) does NOT stop a
// generation — the doc is still written. State is in-memory (a server restart
// drops in-flight jobs); the UI polls status and reloads when a doc lands.
const MAX = Math.max(1, Number(process.env.GENDOCS_CONCURRENCY || 2));
const queue = [];
const status = new Map(); // "bucket/id" -> { state, which, current, error, ts }
let active = 0;

const keyOf = (bucket, id) => `${bucket}/${id}`;

// whichList is processed in order per task (review before remediation).
export function enqueueDocs(bucket, id, whichList, user) {
  const k = keyOf(bucket, id);
  const cur = status.get(k);
  if (cur && (cur.state === 'pending' || cur.state === 'running')) return { queued: false, busy: true };
  queue.push({ bucket, id, whichList, user });
  status.set(k, { state: 'pending', which: whichList, ts: Date.now() });
  pump();
  return { queued: true };
}

function pump() {
  while (active < MAX && queue.length) {
    const job = queue.shift();
    active++;
    runJob(job).catch(() => {}).finally(() => { active--; pump(); });
  }
}

async function runJob({ bucket, id, whichList, user }) {
  const k = keyOf(bucket, id);
  status.set(k, { state: 'running', which: whichList, current: whichList[0], ts: Date.now() });
  try {
    const dir = taskDir(bucket, id);
    for (const w of whichList) {
      status.get(k).current = w;
      const acc = { prompt_tokens: 0, completion_tokens: 0 };
      await generateDocForDir(dir, w, {
        id,
        onUsage: (u) => { acc.prompt_tokens += u.prompt_tokens || 0; acc.completion_tokens += u.completion_tokens || 0; },
      });
      recordUsage({ user: user || '(batch)', taskId: id, kind: `docgen:${w}`, model: config.litellm.model, usage: acc, text: `Generated ${w}.md` });
    }
    // RLI: the review's proposed bucket IS the eval's severity call, so the task
    // is filed there — unless a reviewer has already put a decision on it.
    let movedTo = null;
    if (whichList.includes('review') && isRliTask(dir)) {
      const target = proposedBucket(fs.readFileSync(path.join(dir, 'review.md'), 'utf8'));
      let decided = false;
      try { decided = !!JSON.parse(fs.readFileSync(path.join(dir, '_studio.json'), 'utf8')).verdict; } catch { /* no state */ }
      if (target && target !== bucket && !decided) { moveTask(bucket, id, target); movedTo = target; }
    }
    status.set(k, { state: 'done', which: whichList, movedTo, ts: Date.now() });
    if (movedTo) status.set(`${movedTo}/${id}`, { state: 'done', which: whichList, movedFrom: bucket, ts: Date.now() });
  } catch (e) {
    status.set(k, { state: 'error', which: whichList, error: e.message, ts: Date.now() });
  }
}

export function statusFor(bucket, id) {
  return status.get(keyOf(bucket, id)) || { state: 'idle' };
}

export function jobSummary() {
  const tasks = [...status.entries()].map(([k, v]) => ({ key: k, ...v }));
  const counts = { pending: 0, running: 0, done: 0, error: 0, idle: 0 };
  for (const t of tasks) counts[t.state] = (counts[t.state] || 0) + 1;
  // pending in counts only reflects last-known map state; add live queue depth
  return { active, queued: queue.length, counts, busy: active + queue.length > 0 };
}
