// RLI Review + Remediation tabs, rendered from the structured eval (eval.json).
//
// Review = a verdict strip, the scores before/after the proposed fixes, and one
// row per finding (click for the evidence). Remediation = the same findings as
// a to-do list of one-click fixes. Both read the same list, so they can't
// disagree, and every score shown is computed here from the record — never
// taken from the model's arithmetic.
import { api, el, renderMarkdown } from './common.js';

const SIDES = [['golden', 'RD'], ['ad1', 'AD1'], ['ad2', 'AD2']];
const LABEL = Object.fromEntries(SIDES);
const GATE = { golden: 97, ad1: 70, ad2: 50 };
const BUCKET = { HARD_FAIL: ['Fail', 'hard'], SOFT_FAIL: ['Non-fail', 'soft'], PASS: ['No issues', 'pass'] };
const r1 = (x) => Math.round(x * 10) / 10;

export function createRliEval({ bucket, taskId, rli, onCrit, onSpec, onOpenTab, decorateFixDocs, decisionPanel }) {
  const where = (f) => (f.crit ? `C${f.crit}${f.side ? ` · ${LABEL[f.side]}` : ''}` : 'Task');
  const whereBtn = (f) => (f.crit
    ? el('button', { type: 'button', class: 'rev-where', title: 'Open in the rubric', onclick: (e) => { e.stopPropagation(); onCrit(f.crit, f.side); } }, where(f))
    : el('span', { class: 'rev-where rev-where--task' }, 'Task'));
  const dimBtn = (d) => (d ? el('button', { type: 'button', class: 'rli-spec', title: `Open ${d} in the QC spec`, onclick: (e) => { e.stopPropagation(); onSpec(d); } }, d) : el('span'));
  const inlineMd = (s) => { const n = el('span', { class: 'rev-md' }); n.innerHTML = renderMarkdown(s).replace(/^<p>|<\/p>\s*$/g, ''); return n; };

  // ---------- scores: printed → current record → after every pending fix ----------
  function score(criteria, side, overrides = new Map()) {
    let s = 0, total = 0;
    criteria.forEach((c, i) => {
      const w = overrides.has(`${i}/weight`) ? Number(overrides.get(`${i}/weight`)) : c.weight;
      if (w > 0) total += w;
      const k = `${i}/${side}/passed`;
      const passed = overrides.has(k) ? overrides.get(k) === 'true' : c.verdicts[side].passed === true;
      if (passed) s += w;
    });
    return total ? (s / total) * 100 : null;
  }
  function pendingOverrides(fixItems) {
    const o = new Map();
    for (const i of fixItems || []) {
      if (i.kind !== 'proposed' || i.decision !== 'pending' || !i.path) continue;
      const m = i.path.match(/^\/rubric_eval\/criteria\/(\d+)\/(?:(golden|ad1|ad2)\/passed|weight)$/);
      if (m) o.set(m[2] ? `${m[1]}/${m[2]}/passed` : `${m[1]}/weight`, String(i.new));
    }
    return o;
  }
  // Per-finding impact on each side, in percentage points of that side's score.
  function impact(f, t) {
    const edits = (f.fix?.edits || []).filter((e) => e.field === 'passed' || e.field === 'weight');
    if (!edits.length) return [];
    const o = new Map();
    for (const e of edits) {
      const m = e.path.match(/criteria\/(\d+)\/(?:(golden|ad1|ad2)\/passed|weight)$/);
      if (m) o.set(m[2] ? `${m[1]}/${m[2]}/passed` : `${m[1]}/weight`, String(e.new));
    }
    return SIDES.map(([s, lab]) => {
      const d = score(t.criteria, s, o) - score(t.criteria, s);
      return Math.abs(d) >= 0.05 ? { side: s, label: lab, d: r1(d) } : null;
    }).filter(Boolean);
  }
  function gateOk(side, v) { return v == null ? null : side === 'golden' ? v >= GATE.golden : v <= GATE[side]; }

  function scoreRow(t, fixItems) {
    const over = pendingOverrides(fixItems);
    const nPending = (fixItems || []).filter((i) => i.kind === 'proposed' && i.decision === 'pending').length;
    return el('div', { class: 'rev-scores' },
      ...SIDES.map(([s, lab]) => {
        const printed = t.scores?.[s]?.percentage ?? null;
        const now = score(t.criteria, s);
        const after = score(t.criteria, s, over);
        const moved = after != null && now != null && Math.abs(after - now) >= 0.05;
        const edited = printed != null && now != null && Math.abs(now - printed) >= 0.05;
        // The RD gate is judged on the PRINTED score (spec); the AD gates on the corrected one.
        const judged = s === 'golden' ? printed : (moved ? after : now);
        const ok = gateOk(s, judged);
        return el('div', { class: `rev-score ${ok === false ? 'is-bad' : ok ? 'is-ok' : ''}` },
          el('span', { class: 'rev-score__k' }, lab),
          el('span', { class: 'rev-score__v' },
            `${printed == null ? '—' : r1(printed)}`,
            edited ? el('span', { class: 'rev-score__arrow', title: 'after fixes already applied' }, ` → ${r1(now)}`) : null,
            moved ? el('span', { class: 'rev-score__arrow is-pending', title: 'if every pending fix is approved' }, ` → ${r1(after)}`) : null),
          el('span', { class: 'rev-score__gate' }, `${s === 'golden' ? '≥' : '≤'} ${GATE[s]} ${ok === false ? '✕' : ok ? '✓' : ''}`));
      }),
      el('span', { class: 'rev-scores__note' }, nPending ? `→ = if the ${nPending} pending fix${nPending > 1 ? 'es are' : ' is'} approved` : 'no pending fixes'));
  }

  // Fix state for a finding, from the ledger (ids F2a, F2b… belong to F2).
  function fixState(f, fixItems) {
    if (!f.fix) return null;
    const mine = (fixItems || []).filter((i) => new RegExp(`^${f.id}[a-z]$`).test(i.id));
    if (!mine.length) return f.fix.manual ? { txt: 'by hand', cls: 'manual' } : null;
    const approved = mine.filter((i) => i.decision === 'approved' && !i.reverted).length;
    const denied = mine.filter((i) => i.decision === 'denied').length;
    if (approved === mine.length) return { txt: 'fixed', cls: 'done' };
    if (denied === mine.length) return { txt: 'fix denied', cls: 'denied' };
    if (approved || denied) return { txt: `${approved}/${mine.length} applied`, cls: 'partial' };
    return { txt: 'fix pending', cls: 'pending' };
  }

  async function loadAll() {
    const [t, fixes, state] = await Promise.all([
      rli.load(true),
      api(`/task/${bucket}/${taskId}/fixes`).catch(() => ({ items: [] })),
      api(`/task/${bucket}/${taskId}/state`).catch(() => ({})),
    ]);
    return { t, fixItems: fixes.items || [], state };
  }

  function verdictStrip(ev) {
    if (ev.partial) {
      return el('div', { class: 'rev-verdict' },
        el('span', { class: 'rev-pill' }, 'No full eval'),
        el('span', { class: 'rev-verdict__text' }, `${Object.keys(ev.criteria || {}).length} criteria checked individually on the Rubric tab — press Run eval for a verdict.`));
    }
    const [label, cls] = BUCKET[ev.bucket] || [ev.bucket, ''];
    return el('div', { class: `rev-verdict is-${cls}` },
      el('span', { class: `rev-pill is-${cls}` }, label),
      el('span', { class: 'rev-verdict__text' }, ev.verdict || '—'),
      el('span', { class: 'rev-verdict__meta', title: `Eval run ${new Date(ev.generated_at).toLocaleString()}` },
        `${ev.verified?.criteria || 0} criteria checked · ${ev.verified?.artifacts || 0} files opened`));
  }

  // ---------- Review ----------
  async function buildReview(ev) {
    const { t, fixItems, state } = await loadAll();
    const checks = { ...(state.checklist || {}) };
    const panel = decisionPanel(ev.findings.map((f) => ({ id: f.id, sev: f.sev, title: f.headline })), checks, state.verdict, state.verdict_note);
    const root = el('div', { class: 'rev' });
    const scores = el('div', {}, scoreRow(t, fixItems));

    const rows = ev.findings.map((f) => {
      const imp = impact(f, t);
      const st = fixState(f, fixItems);
      const body = el('div', { class: 'rev-row__body', hidden: '' },
        el('div', { class: 'rev-ev' }, el('b', {}, 'Evidence '), inlineMd(f.evidence || '—')),
        f.fix ? el('div', { class: 'rev-fixline' },
          el('b', {}, 'Fix '), el('span', {}, f.fix.summary || '—'),
          el('button', { type: 'button', class: 'rev-link', onclick: () => onOpenTab('remediation', f.id) }, 'Open fix →')) : null);
      const checkBtns = el('span', { class: 'rev-checks' });
      const paintChecks = () => {
        const s = checks[f.id]?.status || '';
        checkBtns.replaceChildren(...[['done', '✓', 'Valid — confirmed'], ['overflag', '⚑', 'Over-flag — not a real issue']].map(([k, glyph, title]) =>
          el('button', { type: 'button', class: `rev-check${s === k ? ' is-on' : ''} rev-check--${k}`, title,
            onclick: async (e) => {
              e.stopPropagation();
              const next = s === k ? '' : k;
              await panel.setCheck(f.id, next);
              if (next) checks[f.id] = { status: next }; else delete checks[f.id];
              paintChecks();
              row.classList.toggle('is-overflag', next === 'overflag');
            } }, glyph)));
      };
      const row = el('div', { class: `rev-row rev-sev-${f.sev}${checks[f.id]?.status === 'overflag' ? ' is-overflag' : ''}`, id: `finding-${f.id}` },
        el('div', { class: 'rev-row__main', role: 'button', tabindex: '0', onclick: () => { body.hidden = !body.hidden; row.classList.toggle('is-open', !body.hidden); } },
          el('span', { class: `sev sev-${f.sev}` }, f.sev),
          dimBtn(f.dim),
          whereBtn(f),
          el('span', { class: 'rev-row__head' }, f.headline),
          el('span', { class: 'rev-imp' }, ...imp.map((x) => el('span', { class: `rev-imp__x ${x.d > 0 ? 'up' : 'down'}` }, `${x.label} ${x.d > 0 ? '+' : ''}${x.d}`))),
          st ? el('span', { class: `rev-fixst is-${st.cls}` }, st.txt) : el('span'),
          checkBtns,
          el('span', { class: 'rev-caret' }, '▸')),
        body);
      paintChecks();
      return row;
    });

    const checksDetails = el('details', { class: 'rev-autochecks' });
    const rollup = (t.checks || []).reduce((a, c) => ((a[c.status] = (a[c.status] || 0) + 1), a), {});
    checksDetails.append(el('summary', {}, `Auto-checks · ${rollup.fail || 0} fail · ${rollup.warn || 0} warn · ${rollup.pass || 0} pass`));
    checksDetails.addEventListener('toggle', async () => {
      if (checksDetails.open && checksDetails.children.length === 1) checksDetails.append(await rli.checksPanel());
    }, { once: false });

    root.append(...[
      verdictStrip(ev),
      scores,
      ev.escalate ? el('div', { class: 'rev-escalate' }, el('b', {}, 'Escalate '), ev.escalate) : null,
      ev.findings.length
        ? el('div', { class: 'rev-list' }, ...rows)
        : el('div', { class: 'rev-empty' }, `No findings — ${ev.verified?.criteria || 0} criteria verified against the artifacts.`),
      ev.manual_checks?.length ? el('div', { class: 'rev-manual' },
        el('div', { class: 'rev-sub' }, 'Check by hand'),
        el('ul', {}, ...ev.manual_checks.map((m) => el('li', {}, m)))) : null,
      ev.validation?.length ? el('div', { class: 'rev-valid', title: ev.validation.join('\n') }, `⚠ ${ev.validation.length} eval output issue${ev.validation.length > 1 ? 's' : ''} survived repair — hover for detail`) : null,
      checksDetails,
      panel].filter(Boolean));
    document.addEventListener('fix-decided', async function onFix() {
      if (!root.isConnected) return document.removeEventListener('fix-decided', onFix);
      const d = await loadAll();
      scores.replaceChildren(scoreRow(d.t, d.fixItems));
    });
    return root;
  }

  // ---------- Remediation ----------
  async function buildRemediation(ev, focusId = null) {
    const { t, fixItems } = await loadAll();
    const withFix = ev.findings.filter((f) => f.fix);
    const root = el('div', { class: 'rev rev--fix' });
    const head = el('div', { class: 'rev-fixhead' });
    const scores = el('div', {}, scoreRow(t, fixItems));
    const paintHead = (items) => {
      const blocks = items.filter((i) => i.kind === 'proposed');
      const done = blocks.filter((i) => i.decision === 'approved' && !i.reverted).length;
      const denied = blocks.filter((i) => i.decision === 'denied').length;
      const manual = withFix.filter((f) => f.fix.manual).length;
      head.replaceChildren(
        el('b', {}, `${withFix.length} fix${withFix.length === 1 ? '' : 'es'}`),
        el('span', { class: 'rev-prog' }, el('span', { style: `width:${blocks.length ? (100 * (done + denied)) / blocks.length : 0}%` })),
        el('span', {}, `${done} applied · ${denied} denied · ${blocks.length - done - denied} to decide${manual ? ` · ${manual} by hand` : ''}`));
    };
    paintHead(fixItems);

    const rows = withFix.map((f) => {
      const md = f.fix.edits.map((e, j) => '```fix\n' + JSON.stringify({ id: `${f.id}${String.fromCharCode(97 + j)}`, rule: f.dim || 'D16', class: f.sev === 'HARD' ? 'hard' : 'soft', status: 'PROPOSED', owner: f.owner, path: e.path, occurrence: 1, old: e.old, new: e.new }) + '\n```').join('\n\n');
      const edits = el('div', { class: 'rev-edits' });
      edits.innerHTML = md ? renderMarkdown(md, { fixControls: true }) : '';
      // Label each block by what it changes — the row already says where.
      edits.querySelectorAll('.fixdoc').forEach((box, j) => {
        const e = f.fix.edits[j];
        const cref = e.crit && e.crit !== f.crit ? `C${e.crit} · ` : '';
        const lab = e.field === 'passed' ? `${cref}${LABEL[e.side]} verdict` : e.field === 'justification' ? `${cref}${LABEL[e.side]} justification` : `${cref}${e.field}`;
        const labEl = el('span', { class: 'fixdoc__label' }, lab);
        box.querySelector('.fixdoc__path')?.remove();
        box.querySelector('.fixdoc__head')?.prepend(labEl);
        if (e.field === 'passed') {
          // Verdict flips read "pass → fail", and wireFixDoc keeps it that way.
          box.dataset.verdict = '1';
          box.classList.add('fixdoc--verdict');
          box.querySelector('.fixdoc__old').textContent = e.old === 'true' ? 'pass' : 'fail';
          box.querySelector('.fixdoc__new').textContent = e.new === 'true' ? 'pass' : 'fail';
        }
      });
      const manual = f.fix.manual ? el('div', { class: 'rev-manualfix' },
        el('div', { class: 'rev-manualfix__bar' }, el('span', {}, 'Apply by hand'),
          el('button', { type: 'button', class: 'btn btn--ghost', onclick: (e) => { navigator.clipboard.writeText(f.fix.manual); e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1200); } }, 'Copy')),
        el('pre', {}, f.fix.manual)) : null;
      const mine = fixItems.filter((i) => new RegExp(`^${f.id}[a-z]$`).test(i.id) && i.kind === 'proposed' && i.decision === 'pending');
      const allBtn = mine.length > 1 ? el('button', { type: 'button', class: 'btn btn--ghost rev-approveall', title: 'Approve every pending edit in this fix',
        onclick: async (ev2) => {
          ev2.target.disabled = true;
          for (const i of mine) {
            try { await api(`/task/${bucket}/${taskId}/fixes/${i.id}/approve`, { method: 'POST', body: {} }); } catch (e) { alert(`${i.id}: ${e.message}`); break; }
          }
          document.dispatchEvent(new CustomEvent('fix-decided', { detail: { id: f.id } }));
          onOpenTab('remediation', f.id);
        } }, `Approve all ${mine.length}`) : null;
      return el('div', { class: `rev-fixrow rev-sev-${f.sev}`, id: `fix-${f.id}` },
        el('div', { class: 'rev-fixrow__head' },
          el('span', { class: `sev sev-${f.sev}` }, f.id),
          whereBtn(f),
          el('span', { class: 'rev-row__head' }, f.fix.summary || f.headline, allBtn),
          el('span', { class: 'rev-imp' }, ...impact(f, t).map((x) => el('span', { class: `rev-imp__x ${x.d > 0 ? 'up' : 'down'}` }, `${x.label} ${x.d > 0 ? '+' : ''}${x.d}`))),
          dimBtn(f.dim)),
        el('div', { class: 'rev-fixrow__why' }, f.headline),
        edits, manual);
    });

    root.append(...[
      ev.escalate ? el('div', { class: 'rev-escalate' }, el('b', {}, 'Escalate instead '), ev.escalate) : null,
      head, scores,
      withFix.length ? el('div', { class: 'rev-fixlist' }, ...rows) : el('div', { class: 'rev-empty' }, 'No fixes required — clean.')].filter(Boolean));
    await decorateFixDocs(root);
    document.addEventListener('fix-decided', async function onFix() {
      if (!root.isConnected) return document.removeEventListener('fix-decided', onFix);
      const d = await loadAll();
      scores.replaceChildren(scoreRow(d.t, d.fixItems));
      paintHead(d.fixItems);
    });
    if (focusId) setTimeout(() => {
      const n = root.querySelector(`#fix-${focusId}`);
      if (n) { n.scrollIntoView({ behavior: 'smooth', block: 'start' }); n.classList.add('flash'); setTimeout(() => n.classList.remove('flash'), 2000); }
    }, 60);
    return root;
  }

  return { buildReview, buildRemediation };
}
