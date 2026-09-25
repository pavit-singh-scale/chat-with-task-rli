import fs from 'node:fs';
import path from 'node:path';

// The fix engine: parse, validate, apply, deny, and undo the directive fixes
// that arrive with a batch (HANDOFF_STAGING_FIXES_BACKFILL.md §2-§5).
//
// Two kinds of fix flow through here and they behave differently on deny:
//
//   APPLIED   grammar edits the eval already wrote into rank.json. Arrive
//             pre-approved (ledger seeded decided_by acc-eval). Denying one
//             must REVERT the span from rank.source.json — otherwise the UI
//             says "denied" while the change ships anyway.
//   PROPOSED  non-grammar label corrections awaiting a human. Approving one
//             applies it; denying records the reason and touches nothing.
//
// Everything that changes rank.json goes through the append-only ledger, and
// undo is field-reset-from-source + replay of the survivors — never an in-place
// inversion of a string edit, which fails the moment two fixes touch one field.

// ---------------------------------------------------------------------------
// JSON pointers (RFC 6901)
// ---------------------------------------------------------------------------

const unescape = (s) => s.replace(/~1/g, '/').replace(/~0/g, '~');

export function ptrGet(obj, pointer) {
  if (!pointer || pointer === '/') return obj;
  let cur = obj;
  for (const raw of pointer.replace(/^\//, '').split('/')) {
    const key = unescape(raw);
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key];
  }
  return cur;
}

export function ptrSet(obj, pointer, value) {
  const parts = pointer.replace(/^\//, '').split('/').map(unescape);
  let cur = obj;
  for (const key of parts.slice(0, -1)) {
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key];
    if (cur == null) throw new Error(`path does not resolve: ${pointer}`);
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cur)) cur[Number(last)] = value;
  else cur[last] = value;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readMaybe = (p) => { try { return read(p); } catch { return null; } };

// Every write to a label-critical file goes through temp-then-rename: a crash
// mid-write leaves the old file intact instead of a truncated JSON that takes
// the task (and any export touching it) down with it. Rename within one
// directory is atomic on POSIX.
export function writeJsonAtomic(p, data) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

// RLI tasks keep their record in task.json; fixes target it, with a pristine
// task.source.json (written at ingest, or lazily on first use) for undo.
const isRli = (dir) => fs.existsSync(path.join(dir, 'task.json'));
// For RLI the pristine copy must exist BEFORE the first write — creating it
// lazily at undo time would snapshot the already-edited record.
export const rankPath = (dir) => {
  if (!isRli(dir)) return path.join(dir, 'rank.json');
  const src = path.join(dir, 'task.source.json');
  if (!fs.existsSync(src)) fs.copyFileSync(path.join(dir, 'task.json'), src);
  return path.join(dir, 'task.json');
};
export const sourcePath = (dir) => {
  if (!isRli(dir)) return path.join(dir, 'rank.source.json');
  const src = path.join(dir, 'task.source.json');
  if (!fs.existsSync(src)) fs.copyFileSync(path.join(dir, 'task.json'), src);
  return src;
};
export const ledgerPath = (dir) => path.join(dir, 'fix_ledger.json');
export const fixesCachePath = (dir) => path.join(dir, 'fixes.json');

export function readLedger(dir) {
  const l = readMaybe(ledgerPath(dir));
  return Array.isArray(l) ? l : [];
}

function writeLedger(dir, entries) {
  writeJsonAtomic(ledgerPath(dir), entries);
}

export function appendLedger(dir, entry) {
  const entries = readLedger(dir);
  entries.push(entry);
  writeLedger(dir, entries);
  return entry;
}

// ---------------------------------------------------------------------------
// Parsing remediation.md fix blocks
// ---------------------------------------------------------------------------

