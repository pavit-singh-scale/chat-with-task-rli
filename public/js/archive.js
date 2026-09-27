import { api, el, cap, renderAppHeader, avatar, personName } from './common.js';
import { mountAcey } from './acey.js';

const SEV_LABEL = { HARD_FAIL: 'Hard', SOFT_FAIL: 'Soft', PASS: 'Pass', UNSORTED: 'Unsorted' };
const VERDICT_LABELS = {
  NO_ISSUES: 'No Issues',
  FIXES_MADE: 'Fixes made',
  SBQ: 'SBQ',
  SECOND_OPINION: 'Second Opinion Needed',
};

let me = null;
let tasks = [];
const searchInput = document.getElementById('archive-search');


async function restore(t, card) {
  if (!confirm(`Restore task ${t.id} to the board? It will reappear in its ${SEV_LABEL[t.bucket]} lane and leave the archive.`)) return;
  try {
    await api('/admin/undeliver', { method: 'POST', body: { taskIds: [t.id] } });
    tasks = tasks.filter((x) => x.id !== t.id);
    card.classList.add('removing');
    setTimeout(render, 180);
  } catch (err) {
    alert(err.message);
  }
}

function archiveCard(t) {
  const card = el('div', { class: `ticket archive-card accent-${t.bucket} seen` });
  const open = () => { location.href = (window.__base__ || '') + `/task/${t.bucket}/${t.id}`; };

  card.append(
    el('div', { class: 'ticket-top', onclick: open },
      el('span', { class: `sev-tag accent-${t.bucket}` }, SEV_LABEL[t.bucket] || t.bucket),
      el('span', { class: 'spacer' }),
      el('span', { class: 'delivered-mark', title: 'archived / delivered' }, 'archived'),
    ),
    el('div', { class: 'tid', onclick: open }, t.id),
    t.problem ? el('div', { class: 'prob', onclick: open }, t.problem) : null,
    el('div', { class: 'archive-meta' },
      t.verdict ? el('span', { class: `chip v-${t.verdict}` }, VERDICT_LABELS[t.verdict] || t.verdict) : null,
      t.grammar ? el('span', { class: 'chip grammar-chip', title: 'Spelling/Grammar Issues' }, '✎ Spelling/Grammar') : null,
      t.annotator ? el('span', { class: 'chip', title: 'annotator' }, `@${t.annotator}`) : null,
    ),
    el('div', { class: 'ticket-foot archive-foot' },
      el('span', { class: 'archive-when' },
        t.deliveredAt ? `Archived ${t.deliveredAt.slice(0, 10)}` : 'Archived',
        t.deliveredBy ? el('span', { class: 'archive-by' },
          avatar(t.deliveredBy, { cls: 'avatar--sm' }),
          personName(t.deliveredBy)) : null,
      ),
      el('span', { class: 'spacer' }),
      el('button', { class: 'quiet archive-open', onclick: open, title: 'open task (view only)' }, 'View'),
      me?.role === 'admin'
        ? el('button', { class: 'quiet', onclick: () => restore(t, card), title: 'return this task to the active board' }, 'Restore')
        : null,
    ),
  );
  return card;
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const shown = tasks.filter((t) =>
    !q ||
    t.id.toLowerCase().includes(q) ||
    String(t.problem || '').toLowerCase().includes(q) ||
    String(t.annotator || '').toLowerCase().includes(q) ||
    String(t.verdict || '').toLowerCase().includes(q));

  const grid = document.getElementById('archive-grid');
  grid.replaceChildren(...shown.map(archiveCard));

  const empty = document.getElementById('archive-empty');
  if (!tasks.length) {
    empty.hidden = false;
    empty.textContent = 'Nothing archived yet. From the Admin Console, move completed tasks to the archive.';
  } else if (!shown.length) {
    empty.hidden = false;
    empty.textContent = `No archived task matches “${searchInput.value.trim()}”.`;
  } else {
    empty.hidden = true;
  }

  document.getElementById('archive-count').textContent =
    q ? `${shown.length} of ${tasks.length} archived` : `${tasks.length} archived`;
}

searchInput.addEventListener('input', render);

// ---------- boot ----------
me = await api('/me');
renderAppHeader({ active: 'archive', user: me });

const q0 = new URLSearchParams(location.search).get('q');
if (q0) searchInput.value = q0;

({ tasks } = await api('/archive'));
render();


// Acey is available from every page, not just inside a task.
mountAcey({ page: 'archive' });
