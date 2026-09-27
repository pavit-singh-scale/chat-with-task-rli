import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './fixes.js';
import { taskDir, httpError } from './workspace.js';

// Per-task review state, shared across users: _studio.json in the task folder.
export const VERDICTS = ['NO_ISSUES', 'FIXES_MADE', 'SBQ', 'SECOND_OPINION'];

export function getState(bucket, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(taskDir(bucket, id), '_studio.json'), 'utf8'));
  } catch {
    return {};
  }
}

function saveState(bucket, id, state) {
  writeJsonAtomic(path.join(taskDir(bucket, id), '_studio.json'), state);
}

// writeJsonAtomic for content that is already a serialized string (carried-over
// _studio.json / ledgers on re-upload): temp file + rename in the same dir.
export function writeTextAtomic(p, text) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

export function claimTask(bucket, id, username) {
  const state = getState(bucket, id);
  if (state.claimed_by && state.claimed_by !== username) {
    throw httpError(409, `already claimed by ${state.claimed_by}`);
  }
  state.claimed_by = username;
  state.claimed_at = new Date().toISOString();
  saveState(bucket, id, state);
  return state;
}

export function releaseTask(bucket, id, username, isAdmin) {
  const state = getState(bucket, id);
  if (state.claimed_by && state.claimed_by !== username && !isAdmin) {
    throw httpError(403, `claimed by ${state.claimed_by} — only they or an admin can release`);
  }
  delete state.claimed_by;
  delete state.claimed_at;
  saveState(bucket, id, state);
  return state;
}

// Per-finding checklist status, keyed by finding id (F1, F2…): 'done' (fixed /
// verified) or 'overflag' (over-flagged, not a real issue). Cleared = open.
const CHECK_STATUSES = ['done', 'overflag'];

export function setChecklistItem(bucket, id, key, status, username) {
  if (!key) throw httpError(400, 'key required');
  if (status && !CHECK_STATUSES.includes(status)) {
    throw httpError(400, `status must be one of ${CHECK_STATUSES.join(', ')} (or empty to clear)`);
  }
  const state = getState(bucket, id);
  state.checklist ||= {};
  if (!status) delete state.checklist[key];
  else state.checklist[key] = { status, by: username, at: new Date().toISOString() };
  saveState(bucket, id, state);
  return state;
}

// "Delivered" is a soft archive: the task stays on disk (and in its bucket) but is
// hidden from the board. Reversible in-app; also captured in the deliver backup.
export function setDelivered(bucket, id, delivered, username) {
  const state = getState(bucket, id);
  if (delivered) {
    state.delivered = true;
    state.delivered_by = username;
    state.delivered_at = new Date().toISOString();
  } else {
    delete state.delivered;
    delete state.delivered_by;
    delete state.delivered_at;
  }
  saveState(bucket, id, state);
  return state;
}

// ---- lane state as one unit (for bulk moves + undo) ----
// Everything that decides which lane a task sits in, in one object. Undo restores
// exactly this, which is what makes reverting a heterogeneous selection correct —
// "the previous lane" alone couldn't rebuild these three fields.
export function laneSnapshot(bucket, id) {
  const s = getState(bucket, id);
  return {
    verdict: s.verdict ?? null,
    claimed_by: s.claimed_by ?? null,
    grammar_lane: s.grammar_lane ?? null,
    verdict_note: s.verdict_note ?? null,
  };
}

export function applySnapshot(bucket, id, snap, username) {
  const state = getState(bucket, id);
  const stamp = new Date().toISOString();

  if (snap.verdict) {
    state.verdict = snap.verdict;
    state.verdict_by = username;
    state.verdict_at = stamp;
  } else {
    delete state.verdict; delete state.verdict_by; delete state.verdict_at;
  }
  // The Second Opinion "why" note only makes sense on that verdict. Restore it
  // verbatim with the verdict so an undo doesn't lose it.
  if (snap.verdict === 'SECOND_OPINION' && snap.verdict_note) {
    state.verdict_note = snap.verdict_note;
    state.verdict_note_by = username;
    state.verdict_note_at = stamp;
  } else {
    delete state.verdict_note; delete state.verdict_note_by; delete state.verdict_note_at;
  }

  if (snap.claimed_by) {
    if (state.claimed_by !== snap.claimed_by) state.claimed_at = stamp;
    state.claimed_by = snap.claimed_by;
  } else {
    delete state.claimed_by; delete state.claimed_at;
  }

  if (snap.grammar_lane) {
    state.grammar_lane = snap.grammar_lane;
    state.grammar_lane_by = username;
    state.grammar_lane_at = stamp;
  } else {
    delete state.grammar_lane; delete state.grammar_lane_by; delete state.grammar_lane_at;
  }

  saveState(bucket, id, state);
  return state;
}

// Manual Grammar Fixes membership. Tasks whose audit trips only R23/R24 land in
// that lane on their own; this overrides the automatic call in both directions —
// 'in' for "everything else is fixed, grammar is all that's left", 'out' to push
// an auto-detected one back into the normal flow (without it, the auto rule would
// just pull it straight back). null clears the override.
const GRAMMAR_LANE_MODES = ['in', 'out'];

export function setGrammarLane(bucket, id, mode, username) {
  if (mode !== null && !GRAMMAR_LANE_MODES.includes(mode)) {
    throw httpError(400, `mode must be one of ${GRAMMAR_LANE_MODES.join(', ')} (or null to clear)`);
  }
  const state = getState(bucket, id);
  if (mode === null) {
    delete state.grammar_lane;
    delete state.grammar_lane_by;
    delete state.grammar_lane_at;
  } else {
    state.grammar_lane = mode;
    state.grammar_lane_by = username;
    state.grammar_lane_at = new Date().toISOString();
  }
  saveState(bucket, id, state);
  return state;
}

export function setVerdict(bucket, id, verdict, username) {
  if (verdict !== null && !VERDICTS.includes(verdict)) {
    throw httpError(400, `verdict must be one of ${VERDICTS.join(', ')} (or null to clear)`);
  }
  const state = getState(bucket, id);
  if (verdict === null) {
    delete state.verdict;
    delete state.verdict_by;
    delete state.verdict_at;
  } else {
    state.verdict = verdict;
    state.verdict_by = username;
    state.verdict_at = new Date().toISOString();
  }
  // The "why" note only applies to a Second Opinion — drop it when the verdict
  // moves anywhere else (including cleared), so a stale reason can't linger.
  if (verdict !== 'SECOND_OPINION') {
    delete state.verdict_note;
    delete state.verdict_note_by;
    delete state.verdict_note_at;
  }
  saveState(bucket, id, state);
  return state;
}

// The key-issue explanation attached to a Second Opinion verdict. Empty clears it.
export function setVerdictNote(bucket, id, note, username) {
  const state = getState(bucket, id);
  const n = String(note || '').trim().slice(0, 4000);
  if (n) {
    state.verdict_note = n;
    state.verdict_note_by = username;
    state.verdict_note_at = new Date().toISOString();
  } else {
    delete state.verdict_note;
    delete state.verdict_note_by;
    delete state.verdict_note_at;
  }
  saveState(bucket, id, state);
  return state;
}