// Single-line JSON inside a ```fix fence (§2.4). Parse errors are data, not
// exceptions — they surface as ingest warnings.
export function parseFixBlocks(md) {
  const blocks = [];
  const errors = [];
  let i = 0;
  for (const m of String(md || '').matchAll(/```fix\n(.*?)\n```/gs)) {
    i += 1;
    try {
      const fix = JSON.parse(m[1]);
      if (!fix.id) fix.id = `F${i}`;
      // RLI: "rd" is what everyone calls the golden side; the record's key is "golden".
      if (typeof fix.path === 'string') fix.path = fix.path.replace(/(\/criteria\/\d+\/)rd(\/|$)/, '$1golden$2');
      blocks.push(fix);
    } catch (e) {
      errors.push({ block: i, error: e.message, raw: m[1].slice(0, 200) });
    }
  }
  return { blocks, errors };
}

// Cached against remediation.md's mtime — the doc is REGENERATED by docgen,
// and a forever-cache here would keep serving the old fix blocks after a
// regen: wrong pending counts on cards, wrong Staging membership, wrong
// checklist. Same failure class as the "export stopped updating" bug, one
// layer down. A legacy cache without an mtime stamp counts as stale.
export function loadFixBlocks(dir) {
  const mdPath = path.join(dir, 'remediation.md');
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(mdPath).mtimeMs; } catch { /* no doc */ }
  const cached = readMaybe(fixesCachePath(dir));
  if (cached && cached.mtimeMs === mtimeMs && Array.isArray(cached.blocks)) return cached;
  let md = '';
  try { md = fs.readFileSync(mdPath, 'utf8'); } catch { /* none */ }
  const parsed = { ...parseFixBlocks(md), mtimeMs };
  try { writeJsonAtomic(fixesCachePath(dir), parsed); } catch { /* read-only fs */ }
  return parsed;
}

// ---------------------------------------------------------------------------
// Ledger seeding (§3.1)
// ---------------------------------------------------------------------------

// The eval's grammar edits arrive as history, not as pending work: one approved
// entry per edit, decided_by acc-eval. Idempotent — seeding twice adds nothing.
export function seedLedgerFromGrammar(dir) {
  const grammar = readMaybe(path.join(dir, 'grammar_fixes.json'));
  const edits = Array.isArray(grammar) ? grammar : grammar?.fixes;
  if (!edits?.length) return 0;
  const ledger = readLedger(dir);
  const have = new Set(ledger.filter((e) => e.decided_by === 'acc-eval').map((e) => e.fix_id));
  let added = 0;
  edits.forEach((e, i) => {
    const fixId = `G${i + 1}`;
    if (have.has(fixId)) return;
    ledger.push({
      fix_id: fixId,
      source: 'grammar_fixes.json',
      path: e.path,
      occurrence: e.occurrence ?? 1,
      old: e.old,
      new: e.new,
      rule: e.rule,
      class: e.class,
      error_type: e.error_type,
      meaning_changing: !!e.meaning_changing,
      reanchored: !!e.reanchored,
      owner: e.owner,
      decision: 'approved',
      decided_by: 'acc-eval',
      decided_at: new Date().toISOString(),
      reverted_at: null,
      reason: null,
    });
    added += 1;
  });
  if (added) writeLedger(dir, ledger);
  return added;
}

// Re-upload of CHANGED content reopens the task; replaying stale `old` strings
// onto re-delivered text is the likeliest way to silently corrupt a label, so
// prior BOARD decisions are marked superseded instead (§3.1). Eval-seeded
// entries are dropped outright — the new batch re-seeds from its own
// grammar_fixes.json, which is the current truth.
export function supersedeLedger(entries) {
  const now = new Date().toISOString();
  return entries
    .filter((e) => e.decided_by !== 'acc-eval')
    .map((e) => ({ ...e, superseded_at: e.superseded_at || now }));
}

// ---------------------------------------------------------------------------
// Validation (§4.6, ported from validate_fix_blocks.py)
// ---------------------------------------------------------------------------

const VERDICTS = new Set(['PASS', 'SOFT', 'HARD']);

