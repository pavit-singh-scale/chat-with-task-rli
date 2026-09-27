import { BUCKETS } from './config.js';
import { taskMeta, listWorkspace, httpError } from './workspace.js';
import { laneSnapshot, applySnapshot } from './state.js';

// The workflow lanes, and the ONE place that maps a lane to the task state it
// implies. The board, the bulk mover, and undo all go through here so a lane can
// never mean two different things in two places.
export const LANES = ['OPEN', 'STAGING', 'REVIEW', 'SECOND_OPINION', 'RESOLVED'];
export const RESOLVED_VERDICTS = ['NO_ISSUES', 'FIXES_MADE', 'SBQ'];
const RESOLVED = new Set(RESOLVED_VERDICTS);

// REOPEN is a destination, not a lane: it clears the verdict and touches nothing
// else, so each task falls back to wherever the automatic rules put it (a
// task with fix work returns to Staging, a claimed one to In review). That is
// what "undo the decision" means, and it can't be expressed as a lane — moving to
// Open would also force grammar tasks out with an 'out' override.
export const DESTINATIONS = [...LANES, 'REOPEN'];

export const LANE_LABELS = {
  OPEN: 'Open',
  STAGING: 'Staging',
  REVIEW: 'In review',
  SECOND_OPINION: 'Needs 2nd opinion',
  RESOLVED: 'Resolved',
  REOPEN: 'Reopened',
};
export const SEV_LABELS = { HARD_FAIL: 'Hard', SOFT_FAIL: 'Soft', PASS: 'Pass', UNSORTED: 'Unsorted' };
export const VERDICT_LABELS = {
  NO_ISSUES: 'No issues', FIXES_MADE: 'Fixes made',
  SBQ: 'SBQ', SECOND_OPINION: 'Second opinion',
};

// Mirrors laneOf() on the board: a verdict decides first, then Staging
// membership (fix sign-off and backfill happen there, so a claim doesn't move
// it out), then the claim.
export function laneOf(meta) {
  if (meta.verdict === 'SECOND_OPINION') return 'SECOND_OPINION';
  if (meta.verdict && RESOLVED.has(meta.verdict)) return 'RESOLVED';
  if (meta.inStagingLane) return 'STAGING';
  if (meta.claimedBy) return 'REVIEW';
  return 'OPEN';
}

// The state a destination lane requires, given what the task is now. Returns the
// full snapshot to write, so callers never have to reason about which of the
// three fields a given lane cares about.
//   - Staging membership is content-derived (ledger / pending fixes), so leaving
//     needs an explicit 'out' override or the automatic rule pulls the task back.
//   - SECOND_OPINION/RESOLVED leave the grammar override alone: a verdict outranks
//     it, so clearing the verdict later correctly returns the task to the lane.
export function snapshotForLane(lane, { meta, verdict, username }) {
  if (!DESTINATIONS.includes(lane)) throw httpError(400, `unknown destination ${lane} — one of ${DESTINATIONS.join(', ')}`);
  const cur = { verdict: meta.verdict ?? null, claimed_by: meta.claimedBy ?? null, grammar_lane: meta.grammarLane ?? null };
  const leaveGrammar = (meta.ledgerCount > 0 || meta.pendingFixes > 0 || meta.grammarOnly) ? 'out' : null;
  switch (lane) {
    case 'REOPEN':
      return { verdict: null, claimed_by: cur.claimed_by, grammar_lane: cur.grammar_lane };
    case 'OPEN':
      return { verdict: null, claimed_by: null, grammar_lane: leaveGrammar };
    case 'REVIEW':
      return { verdict: null, claimed_by: cur.claimed_by || username, grammar_lane: leaveGrammar };
    case 'STAGING':
      return { verdict: null, claimed_by: cur.claimed_by, grammar_lane: 'in' };
    case 'SECOND_OPINION':
      return { verdict: 'SECOND_OPINION', claimed_by: cur.claimed_by, grammar_lane: cur.grammar_lane };
    case 'RESOLVED': {
      if (!RESOLVED.has(verdict)) {
        throw httpError(400, `moving to Resolved needs a verdict — one of ${RESOLVED_VERDICTS.join(', ')}`);
      }
      return { verdict, claimed_by: cur.claimed_by, grammar_lane: cur.grammar_lane };
    }
    default:
      throw httpError(400, `unknown lane ${lane}`);
  }
}

// Move one task to a lane. Returns the before/after pair the action journal needs,
// or null when the move would change nothing (nothing written, nothing logged).
//
// The no-op test compares the resulting STATE, not just the lane. Comparing lanes
// missed same-lane verdict changes: a task already Resolved·SBQ sent to
// Resolved·No issues has an unchanged lane, so it was skipped and the verdict
// silently stayed SBQ.
export function moveTaskToLane(bucket, id, lane, { verdict, username }) {
  const plan = planTaskLaneMove(bucket, id, lane, { verdict, username });
  if (!plan.changes) return null;
  applySnapshot(bucket, id, plan.after, username);
  return { bucket, id, before: plan.before, after: plan.after };
}

// The same computation WITHOUT writing, so a caller can show what a move would do
// before committing to it (the copilot stages bulk moves for confirmation this
// way). Deliberately shares snapshotForLane + the no-op test with the writing
// path above — a separate dry-run implementation is exactly how a preview drifts
// from what the apply actually does.
export function planTaskLaneMove(bucket, id, lane, { verdict, username }) {
  const meta = taskMeta(bucket, id);
  const before = laneSnapshot(bucket, id);
  const after = snapshotForLane(lane, { meta, verdict, username });
  const same = before.verdict === after.verdict
    && before.claimed_by === after.claimed_by
    && before.grammar_lane === after.grammar_lane;
  return { bucket, id, meta, before, after, changes: !same };
}

// Resolve a bulk selection server-side rather than trusting the client's copy of
// the board: severity + source lane + an optional explicit id list.
export function selectTasks({ severity, fromLane, ids }) {
  // An explicitly EMPTY id list selects nothing. Only a missing list means "no id
  // filter" — otherwise a caller that computes an empty selection and sends [] would
  // silently move every task matching the severity + lane instead.
  if (Array.isArray(ids) && ids.length === 0) return [];
  const idSet = Array.isArray(ids) ? new Set(ids) : null;
  const buckets = severity && severity !== 'ALL' ? [severity] : BUCKETS;
  const out = [];
  const ws = listWorkspace();
  for (const bucket of buckets) {
    for (const meta of ws[bucket] || []) {
      if (meta.tour || meta.delivered) continue;     // tour sandboxes aren't real tasks; delivered = archived
      if (idSet && !idSet.has(meta.id)) continue;
      if (fromLane && fromLane !== 'ANY' && laneOf(meta) !== fromLane) continue;
      out.push(meta);
    }
  }
  return out;
}
