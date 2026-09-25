// Shared helpers: API calls, SSE consumption, markdown with traj:// deep links.

// Liquid-glass refraction: an SVG turbulence+displacement filter referenced by
// backdrop-filter on .glass panels. Chrome renders the refraction; Safari/FF
// fall back to the plain blur (they ignore url() filters in backdrop-filter).
// Injected once per page; only distorts the blurred backdrop, never the panel's
// own content, so text stays crisp.
(function injectGlassFilter() {
  if (typeof document === 'undefined' || document.getElementById('cwt-glass-svg')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'cwt-glass-svg';
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
  svg.innerHTML =
    '<filter id="liquid-glass" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.006 0.009" numOctaves="2" seed="7" result="n"/>' +
    '<feGaussianBlur in="n" stdDeviation="1.2" result="nb"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="nb" scale="22" xChannelSelector="R" yChannelSelector="G"/>' +
    '</filter>';
  (document.body || document.documentElement).appendChild(svg);
})();

export async function api(path, opts = {}) {
  const base = window.__base__ || '';
  const res = await fetch(`${base}/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !location.pathname.endsWith('/login.html')) {
    location.href = `${base}/login.html`;
    throw new Error('login required');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

// POST that returns SSE; calls onEvent for each data: line.
export async function apiSSE(path, body, onEvent) {
  const res = await fetch(`${window.__base__ || ''}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

// rank.json field paths the CB-responses locator understands, as written in
// docs/copilot text (leading slash, e.g. /ranking_rationale or
// /results/blue_tower/grading/correctness).
const RANK_FIELD_RE = /^\/(?:ranking_rationale|preference_rating|problem_statement|optional_clarification_comments|optional_other_comments|results\/[^/\s]+(?:\/(?:summary|rank|model_assignment|grading|failure_modes)(?:\/[^/\s]+){0,2})?)$/;

// Markdown -> sanitized HTML. traj://model_a/12 links become "Show in
// trajectory" buttons; clicks are delegated via the data-traj attributes.
export function renderMarkdown(md, opts = {}) {
  const renderer = new marked.Renderer();

  // Give finding headings (### [HARD] F1 — …) an id so the checklist can deep-link to them.
  const headingBase = renderer.heading;
  renderer.heading = function (textOrToken, level, raw) {
    const isToken = typeof textOrToken === 'object' && textOrToken !== null;
    const lvl = isToken ? textOrToken.depth : level;
    const rawText = isToken ? textOrToken.text : (raw || '');
    const m = lvl === 3 && /\b(F\d{1,3})\b/.exec(rawText);
    if (m) {
      const inner = isToken ? this.parser.parseInline(textOrToken.tokens) : textOrToken;
      return `<h3 id="finding-${m[1]}">${inner}</h3>\n`;
    }
    return headingBase.call(this, textOrToken, level, raw);
  };

  const linkBase = renderer.link;
  // marked v12 calls link(href, title, text); v13+ passes a token object.
  renderer.link = function (hrefOrToken, title, text) {
    const isToken = typeof hrefOrToken === 'object' && hrefOrToken !== null;
    const href = isToken ? hrefOrToken.href : hrefOrToken;
    // marked <13 (the old signature) passes `text` already HTML-escaped, so it
    // must NOT be escaped again — that double-escape is what turned "hello"
    // into &quot;hello&quot;. marked >=13 passes a token whose `.text` is raw,
    // so that branch DOES need escaping. The fallback labels are plain ASCII.
    const explicit = isToken ? hrefOrToken.text : text;
    const labelHtml = isToken ? escapeHtml(hrefOrToken.text || '') : text;
    const hasLabel = explicit && explicit !== href;
    // traj://model_a/12  — jump to a message; optional ?q=<phrase> highlights an
    // exact word/phrase inside that message instead of flashing the whole block.
    const m = /^traj:\/\/(model_[ab])\/(\d+)(?:\?q=(.*))?$/.exec(href || '');
    if (m) {
      const phrase = m[3] ? decodeURIComponent(m[3]) : '';
      const shown = hasLabel ? labelHtml : `${m[1]}[${m[2]}]`;
      const pAttr = phrase ? ` data-traj-phrase="${escapeHtml(phrase)}"` : '';
      return `<a class="traj-link" href="#" data-traj-model="${m[1]}" data-traj-index="${m[2]}"${pAttr}>${shown} </a>`;
    }
    // cb://model_a?q=<phrase>  — point at a word/phrase in a model's responses
    // without a known message index; the phrase is searched across that model's
    // response text and highlighted where found.
    const c = /^cb:\/\/(model_[ab])(?:\?q=(.*))?$/.exec(href || '');
    if (c) {
      const phrase = c[2] ? decodeURIComponent(c[2]) : '';
      const shown = hasLabel ? labelHtml : `${c[1] === 'model_a' ? 'Model A' : 'Model B'} responses`;
      const pAttr = phrase ? ` data-cb-phrase="${escapeHtml(phrase)}"` : '';
      return `<a class="cb-link" href="#" data-cb-model="${c[1]}"${pAttr}>${shown}</a>`;
    }
    const s = /^spec:\/\/([RD]\d{1,2})$/.exec(href || '');
    if (s) {
      const shown = hasLabel ? labelHtml : escapeHtml(s[1]);
      return `<a class="spec-link" href="#" data-spec-key="${s[1]}">${shown}</a>`;
    }
    return linkBase.call(this, hrefOrToken, title, text);
  };

  // ```alerts fences -> big glaring-issue banner ("NONE" suppresses it).
  const codeBase = renderer.code;
  renderer.code = function (codeOrToken, infostring, escaped) {
    const isToken = typeof codeOrToken === 'object' && codeOrToken !== null;
    const lang = (isToken ? codeOrToken.lang : infostring) || '';
    const body = isToken ? codeOrToken.text : codeOrToken;
    if (lang.trim() === 'autoqc') {
      const lines = String(body).split('\n').map((l) => l.trim()).filter((l) => l && l.toUpperCase() !== 'NONE');
      if (!lines.length) return '';
      const items = lines.map((line) => {
        const m = /^([RD]\d{1,2})\s*[—–\-:·]\s*(.+)$/.exec(line);
        if (m) {
          return `<div class="autoqc-item"><a class="spec-link" href="#" data-spec-key="${m[1]}">${m[1]}</a><span class="autoqc-text">${escapeHtml(m[2])}</span></div>`;
        }
        return `<div class="autoqc-item"><span class="autoqc-text">${escapeHtml(line)}</span></div>`;
      });
      return `<div class="autoqc-panel"><div class="autoqc-head">Auto-QC read · ${lines.length} flagged</div>${items.join('')}</div>`;
    }
    // ```fix fences (staging handoff §2.4): the remediation DOC shows the
    // directive as a readable swap — rule, path, struck old, highlighted new —
    // not a line of raw JSON. Read-only here; the Checklist tab is where the
    // decision gets made, and it says so.
    if (lang.trim() === 'fix') {
      try {
        const fix = JSON.parse(body);
        const chip = (txt, cls) => `<span class="${cls}">${escapeHtml(txt)}</span>`;
        const head = [
          fix.id ? chip(fix.id, 'fixdoc__id') : '',
          fix.rule ? `<a class="spec-link" href="#" data-spec-key="${escapeHtml(fix.rule)}">${escapeHtml(fix.rule)}</a>` : '',
          chip(fix.status || '', 'fixdoc__status'),
          fix.meaning_changing ? chip('meaning-changing', 'fixdoc__meaning') : '',
          opts.fixControls ? '<span class="fixdoc__decision"></span>' : '<span class="fixdoc__hint">decide in the Checklist tab</span>',
        ].filter(Boolean).join(' ');
        // With controls on (the task page's remediation doc), each block carries
        // Approve / Edit / Deny and a decision slot — task.js decorateFixDocs()
        // wires them to the fixes API and keeps the state current. Matching key
        // is the block id, with path+old as fallback for APPLIED blocks whose id
        // differs from the seeded ledger id.
        const controls = opts.fixControls && fix.path
          ? '<div class="fixdoc__act">'
            + '<button type="button" class="btn btn--ghost fixdoc-btn" data-fix-action="approve">Approve</button>'
            + '<button type="button" class="btn btn--ghost fixdoc-btn" data-fix-action="edit">Edit</button>'
            + '<button type="button" class="btn btn--ghost fixdoc-btn fixdoc-btn--deny" data-fix-action="deny">Deny</button>'
            + '</div><div class="fixdoc__editor" hidden></div>'
          : '';
        const attrs = `data-fix-id="${escapeHtml(fix.id || '')}" data-fix-status="${escapeHtml(fix.status || '')}"`
          + ` data-fix-path="${escapeHtml(fix.path || '')}" data-fix-occurrence="${Number(fix.occurrence) || 1}"`;
        if (!fix.path) {
          return `<div class="fixdoc" ${attrs}><div class="fixdoc__head">${head}</div>`
            + `<div class="fixdoc__instruction">${escapeHtml(fix.instruction || '(instruction-only fix)')}</div></div>`;
        }
        return `<div class="fixdoc" ${attrs}><div class="fixdoc__head">${head}</div>`
          + `<div class="fixdoc__path">${escapeHtml(fix.path)}</div>`
          + `<div class="fixdoc__old">${escapeHtml(String(fix.old))}</div>`
          + `<div class="fixdoc__new">${fix.new === '' ? '(delete)' : escapeHtml(String(fix.new))}</div>${controls}</div>`;
      } catch { /* unparseable — fall through to a plain code block */ }
    }
    if (lang.trim() === 'alerts') {
      const lines = String(body).split('\n').map((l) => l.trim()).filter((l) => l && l.toUpperCase() !== 'NONE');
      if (!lines.length) return '';
      const items = lines.map((line) => {
        const l = sentenceCaseIfShouting(line);
        const dash = l.indexOf(' — ');
        const title = dash === -1 ? l : l.slice(0, dash);
        const detail = dash === -1 ? '' : l.slice(dash + 3);
        return `<div class="alert-item"><div class="alert-title">${escapeHtml(title)}</div>${
          detail ? `<div class="alert-detail">${escapeHtml(detail)}</div>` : ''
        }</div>`;
      });
      return `<div class="alert-banner"><div class="alert-head">Critical issues</div>${items.join('')}</div>`;
    }
    return codeBase.call(this, codeOrToken, infostring, escaped);
  };

  // Inline `/rank.json field paths` -> clickable chips that jump to that field
  // in the CB responses view (parallel to traj:// / spec://). Field paths carry
  // no HTML-escapable chars, so testing works whether the arg is raw or escaped.
  const codespanBase = renderer.codespan;
  renderer.codespan = function (codeOrToken, ...rest) {
    const isToken = typeof codeOrToken === 'object' && codeOrToken !== null;
    const text = String(isToken ? (codeOrToken.text || '') : codeOrToken);
    if (RANK_FIELD_RE.test(text)) {
      return `<a class="cb-field-link" href="#" data-cb-field-path="${text}">${text}</a>`;
    }
    return codespanBase.call(this, codeOrToken, ...rest);
  };

  let html = marked.parse(md, { renderer, gfm: true, breaks: false });
  // [HARD]/[SOFT]/[INFO] tags in finding headings -> severity badges.
  html = html.replace(/\[(HARD|SOFT|INFO)\]/g, (_, sev) => `<span class="sev sev-${sev}">${sev}</span>`);
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-traj-model', 'data-traj-index', 'data-traj-phrase', 'data-cb-model', 'data-cb-phrase', 'data-cb-field-path', 'data-spec-key', 'id'] });
}

// Legacy docs shipped all-caps alert lines; tame them to sentence case.
function sentenceCaseIfShouting(line) {
  const letters = line.replace(/[^a-zA-Z]/g, '');
  if (!letters || letters.replace(/[^A-Z]/g, '').length / letters.length < 0.7) return line;
  const lower = line.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// A person's name for display. Always title-cased, every time one is shown.
// Separate from cap() because that is used on arbitrary strings and only touches
// the first character — this one capitalises each part, so a two-word or
// hyphenated name doesn't come out half lowercase.
export function personName(s) {
  return String(s ?? '')
    .split(/([ _-]+)/)
    .map((part) => (/^[ _-]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

// Deterministic per-name hue for the initial disc. Was copy-pasted into four
// page scripts; this is the one definition now.
export function avatarHue(name) {
  let hue = 0;
  for (const c of String(name || '')) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return hue;
}

// A person's avatar: their photo when there is one, the initial disc otherwise.
//
// The disc renders FIRST and is swapped for the photo once it loads, rather than
// rendering an <img> and handling its error. Pointing an <img> at a 404 flashes a
// broken-image glyph before any fallback can run, and most users have no photo.
export function avatar(name, { cls = '' } = {}) {
  const label = String(name || '?');
  const disc = el('span', {
    class: ['avatar', cls].filter(Boolean).join(' '),
    style: `background: hsl(${avatarHue(label)} 42% 34%); color: #fff`,
    title: personName(label),
  }, (label[0] || '?').toUpperCase());
  if (!name) return disc;

  const src = `${window.__base__ || ''}/api/avatar/${encodeURIComponent(label.toLowerCase())}`;
  const probe = new Image();
  probe.addEventListener('load', () => {
    disc.replaceWith(el('img', {
      class: ['avatar', 'avatar--photo', cls].filter(Boolean).join(' '),
      src, alt: '', title: personName(label),
    }));
  });
  probe.src = src;
  return disc;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

// replaceChildren() renders a null child as the literal text "null" — unlike
// el(), which skips it. Use this whenever the child list is built conditionally
// (`cond ? node : null`), which is exactly where that bug hides.
export function mount(host, ...children) {
  host.replaceChildren(...children.flat().filter((c) => c != null));
  return host;
}


// ── shared app header ────────────────────────────────────────────────────
// One implementation for every page, so Board / Archive / L12 / Redash / Admin
// can't drift apart. Call it with the nav item to mark current and any
// page-specific controls to drop in before the theme toggle.
const SCALE_LOCKUP = '<svg viewBox="0 0 640.54 121.88" role="img" aria-label="Scale"><path d="M634.74,91.53c2.5-2.94,2.14-7.35-.8-9.84-2.94-2.5-7.35-2.14-9.84.8-7.22,8.49-18.02,13.37-29.64,13.37-19.25,0-34.91-15.66-34.91-34.91s15.66-34.91,34.91-34.91c15.64,0,28.71,11.24,31.55,26.07h-42.72c-3.86,0-6.98,3.13-6.98,6.98s3.12,6.98,6.98,6.98h50.28c3.86,0,6.98-3.13,6.98-6.98v-.93c0-25.41-20.67-46.09-46.09-46.09-26.96,0-48.88,21.93-48.88,48.88s21.93,48.88,48.88,48.88c15.73,0,30.41-6.67,40.28-18.29ZM464.07,102.84v-44.69c0-25.41-20.67-46.09-46.09-46.09-26.95,0-48.88,21.93-48.88,48.88s21.93,48.88,48.88,48.88c3.86,0,6.98-3.13,6.98-6.98s-3.12-6.98-6.98-6.98c-19.25,0-34.91-15.66-34.91-34.91s15.66-34.91,34.91-34.91c17.71,0,32.12,14.41,32.12,32.12v44.69c0,3.86,3.12,6.98,6.98,6.98,3.86,0,6.98-3.13,6.98-6.98ZM252.69,81.89c0-6.82-2.5-16.11-14.43-21.7-7.16-3.35-16.13-4.73-24.82-6.06-20.34-3.12-27.57-5.73-27.57-14.14,0-9.17,12.71-13.97,25.27-13.97,7.91,0,19.29,1.6,28.54,9.2,2.98,2.45,7.38,2.02,9.83-.96,2.45-2.98,2.02-7.38-.96-9.83-12.44-10.23-27.21-12.38-37.41-12.38-26.96,0-39.24,14.48-39.24,27.93,0,6.86,2.51,16.22,14.48,21.84,7.2,3.38,16.21,4.76,24.93,6.1,20.22,3.1,27.4,5.67,27.4,13.95s-9.97,13.97-24.81,13.97-26.77-6.16-32.32-9.83c-3.22-2.13-7.55-1.25-9.68,1.97-2.13,3.22-1.25,7.55,1.97,9.68,11.84,7.84,26.05,12.16,40.02,12.16,26.79,0,38.78-14.03,38.78-27.93ZM353.95,89.21c2.13-3.21,1.26-7.55-1.95-9.68-3.21-2.13-7.55-1.26-9.68,1.95-5.98,9-15.99,14.37-26.77,14.37-19.25,0-34.91-15.66-34.91-34.91s15.66-34.91,34.91-34.91c10.78,0,20.79,5.37,26.77,14.37,2.14,3.21,6.47,4.09,9.68,1.95,3.21-2.13,4.09-6.47,1.95-9.68-8.58-12.91-22.93-20.61-38.4-20.61-26.95,0-48.88,21.93-48.88,48.88s21.93,48.88,48.88,48.88c15.47,0,29.83-7.7,38.4-20.61Z"></path><path d="M528.7,95.84c-17.31-.46-31.25-14.68-31.25-32.1V19.05c0-3.86-3.12-6.98-6.98-6.98-3.86,0-6.98,3.13-6.98,6.98v44.69c0,25.12,20.21,45.6,45.22,46.07,3.86,0,6.98-3.13,6.98-6.98s-3.13-6.98-6.98-6.98Z"></path><path d="M114.88,0H7.01C.78,0-2.34,7.54,2.06,11.94l107.87,107.87c4.41,4.41,11.94,1.29,11.94-4.95V7c0-3.86-3.13-7-7-7Z"></path><path d="M50.31,68.5H3.22c-2.72,0-4.08,3.29-2.16,5.21l47.09,47.09c1.92,1.92,5.21.56,5.21-2.16v-47.09c0-1.69-1.37-3.05-3.05-3.05Z"></path></svg>';

const NAV_ITEMS = [
  { href: '/', label: 'Board', key: 'board' },
  // Sits second: the board stays home, but Overview is the page you open to
  // find out where the project is, so it should be reachable before the
  // drill-down screens rather than after them.
  { href: '/overview.html', label: 'Overview', key: 'overview' },
  // Next to Overview because they answer the two halves of the same question:
  // Overview says where the project is, Team says who is doing something about it.
  { href: '/team.html', label: 'Team', key: 'team' },
  { href: '/archive.html', label: 'Archive', key: 'archive' },
  { href: '/l12.html', label: 'L12 Stats', key: 'l12' },
  { href: '/redash.html', label: 'Redash', key: 'redash' },
  { href: '/admin.html', label: 'Admin', key: 'admin', adminOnly: true },
];

export function renderAppHeader({ active, user, extras = [] } = {}) {
  const host = document.getElementById('app-header');
  if (!host) return;
  const base = window.__base__ || '';
  const lockup = el('div', { class: 'lockup' });
  lockup.innerHTML = SCALE_LOCKUP
    + '<span class="vsep"></span>'
    + '<span class="lockup__name">Audit Studio</span>';

  const nav = el('nav', { class: 'nav' },
    ...NAV_ITEMS
      .filter((n) => !n.adminOnly || user?.role === 'admin')
      .map((n) => el('a', {
        href: base + n.href,
        ...(n.key === active ? { 'aria-current': 'page' } : {}),
      }, n.label)));

  const themeBtn = el('button', {
    class: 'btn btn--icon', type: 'button', 'data-theme-toggle': '', title: 'Switch theme',
  }, document.documentElement.getAttribute('data-theme') === 'light' ? '☾' : '☀');
  themeBtn.addEventListener('click', () => window.toggleTheme(themeBtn));

  const userBlock = user
    ? el('div', { class: 'userblock' },
      avatar(user.username),
      el('span', { class: 'userblock__name' }, personName(user.username)),
      el('button', {
        class: 'btn btn--ghost userblock__out', type: 'button',
        onclick: async () => {
          await api('/logout', { method: 'POST' }).catch(() => {});
          location.href = base + '/login.html';
        },
      }, 'Sign out'))
    : null;

  mount(host, lockup, nav, el('div', { class: 'spacer' }), ...extras, themeBtn, userBlock);
}

// Land a deep link on its exact element: scroll it to center, flash it once,
// consume the hash so a manual reload does not replay the flash. No-ops —
// and keeps the hash for a later call — while the target is missing or still
// hidden, so pages with async panels can call this again as sections arrive.
export function flashHash() {
  const id = (location.hash || '').slice(1);
  if (!id || !/^[A-Za-z][\w-]*$/.test(id)) return false;
  const target = document.getElementById(id);
  if (!target || !target.getClientRects().length) return false;
  target.scrollIntoView({ block: 'center' });
  target.classList.add('hash-flash');
  setTimeout(() => target.classList.remove('hash-flash'), 2200);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

export function fmtTime(ms) {
  return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '';
}

// ---------- guided tour ----------
// startTour([{ selector?, title, body, nextLabel?, onNext?, onShow? }]) — a
// spotlight-overlay walkthrough. Steps whose target is missing/hidden are skipped
// (e.g. admin-only controls), so one step list serves every role. A step with no
// selector is a centered card. onNext() returning true intercepts advance (used
// to navigate pages mid-tour); onShow() runs after the step renders. The tooltip
// is always clamped inside the viewport (picks below/above/right/left by room),
// so it never crops. Next/Back or ← →, Esc to exit.
export function startTour(steps, opts = {}) {
  const isVisible = (e) => e && e.offsetWidth > 0 && e.offsetHeight > 0;
  const valid = steps.filter((s) => !s.selector || isVisible(document.querySelector(s.selector)));
  if (!valid.length) return;
  document.querySelector('.tour-overlay')?.remove();

  let i = 0, poll = null, done = false, exited = false;
  const hole = el('div', { class: 'tour-hole' });
  const tip = el('div', { class: 'tour-tip glass' });
  const overlay = el('div', { class: `tour-overlay${opts.className ? ' ' + opts.className : ''}` }, hole, tip);
  document.body.append(overlay);

  const clearPoll = () => { if (poll) { clearInterval(poll); poll = null; } };
  const cleanup = () => { clearPoll(); window.removeEventListener('resize', place); window.removeEventListener('keydown', onKey); };
  // Leaving a "try" step it wasn't completed = a logged miss.
  const logLeave = () => { const s = valid[i]; if (s && s.try && !done) opts.onLog?.({ step: s.title, action: s.try.action, success: false }); };
  const end = () => { if (exited) return; exited = true; logLeave(); cleanup(); overlay.remove(); opts.onExit?.(); };
  const advance = () => { logLeave(); clearPoll(); if (i >= valid.length - 1) return end(); i++; render(); };
  const back = () => { logLeave(); clearPoll(); if (i > 0) { i--; render(); } };
  function onKey(e) {
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight') advance();
    else if (e.key === 'ArrowLeft') back();
  }

  function place() {
    const s = valid[i];
    const target = s.selector ? document.querySelector(s.selector) : null;
    // No spotlight target (e.g. the opening verdict card) → dim + blur the whole screen.
    overlay.classList.toggle('no-target', !isVisible(target));
    const margin = 12, gap = 14;
    const tipW = tip.offsetWidth || 320;
    const tipH = tip.offsetHeight || 170;
    const clampL = (x) => Math.max(margin, Math.min(x, window.innerWidth - tipW - margin));
    const clampT = (y) => Math.max(margin, Math.min(y, window.innerHeight - tipH - margin));
    tip.style.bottom = '';
    if (isVisible(target)) {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = target.getBoundingClientRect();
      const pad = 6;
      hole.style.display = 'block';
      hole.style.outline = `2px solid ${s.accent || 'var(--blue)'}`; // spotlight ring in the step's color
      hole.style.left = `${r.left - pad}px`;
      hole.style.top = `${r.top - pad}px`;
      hole.style.width = `${r.width + pad * 2}px`;
      hole.style.height = `${r.height + pad * 2}px`;
      // pin: 'top' keeps the tip up top (e.g. so a long draggable board stays visible)
      if (s.pin === 'top') {
        tip.style.left = `${clampL(window.innerWidth / 2 - tipW / 2)}px`;
        tip.style.top = `${margin + 4}px`;
        return;
      }
      const space = { below: window.innerHeight - r.bottom, above: r.top, right: window.innerWidth - r.right, left: r.left };
      let left, top;
      if (space.below >= tipH + gap) { top = r.bottom + gap; left = r.left; }
      else if (space.above >= tipH + gap) { top = r.top - gap - tipH; left = r.left; }
      else if (space.right >= tipW + gap) { left = r.right + gap; top = r.top; }
      else if (space.left >= tipW + gap) { left = r.left - gap - tipW; top = r.top; }
      else { top = r.bottom + gap; left = r.left; } // clamped below as a last resort
      tip.style.left = `${clampL(left)}px`;
      tip.style.top = `${clampT(top)}px`;
    } else {
      hole.style.display = 'none';
      tip.style.left = `${clampL(window.innerWidth / 2 - tipW / 2)}px`;
      tip.style.top = `${clampT(window.innerHeight / 2 - tipH / 2)}px`;
    }
  }

  function render() {
    const s = valid[i];
    done = false;
    clearPoll();
    const status = s.try ? el('div', { class: 'tour-status' }, s.try.hint || 'Try it — I\'ll wait…') : null;
    const primaryBtn = el('button', {
      class: 'primary',
      onclick: () => { if (s.onNext && s.onNext() === true) return; advance(); },
    }, s.nextLabel || (i === valid.length - 1 ? 'Done' : (s.try ? 'Skip step' : 'Next')));

    // Optional per-step accent (color) + kind badge — used by the dynamic copilot
    // guide to color-code trajectory / rank.json / rubric steps. Tour steps omit these.
    tip.style.setProperty('--tour-accent', s.accent || 'var(--edge-strong)');
    tip.classList.toggle('has-accent', !!s.accent);
    // Filter falsy children so a step without `try`/`title` never renders a literal "null".
    tip.replaceChildren(...[
      el('div', { class: 'tour-head' },
        opts.avatar ? el('img', { class: 'tour-avatar', src: opts.avatar, alt: '' }) : null,
        el('div', { class: 'tour-step-count' }, `${i + 1} / ${valid.length}`),
        s.kind ? el('span', { class: 'tour-kind' }, s.kind) : null,
      ),
      s.title ? el('div', { class: 'tour-title' }, s.title) : null,
      el('div', { class: 'tour-body' }, s.body),
      status,
      el('div', { class: 'tour-actions' },
        el('button', { class: 'tour-skip', onclick: end }, opts.exitLabel || 'Skip tour'),
        el('div', { class: 'tour-nav' },
          i > 0 ? el('button', { onclick: back }, 'Back') : null,
          primaryBtn,
        ),
      ),
    ].filter(Boolean));
    place(); // measure + position after content is in the DOM
    if (s.onShow) s.onShow();

    // interactive "try" step: poll until the user completes the action
    if (s.try) {
      let busy = false;
      poll = setInterval(async () => {
        if (busy || done) return;
        busy = true;
        let ok = false;
        try { ok = await s.try.verify(); } catch { /* keep waiting */ }
        busy = false;
        if (ok && !done) {
          done = true;
          clearPoll();
          opts.onLog?.({ step: s.title, action: s.try.action, success: true });
          status.className = 'tour-status ok';
          status.textContent = '✓ Nice — you did it!';
          primaryBtn.textContent = i === valid.length - 1 ? 'Done' : 'Continue ▸';
          primaryBtn.classList.add('ok');
        }
      }, 600);
    }
  }
  window.addEventListener('resize', place);
  window.addEventListener('keydown', onKey);
  render();
}