export function validateTask(dir, auditRow) {
  const warnings = [];
  const live = readMaybe(rankPath(dir));
  const source = readMaybe(sourcePath(dir));

  if (!auditRow) warnings.push({ check: 'verdict-missing', detail: 'task dir has no row in final_verdicts.json — it lands in UNSORTED' });
  else if (!VERDICTS.has(String(auditRow.verdict || '').toUpperCase())) {
    warnings.push({ check: 'verdict-unknown', detail: `verdict ${JSON.stringify(auditRow.verdict)} is outside {PASS,SOFT,HARD}` });
  }

  const { blocks, errors } = loadFixBlocks(dir);
  for (const e of errors) warnings.push({ check: 'fix-parse', detail: `fix block ${e.block} does not parse: ${e.error}` });

  for (const fix of blocks) {
    if (!fix.path) continue; // instruction-only — render, never apply
    if (fix.status === 'PROPOSED') {
      const state = fixApplicability(live, fix);
      if (state !== 'OK') warnings.push({ check: 'fix-drifted', detail: `${fix.id}: PROPOSED old does not resolve at ${fix.path} (${state})` });
    } else if (fix.status === 'APPLIED') {
      // Inverted assertion for applied fixes: old lives in the SOURCE, new in
      // the LIVE file. Getting this backwards makes every correctly-applied
      // grammar fix look broken (§4.6). reanchored blocks skip the old check.
      const liveVal = live ? ptrGet(live, fix.path) : undefined;
      const srcVal = source ? ptrGet(source, fix.path) : undefined;
      if (!fix.reanchored && source && !contains(srcVal, fix.old)) {
        warnings.push({ check: 'applied-old-missing', detail: `${fix.id}: APPLIED old not found in rank.source.json at ${fix.path}` });
      }
      if (live && !contains(liveVal, fix.new)) {
        warnings.push({ check: 'applied-new-missing', detail: `${fix.id}: APPLIED new not found in rank.json at ${fix.path}` });
      }
    }
  }

  // The same inverted assertion over the grammar edits themselves.
  const grammar = readMaybe(path.join(dir, 'grammar_fixes.json'));
  const edits = Array.isArray(grammar) ? grammar : grammar?.fixes;
  if (edits?.length && source && live) {
    edits.forEach((e, i) => {
      if (!e.reanchored && !contains(ptrGet(source, e.path), e.old)) {
        warnings.push({ check: 'grammar-old-missing', detail: `G${i + 1}: old not found in rank.source.json at ${e.path}` });
      }
      if (!contains(ptrGet(live, e.path), e.new)) {
        warnings.push({ check: 'grammar-new-missing', detail: `G${i + 1}: new not found in rank.json at ${e.path}` });
      }
    });
  }
  return warnings;
}

function contains(value, needle) {
  if (value === undefined) return false;
  if (needle === '') return true; // deletion — nothing to find
  return typeof value === 'string' ? value.includes(needle) : String(value) === String(needle);
}

// ---------------------------------------------------------------------------
// Apply / deny / revert (§5)
// ---------------------------------------------------------------------------

const count = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);

// Non-overlapping stepping, so its match numbering agrees with count() —
// stepping by one character finds overlap positions count() never saw.
function replaceNth(hay, oldStr, newStr, n) {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = hay.indexOf(oldStr, idx === -1 ? 0 : idx + oldStr.length);
    if (idx === -1) return null;
  }
  return hay.slice(0, idx) + newStr + hay.slice(idx + oldStr.length);
}

// Scalars keep their type: a score stays a number, "null" becomes null (the
// reference batch really does propose code_style/score: 3 -> null). When the
// current value is null the type must come from the string itself — typeof
// null is 'object', and shipping "4" where a score belongs corrupts the label.
function coerce(newStr, original) {
  if (newStr === 'null') return null;
  if (typeof original === 'number') return Number(newStr);
  if (typeof original === 'boolean') return newStr === 'true';
  if (original === null || original === undefined) {
    if (/^-?\d+(\.\d+)?$/.test(newStr)) return Number(newStr);
    if (newStr === 'true' || newStr === 'false') return newStr === 'true';
  }
  return newStr;
}

