import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, BUCKETS } from './config.js';
import { ensureWorkspace } from './workspace.js';

// A disposable, per-user sandbox task so reviewers can actually *do* things
// during the tour (claim, decide, drag between lanes, chat with the copilot)
// without touching real data. Tagged in _studio.json so the board hides it from
// everyone else and exports skip it; removed when the tour ends.

const TOUR_BUCKET = 'SOFT_FAIL'; // a middle severity; starts Open (no verdict/claim)

function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function trajectory(side, opinionated) {
  const t = (created) => ({ created, completed: created + 800 });
  const u = (text, at) => ({ info: { role: 'user', time: t(at) }, parts: [{ type: 'text', text }] });
  const a = (parts, at) => ({ info: { role: 'assistant', time: t(at) }, parts });
  const tool = (tool, title, input, output) => ({ type: 'tool', tool, callID: 'c_' + tool, state: { status: 'completed', title, input, output } });
  return {
    info: { model: side },
    messages: [
      u('Build a Python CLI that converts a CSV of sales into a monthly summary report.', 1000),
      a([
        { type: 'text', text: `I'll scaffold a small CLI. First let me look at the data shape.` },
        tool('bash', 'Inspect sample', { command: 'head -3 sales.csv' }, 'date,amount\n2026-01-03,42.00\n2026-01-09,18.50'),
        { type: 'text', text: 'Created `report.py` that groups rows by month and totals `amount`.' },
      ], 2000),
      u('Add a --format flag supporting json and table output.', 3000),
      a([
        { type: 'text', text: opinionated
          ? 'Added `--format {json,table}`. Verified both against the sample: **12 rows across 2 months**, totals match a hand check.'
          : 'Added a --format flag.' },
        tool('bash', 'Run tests', { command: 'python -m pytest -q' }, opinionated ? '4 passed in 0.21s' : '2 failed, 2 passed'),
      ], 4000),
    ],
  };
}

function rankJson() {
  const dims = ['correctness', 'agent_behaviour', 'communications', 'code_style'];
  const grading = (scores, notes) => Object.fromEntries(dims.map((d, i) => [d, { score: scores[i], rationale: notes[i] }]));
  const fmodes = (over) => {
    const keys = ['incomplete_code', 'overclaimed_status', 'continuation_nudges', 'excessive_turns', 'weak_verification',
      'malformed_tool_calls', 'debugging_loops', 'over_scoped', 'wrong_initial_approach', 'regression_during_refactor',
      'gibberish_output', 'unrequested_artifacts', 'excessive_verbosity', 'instruction_following', 'poor_navigation',
      'silent_no_progress', 'hallucinations', 'stubbornness'];
    return Object.fromEntries(keys.map((k) => [k, over[k] || 'none']));
  };
  return {
    instance_id: 'sandbox-tour-demo',
    annotator_id: 'tour_sandbox',
    vendor: 'Sandbox',
    problem_statement: 'Sandbox task for the guided tour — safe to click, drag, decide, and chat. Nothing here is real; it is deleted when the tour ends.',
    test_type: 'AB',
    task: {
      task_title: 'Sandbox: sales CSV → monthly report',
      task_category: 'tour',
      difficulty: 'easy',
      language: 'Python',
      user_intent: {
        user_persona: 'A tour-taker exploring the RLI Operations Hub.',
        milestones: [
          { milestone_id: 'm1', title: 'Build the CLI', prompt: 'Build a Python CLI that converts a CSV of sales into a monthly summary report.' },
          { milestone_id: 'm2', title: 'Add output format', prompt: 'Add a --format flag supporting json and table output.' },
        ],
        guardrails: ['Do not fabricate test results.'],
      },
    },
    results: {
      sandbox_alpha: {
        model_assignment: 'model_a', rank: 2,
        summary: 'Alpha built a working CLI but reported tests passing while the suite was still red at the end.',
        grading: grading([2, 3, 3, 3], [
          'Report works but the summary overclaims the test state.',
          'Reasonable tool use; some churn on the format flag.',
          'Clear enough, but the final status was inaccurate.',
          'Readable, small module.',
        ]),
        failure_modes: fmodes({ overclaimed_status: 'severe', weak_verification: 'mild' }),
        trajectory_file: 'trajectories/trajectory_model_a.json',
      },
      sandbox_beta: {
        model_assignment: 'model_b', rank: 1,
        summary: 'Beta built the CLI, added both output formats, and verified against the sample before claiming success.',
        grading: grading([4, 4, 4, 4], [
          'Correct output; claims match the verified run.',
          'Efficient, well-sequenced tool use.',
          'Accurate, concise status updates.',
          'Clean, idiomatic module.',
        ]),
        failure_modes: fmodes({}),
      },
    },
    preference_rating: 2,
    ranking_rationale: 'I ranked Beta higher: it verified both formats against the sample and its claims matched the run, whereas Alpha reported passing tests while the suite was still failing.',
    optional_clarification_comments: null,
    optional_other_comments: null,
  };
}

const REVIEW_MD = `# Review — Sandbox tour task

\`\`\`alerts
Alpha overclaims test status — its summary says tests pass while the run is red.
\`\`\`

### [HARD] F1 — Winner-side claim is accurate; loser overclaims
Alpha's summary claims passing tests, but [model_a msg 3](traj://model_a/3) shows the suite still failing. Beta verified before claiming — see \`/results/sandbox_beta/summary\` and the decision in \`/ranking_rationale\`. Rule: [R12 Summaries · Accuracy](spec://R12).

### [SOFT] F2 — Minor: format flag churn on Alpha
Alpha reworked the \`--format\` flag more than needed. Not a correctness issue.

_This is a sandbox finding for the tour. It isn't real._
`;

export function createDummyTask(user) {
  ensureWorkspace();
  removeTourTasks(user); // clear any stale sandbox for this user first
  const id = crypto.randomBytes(12).toString('hex'); // 24 hex
  const dir = path.join(config.workspaceRoot, TOUR_BUCKET, id);
  fs.mkdirSync(path.join(dir, 'trajectories'), { recursive: true });
  writeJSON(path.join(dir, 'rank.json'), rankJson());
  writeJSON(path.join(dir, 'trajectories', 'trajectory_model_a.json'), trajectory('model_a', false));
  writeJSON(path.join(dir, 'trajectories', 'trajectory_model_b.json'), trajectory('model_b', true));
  fs.writeFileSync(path.join(dir, 'review.md'), REVIEW_MD);
  writeJSON(path.join(dir, '_studio.json'), { tour: true, tour_owner: user });
  return { bucket: TOUR_BUCKET, id };
}

// Remove sandbox tasks. With a user, only theirs; without, every tour task
// (used to sweep leftovers).
export function removeTourTasks(user) {
  ensureWorkspace();
  let removed = 0;
  for (const b of BUCKETS) {
    const bdir = path.join(config.workspaceRoot, b);
    for (const name of fs.readdirSync(bdir)) {
      const studio = path.join(bdir, name, '_studio.json');
      try {
        const s = JSON.parse(fs.readFileSync(studio, 'utf8'));
        if (s.tour && (!user || s.tour_owner === user)) { fs.rmSync(path.join(bdir, name), { recursive: true, force: true }); removed++; }
      } catch { /* not a tour task */ }
    }
  }
  return removed;
}

export function logTour(entry) {
  try {
    fs.appendFileSync(path.join(config.dataDir, 'tour_log.jsonl'), JSON.stringify(entry) + '\n');
  } catch { /* logging is best-effort */ }
}