export function fixApplicability(live, fix) {
  if (!live) return 'NO_RANK';
  const value = ptrGet(live, fix.path);
  if (value === undefined) return 'NO_PATH';
  if (typeof value !== 'string') {
    return String(value) === String(fix.old) ? 'OK' : 'DRIFTED';
  }
  const n = count(value, fix.old);
  if (n === 0) return 'DRIFTED';
  // A fix authored against the 2nd occurrence of a field that now has one is
  // just as drifted as a zero-hit — replaceNth would come back null and the
  // write would replace the whole field with null.
  if (n < (fix.occurrence ?? 1)) return 'DRIFTED';
  if (n > 1 && (fix.occurrence ?? 1) === 1 && (fix.occurrences_in_field ?? 1) === 1) return 'AMBIGUOUS';
  return 'OK';
}

// One PROPOSED fix. Refuses — and says why — rather than writing on any doubt:
// DRIFTED means the text is not what the fix was authored against, AMBIGUOUS
// means the eval must widen `old` (§5.2). Never called for APPLIED blocks.
export function applyFix(dir, fix, user, { editedFrom = null } = {}) {
  if (fix.status !== 'PROPOSED') throw new Error(`refusing to re-apply ${fix.id}: status is ${fix.status}, not PROPOSED`);
  if (!fix.path) throw new Error(`${fix.id} is instruction-only (path: null) — not applicable`);

  const live = read(rankPath(dir));
  const value = ptrGet(live, fix.path);
  const state = fixApplicability(live, fix);
  if (state !== 'OK') return { result: state };

  if (typeof value !== 'string') {
    ptrSet(live, fix.path, coerce(fix.new, value));
  } else {
    const replaced = replaceNth(value, fix.old, fix.new, fix.occurrence ?? 1);
    if (replaced === null) return { result: 'DRIFTED' }; // belt-and-braces: never persist a null field
    ptrSet(live, fix.path, replaced);
  }
  writeJsonAtomic(rankPath(dir), live);

  appendLedger(dir, {
    fix_id: fix.id,
    source: 'remediation.md',
    path: fix.path,
    occurrence: fix.occurrence ?? 1,
    old: fix.old,
    new: fix.new,
    rule: fix.rule,
    class: fix.class,
    meaning_changing: !!fix.meaning_changing,
    owner: fix.owner,
    decision: 'approved',
    decided_by: user,
    decided_at: new Date().toISOString(),
    reverted_at: null,
    reason: null,
    // The reviewer replaced the proposed text with their own: the trail shows
    // what the model proposed AND what actually shipped.
    ...(editedFrom !== null ? { edited_from: editedFrom } : {}),
  });
  return { result: 'APPLIED' };
}

// Approve with the reviewer's own replacement text. For a PROPOSED fix this is
// applyFix with `new` overridden; for an APPLIED grammar edit the eval's text
// is already in the file, so the field is rebuilt from source with the edited
// text in place of the eval's — the ledger then reads: eval's edit
// denied-as-superseded, reviewer's edit approved. The rebuild is computed
// fully in memory and only persisted when every step lands, so a drift can't
// leave the field reverted with the reviewer's text never applied.
export function approveWithText(dir, item, user, newText) {
  if (item.kind === 'grammar') {
    const ledger = readLedger(dir);
    // Latest non-superseded entry, active or not — editing a previously denied
    // edit is a legitimate reversal, not an error.
    const entry = [...ledger].reverse().find((e) => e.fix_id === item.id && !e.superseded_at);
    if (!entry) throw new Error(`no ledger entry for ${item.id}`);
    const wasActive = entry.decision === 'approved' && !entry.reverted_at;

    const source = readMaybe(sourcePath(dir));
    const live = read(rankPath(dir));
    const srcVal = source ? ptrGet(source, entry.path) : undefined;
    if (srcVal === undefined) throw new Error(`rank.source.json has no value at ${entry.path} — cannot rebuild the field for an edit`);

    // Rebuild: source value → replay every OTHER approved entry on the path →
    // the reviewer's text where the eval's edit went.
    const survivors = ledger
      .filter((e) => e !== entry && e.path === entry.path && !e.reverted_at && !e.superseded_at && e.decision === 'approved')
      .sort((a, b) => String(a.decided_at).localeCompare(String(b.decided_at)));
    let value = srcVal;
    for (const e of [...survivors, { ...entry, new: newText }]) {
      if (typeof value !== 'string') { value = coerce(String(e.new), value); continue; }
      const replaced = replaceNth(value, e.old, e.new, e.occurrence ?? 1);
      if (replaced === null) throw new Error(`edit does not land: ${e.fix_id}'s old text not found on ${entry.path} after rebuild`);
      value = replaced;
    }

    if (wasActive) {
      entry.reverted_at = new Date().toISOString();
      entry.decision = 'denied';
      entry.reverted_by = user;
      entry.reason = 'superseded by reviewer edit';
    }
    // source 'board': fixStates renders grammar items off their seed entries
    // and reads decision state via latest(fix_id) — a second grammar-source
    // entry under the same id would render the item twice.
    ledger.push({
      fix_id: entry.fix_id, source: 'board', path: entry.path,
      occurrence: entry.occurrence ?? 1, old: entry.old, new: newText,
      rule: entry.rule, class: entry.class, error_type: entry.error_type,
      meaning_changing: true, owner: entry.owner,
      decision: 'approved', decided_by: user, decided_at: new Date().toISOString(),
      reverted_at: null, reason: null, edited_from: entry.new,
    });

    ptrSet(live, entry.path, value);
    writeJsonAtomic(rankPath(dir), live);
    writeLedger(dir, ledger);
    return { result: 'APPLIED' };
  }
  return applyFix(dir, { ...item, status: 'PROPOSED', new: newText }, user, { editedFrom: item.new });
}

// Plain approval of a grammar edit. The edit is already in the file, so on an
// active entry this is sign-off, recorded without touching text — and it must
// stamp the entry fixStates actually reads (the latest non-superseded one),
// not whichever the ledger lists first. On an entry the reviewer previously
// denied (text reverted), approve-anyway is a reversal: the eval's edit goes
// back in as a fresh approved entry, so the trail keeps the deny.
export function approveGrammar(dir, item, user) {
  const ledger = readLedger(dir);
  const entry = [...ledger].reverse().find((e) => e.fix_id === item.id && !e.superseded_at);
  if (!entry) throw Object.assign(new Error(`no ledger entry for ${item.id}`), { status: 404 });

  if (entry.decision === 'approved' && !entry.reverted_at) {
    entry.signed_off_by = user;
    entry.signed_off_at = new Date().toISOString();
    writeLedger(dir, ledger);
    return { result: 'SIGNED_OFF' };
  }

  const live = read(rankPath(dir));
  const value = ptrGet(live, entry.path);
  if (typeof value !== 'string') {
    ptrSet(live, entry.path, coerce(String(entry.new), value));
  } else {
    const replaced = replaceNth(value, entry.old, entry.new, entry.occurrence ?? 1);
    if (replaced === null) return { result: 'DRIFTED' };
    ptrSet(live, entry.path, replaced);
  }
  writeJsonAtomic(rankPath(dir), live);
  appendLedger(dir, {
    fix_id: entry.fix_id, source: 'board', path: entry.path,
    occurrence: entry.occurrence ?? 1, old: entry.old, new: entry.new,
    rule: entry.rule, class: entry.class, error_type: entry.error_type,
    meaning_changing: !!entry.meaning_changing, owner: entry.owner,
    decision: 'approved', decided_by: user, decided_at: new Date().toISOString(),
    reverted_at: null, reason: null,
    signed_off_by: user, signed_off_at: new Date().toISOString(),
  });
  return { result: 'APPLIED' };
}

// Deny records a judgement. For PROPOSED that is all it does; for an APPLIED
// grammar edit the text is already in the file, so deny also reverts the span —
// driven off the block's status, never off which button was pressed (§5.1).
export function denyFix(dir, fix, user, reason) {
  if (fix.status === 'PROPOSED') {
    appendLedger(dir, {
      fix_id: fix.id, source: 'remediation.md', path: fix.path,
      old: fix.old, new: fix.new, rule: fix.rule, meaning_changing: !!fix.meaning_changing,
      decision: 'denied', decided_by: user, decided_at: new Date().toISOString(),
      reverted_at: null, reason: reason || null,
    });
    return { result: 'DENIED' };
  }
  // APPLIED: find the seeded ledger entry and revert it.
  const ledger = readLedger(dir);
  const entry = ledger.find((e) => e.fix_id === fix.id && !e.reverted_at);
  if (!entry) throw new Error(`no active ledger entry for ${fix.id}`);
  return revertEntry(dir, entry, user, reason);
}

// Undo = mark the entry, reset the whole field from rank.source.json, then
// replay every surviving approved entry on that path in decision order (§5.5).
export function revertFix(dir, fixId, user, reason) {
  const ledger = readLedger(dir);
  const entry = ledger.find((e) => e.fix_id === fixId && !e.reverted_at && e.decision === 'approved');
  if (!entry) throw new Error(`no active approved entry for ${fixId}`);
  return revertEntry(dir, entry, user, reason);
}

function revertEntry(dir, entry, user, reason) {
  const ledger = readLedger(dir);
  const target = ledger.find((e) => e.fix_id === entry.fix_id && !e.reverted_at && e.decision === 'approved');
  if (!target) throw new Error(`no active approved entry for ${entry.fix_id}`);

  const source = readMaybe(sourcePath(dir));
  const live = read(rankPath(dir));
  const srcVal = source ? ptrGet(source, entry.path) : undefined;
  const failures = [];

  // Decide whether a reset is possible BEFORE marking anything — a ledger that
  // says REVERTED while the text still ships is the §5.1 failure mode, so the
  // refusal paths below leave both files untouched.
  if (srcVal === undefined) {
    // No anchor for this path (no source file, or the source predates the
    // field). Inverting the entry's own edit is only safe when it is the
    // field's sole edit and its new-text is still present to find.
    const others = ledger.filter((e) => e !== target && e.path === entry.path && !e.reverted_at && !e.superseded_at && e.decision === 'approved');
    if (others.length) return { result: 'NO_SOURCE_ANCHOR', failures: [entry.fix_id] };
    const value = ptrGet(live, entry.path);
    if (typeof value === 'string') {
      if (entry.new === '' || !value.includes(entry.new)) return { result: 'NO_SOURCE_ANCHOR', failures: [entry.fix_id] };
      ptrSet(live, entry.path, replaceNth(value, entry.new, entry.old, 1));
    } else {
      ptrSet(live, entry.path, coerce(String(entry.old), value === null ? 0 : value));
    }
    markReverted(target, user, reason);
    writeJsonAtomic(rankPath(dir), live);
    writeLedger(dir, ledger);
    return { result: 'REVERTED', failures: [] };
  }

  // Reset the whole field from source, then replay the survivors, oldest
  // decision first. A survivor whose old-text no longer lands is flagged
  // needs_reanchor on its ledger entry — persisted, so the UI and export
  // gates see it, not just this response (§5.4).
  ptrSet(live, entry.path, srcVal);
  markReverted(target, user, reason);
  const survivors = ledger
    .filter((e) => e.path === entry.path && !e.reverted_at && !e.superseded_at && e.decision === 'approved')
    .sort((a, b) => String(a.decided_at).localeCompare(String(b.decided_at)));
  for (const e of survivors) {
    const value = ptrGet(live, e.path);
    if (typeof value !== 'string') {
      ptrSet(live, e.path, coerce(String(e.new), value));
    } else {
      const replaced = replaceNth(value, e.old, e.new, e.occurrence ?? 1);
      if (replaced === null) { e.needs_reanchor = true; failures.push(e.fix_id); continue; }
      delete e.needs_reanchor;
      ptrSet(live, e.path, replaced);
    }
  }
  writeJsonAtomic(rankPath(dir), live);
  writeLedger(dir, ledger);
  return { result: 'REVERTED', failures };
}

function markReverted(target, user, reason) {
  target.reverted_at = new Date().toISOString();
  target.decision = 'denied';
  target.reverted_by = user;
  if (reason) target.reason = reason;
}

// ---------------------------------------------------------------------------
// The merged view the UI renders (§5.6)
// ---------------------------------------------------------------------------

export function fixStates(dir) {
  const { blocks, errors } = loadFixBlocks(dir);
  const ledger = readLedger(dir);
  const live = readMaybe(rankPath(dir));
  const latest = (fixId) => [...ledger].reverse().find((e) => e.fix_id === fixId && !e.superseded_at);

  const items = [];

  // Grammar edits, from their seeded entries — already applied, sign-off state
  // comes from whether a human has touched the entry since the seed.
  for (const e of ledger) {
    if (e.decided_by !== 'acc-eval' && e.source !== 'grammar_fixes.json') continue;
    if (e.superseded_at) continue;
    const current = latest(e.fix_id);
    items.push({
      id: e.fix_id, kind: 'grammar', status: 'APPLIED',
      path: e.path, old: e.old, new: e.new, rule: e.rule, class: e.class,
      error_type: e.error_type, meaning_changing: !!e.meaning_changing, owner: e.owner,
      decision: current.decision, decided_by: current.decided_by, decided_at: current.decided_at,
      reverted: !!current.reverted_at, reason: current.reason || null,
      applied_new: current.decision === 'approved' && !current.reverted_at ? current.new : undefined,
      edited_from: current.edited_from,
      signed_off_by: current.signed_off_by || null,
      needs_reanchor: !!current.needs_reanchor,
    });
  }

  // Directive blocks from remediation.md.
  for (const fix of blocks) {
    if (fix.status === 'APPLIED') continue; // same edit as a grammar entry above
    const e = latest(fix.id);
    const applicability = fix.path && !e ? fixApplicability(live, fix) : null;
    items.push({
      ...fix,
      kind: fix.path ? 'proposed' : 'instruction',
      decision: e ? e.decision : 'pending',
      decided_by: e?.decided_by || null,
      decided_at: e?.decided_at || null,
      reverted: !!e?.reverted_at,
      // What actually shipped can differ from what the block proposed — an
      // edited approval applies the reviewer's text. Surface both so the UI
      // shows the landed text and the "edited" marker.
      applied_new: e && e.decision === 'approved' && !e.reverted_at ? e.new : undefined,
      edited_from: e?.edited_from,
      applicability: e ? null : (fix.path ? applicability : null),
      needsReanchor: !e && fix.path ? applicability === 'DRIFTED' : false,
    });
  }

  return {
    items,
    parseErrors: errors,
    pending: items.filter((i) => i.kind === 'proposed' && i.decision === 'pending').length,
    hasSource: fs.existsSync(sourcePath(dir)),
    ledgerCount: ledger.filter((e) => !e.superseded_at).length,
  };
}

// Cheap summary for taskMeta — called per task on every board list. It stats
// remediation.md and only re-parses when the doc actually changed (a docgen
// regen), so the hot path stays a stat + two reads while the counts can never
// go stale — stale pendingFixes here means wrong Staging membership and a
// backfill export with undecided fixes in it.
export function fixSummary(dir) {
  const ledger = readLedger(dir);
  let cached = readMaybe(fixesCachePath(dir));
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(path.join(dir, 'remediation.md')).mtimeMs; } catch { /* no doc */ }
  if (!cached || cached.mtimeMs !== mtimeMs) cached = loadFixBlocks(dir);
  const blocks = cached?.blocks || [];
  const decided = new Set(ledger.filter((e) => !e.superseded_at).map((e) => e.fix_id));
  const pending = blocks.filter((b) => b.status === 'PROPOSED' && b.path && !decided.has(b.id)).length;
  return {
    ledgerCount: ledger.filter((e) => !e.superseded_at).length,
    pendingFixes: pending,
    instructions: blocks.filter((b) => !b.path).length,
  };
}
