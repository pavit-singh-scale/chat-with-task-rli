// RLI task page: Brief · Deliverables · Rubric · Preference · Checks.
// Replaces the ACC trajectory / CB-responses views for tasks that carry a
// task.json (the RLI record). Everything renders from GET /task/:b/:id/rli and
// streams artifacts from /raw so images, video, audio, PDFs and 3D open inline.
import { api, el, mount, renderMarkdown } from './common.js';

const BASE = () => window.__base__ || '';
const SIDE_LABEL = { input: 'Inputs', golden: 'RD', ad1: 'AD1', ad2: 'AD2' };
const SIDE_LONG = { input: 'Brief inputs', golden: 'Reference deliverable', ad1: 'Model attempt 1', ad2: 'Model attempt 2' };
const KIND_ORDER = ['image', 'video', 'audio', 'pdf', 'model3d', 'cad', 'design', 'doc', 'sheet', 'text', 'archive', 'other'];
const KIND_LABEL = { image: 'Images', video: 'Video', audio: 'Audio', pdf: 'PDF', model3d: '3D models', cad: 'CAD / scene files', design: 'Design files', doc: 'Documents', sheet: 'Spreadsheets', text: 'Text & code', archive: 'Archives', other: 'Other' };
const GATE = { golden: 97, ad1: 70, ad2: 50 };

export function createRli({ bucket, taskId, onCrit, onSpec, onOpenDoc, onCompare }) {
  let cache = null;
  const load = async (refresh = false) => {
    if (!cache || refresh) cache = api(`/task/${bucket}/${taskId}/rli`);
    return cache;
  };
  const rawUrl = (p, dl) => `${BASE()}/api/task/${bucket}/${taskId}/raw?path=${encodeURIComponent(p)}${dl ? '&download=1' : ''}`;
  const fmtSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
  const pct = (v) => (v == null ? '—' : `${Math.round(v * 100) / 100}%`);

  // ---------- small pieces ----------
  const statusIcon = { pass: '✓', fail: '✕', warn: '!', info: 'i', na: '–' };
  const specChip = (key) => key
    ? el('button', { type: 'button', class: 'rli-spec', 'data-spec-key': key, title: `Open ${key} in the QC spec`, onclick: (e) => { e.preventDefault(); onSpec(key); } }, key)
    : null;
  const critChip = (anchor) => {
    const n = String(anchor).replace('crit://C', '');
    return el('button', { type: 'button', class: 'rli-critchip', onclick: () => onCrit(Number(n)) }, `C${n}`);
  };
  function modelLine(t, side) {
    if (side === 'golden') return 'Human expert';
    return t.models[side] || '—';
  }

  // ---------- summary bar (above the tabs, once per task) ----------
  // The numbers that decide a task — the three scores against their gates, the
  // criteria count, the weight mix and the auto-check result — in one strip.
  function gateStat(t, side) {
    const v = t.scores?.[side]?.percentage;
    const gate = GATE[side];
    let state = 'na', sub = side === 'golden' ? `gate ≥ ${gate}` : `gate ≤ ${gate}`;
    if (v != null) {
      const margin = side === 'golden' ? v - gate : gate - v;
      state = margin < 0 ? 'bad' : side !== 'golden' && margin <= 3 ? 'warn' : 'ok';
      const m = Math.abs(Math.round(margin * 10) / 10);
      sub = margin < 0
        ? `${m} ${side === 'golden' ? 'under' : 'over'} the ${gate} gate`
        : side === 'golden' ? `clears ≥${gate}` : `${m} pts under ≤${gate}`;
    }
    return el('div', { class: `rli-stat is-${state}`, title: side === 'golden' ? 'Human reference deliverable' : modelLine(t, side) },
      el('div', { class: 'rli-stat__k' }, SIDE_LABEL[side], side !== 'golden' ? el('span', {}, modelLine(t, side)) : null),
      el('div', { class: 'rli-stat__v' }, v == null ? '—' : `${Math.round(v * 10) / 10}`, v == null ? null : el('small', {}, '%')),
      el('div', { class: 'rli-stat__s' }, sub),
    );
  }

  function summaryBar(t, { queue = null, onChecks } = {}) {
    const mixCheck = t.checks.find((c) => c.id === 'weights');
    const mix = mixCheck?.mix;
    const n = (st) => t.checks.filter((c) => c.status === st).length;
    const fails = t.checks.filter((c) => c.status === 'fail');
    const mixSeg = (b, v) => el('i', { class: `b-${b}`, style: `flex:${Math.max(v || 0, 0.001)}` });
    return el('div', { class: 'rli-sum' },
      el('div', { class: 'rli-sum__id' },
        el('div', { class: 'rli-sum__meta' },
          el('span', { class: 'rli-sum__domain' }, t.domain || 'Unknown domain'),
          t.timeline ? el('span', {}, t.timeline.replace(/\s*\(.*\)/, '')) : null,
          queue?.n ? el('span', {}, `${queue.n} of ${queue.total} in your queue`) : null),
        el('div', { class: 'rli-sum__title', title: t.title }, t.title || '(no brief in this record)'),
        t.missing.some((m) => !['timeline', 'inputs block'].includes(m))
          ? el('div', { class: 'rli-sum__warn' }, `Record incomplete — missing ${t.missing.join(', ')}`) : null,
      ),
      el('div', { class: 'rli-sum__stats' },
        gateStat(t, 'golden'), gateStat(t, 'ad1'), gateStat(t, 'ad2'),
        mix ? el('div', { class: `rli-stat rli-stat--mix is-${mixCheck.status === 'fail' ? 'bad' : mixCheck.status === 'warn' ? 'warn' : 'ok'}`, title: `Format ${mix.format}% · Brief ${mix.brief}% · Quality ${mix.quality}% of positive weight (target 5 / 30 / 65)` },
          el('div', { class: 'rli-stat__k' }, 'Weight mix'),
          el('div', { class: 'rli-stat__v' }, `${mix.quality}`, el('small', {}, '% quality')),
          el('div', { class: 'rli-stat__s' }, mix.quality >= 65 ? 'clears ≥65' : `${Math.round((65 - mix.quality) * 10) / 10} under the 65 gate`),
          el('div', { class: 'rli-minimix' }, mixSeg('format', mix.format), mixSeg('brief', mix.brief), mixSeg('quality', mix.quality), mix.other ? mixSeg('other', mix.other) : null, el('b', {}))) : null,
      ),
    );
  }

  // ---------- Brief ----------
  // The brief is the thing being read, so it gets a centred reading column;
  // the reference files follow as one uniform gallery underneath.
  async function buildBrief() {
    const t = await load();
    const paths = t.checks.find((c) => c.id === 'paths')?.paths;
    const unlisted = new Set((paths?.unlisted || []).map((f) => f.rel));
    const sections = t.briefSections.length
      ? t.briefSections.map((s) => {
        const body = el('div', { class: 'cb-prose' });
        body.innerHTML = renderMarkdown(s.body || '_(empty)_');
        return el('section', { class: 'rli-brief__sec' }, el('h4', {}, s.heading), body);
      })
      : [el('div', { class: 'callout warn' }, 'This record has no brief.')];
    const inputs = t.files.input;
    const visual = inputs.filter((f) => ['image', 'video'].includes(f.kind));
    const other = inputs.filter((f) => !['image', 'video'].includes(f.kind));
    return el('div', { class: 'rli rli-brief' },
      el('article', { class: 'rli-brief__doc' }, ...sections),
      el('section', { class: 'rli-refs' },
        el('header', { class: 'rli-refs__head' },
          el('h4', {}, 'Reference files'),
          el('span', { class: 'rli-refs__n' }, `${inputs.length}${t.inputsDeclared != null && t.inputsDeclared !== inputs.length ? ` · record says ${t.inputsDeclared}` : ''}`),
          unlisted.size ? el('span', { class: 'rli-refs__flag' }, `${unlisted.size} not named in the brief`) : null,
          paths?.problems?.length ? el('span', { class: 'rli-refs__flag is-fail' }, `${paths.problems.length} brief path${paths.problems.length > 1 ? 's' : ''} don't resolve`) : null),
        paths?.problems?.length ? el('div', { class: 'rli-probs' }, paths.problems.map((p) => el('div', { class: `rli-prob is-${p.sev}` }, p.text))) : null,
        inputs.length ? null : el('div', { class: 'hint-line' }, 'No input files.'),
        visual.length ? el('div', { class: 'rli-gallery' }, visual.map((f) => fileTile(t, f, { mark: unlisted.has(f.rel) ? 'not in brief' : null, list: inputs }))) : null,
        other.length ? fileList(t, other, inputs, unlisted) : null,
      ),
    );
  }

  // ---------- file tiles + viewers ----------
  function fileTile(t, f, { mark = null, list = null } = {}) {
    const open = () => openViewer(t, f, list || [f]);
    let face;
    if (f.kind === 'image') face = el('img', { src: rawUrl(f.path), loading: 'lazy', alt: f.name });
    else face = el('div', { class: `rli-tile__glyph k-${f.kind}` }, glyph(f.kind), el('span', {}, (f.name.split('.').pop() || '').toUpperCase()));
    return el('button', { type: 'button', class: `rli-tile k-${f.kind}`, title: `${f.rel} · ${fmtSize(f.size)}`, onclick: open },
      el('div', { class: 'rli-tile__face' }, face),
      el('div', { class: 'rli-tile__name' }, f.rel),
      mark ? el('span', { class: 'rli-tile__mark' }, mark) : null,
    );
  }
  function glyph(kind) {
    return ({ video: '▶', audio: '♪', pdf: '▤', model3d: '⬡', cad: '⌂', design: '✎', doc: '▤', sheet: '▦', text: '⟨⟩', archive: '⧉' })[kind] || '•';
  }

  // Non-visual files read better as a list than as big glyph tiles.
  function fileList(t, files, list, unlisted = new Set()) {
    return el('div', { class: 'rli-flist' }, files.map((f) => el('button', { type: 'button', class: 'rli-frow', onclick: () => openViewer(t, f, list), title: f.rel },
      f.derived && (f.derived.thumb || ['image', 'drawing'].includes(f.derived.kind))
        ? el('img', { class: 'rli-frow__thumb', src: rawUrl(f.derived.thumb || f.derived.path), alt: '', loading: 'lazy' })
        : el('span', { class: `rli-ext k-${f.kind}` }, (f.name.split('.').pop() || '').toUpperCase().slice(0, 4)),
      el('span', { class: 'rli-frow__name' }, f.rel),
      unlisted.has(f.rel) ? el('span', { class: 'rli-tile__mark rli-tile__mark--inline' }, 'not in brief') : null,
      el('span', { class: 'rli-frow__size' }, fmtSize(f.size)))));
  }

  const MODEL_PREF = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply'];
  function primaryModel(files) {
    const native = files.filter((f) => f.kind === 'model3d');
    const derived = files.filter((f) => f.derived?.kind === 'model3d').map((f) => ({ ...f, viewPath: f.derived.path }));
    const models = native.length ? native : derived;
    return models.sort((a, b) => MODEL_PREF.indexOf((a.viewPath || a.name).split('.').pop().toLowerCase()) - MODEL_PREF.indexOf((b.viewPath || b.name).split('.').pop().toLowerCase()))[0] || null;
  }

  // One side (RD / AD1 / AD2 / inputs): the 3D model leads — it's what these
  // tasks are graded on — then renders, then media, then everything else.
  // "2:23 · 1280×720 · 30 fps · 48 kHz 24-bit stereo · peak −4.7 dB" + flags.
  function mediaLine(f) {
    const m = f.media;
    if (!m) return null;
    const dur = m.duration_s != null ? `${Math.floor(m.duration_s / 60)}:${String(Math.round(m.duration_s % 60)).padStart(2, '0')}` : null;
    const v = m.video, a = m.audio;
    const bits = [
      dur,
      v && `${v.width}×${v.height}`, v?.fps && `${v.fps} fps`,
      a && [a.sample_rate && `${a.sample_rate / 1000} kHz`, a.bit_depth && `${a.bit_depth}-bit`, a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : a.channels && `${a.channels} ch`].filter(Boolean).join(' '),
      a?.peak_db != null && `peak ${a.peak_db} dB`,
      v && !a && 'no audio',
    ].filter(Boolean);
    return el('div', { class: 'rli-mline' },
      el('span', {}, bits.join(' · ')),
      ...(m.flags || []).map((x) => el('span', { class: 'rli-mline__flag' }, x)));
  }

  function sideColumn(t, side, { dense = false } = {}) {
    const files = t.files[side] || [];
    const of = (k) => files.filter((f) => f.kind === k);
    const model = primaryModel(files);
    const images = of('image');
    const videos = of('video');
    const audio = of('audio');
    const pdfs = of('pdf');
    const rest = files.filter((f) => !['image', 'video', 'audio', 'pdf'].includes(f.kind));
    const v = t.scores?.[side]?.percentage;
    const group = (label, n, node) => el('div', { class: 'rli-group' }, el('div', { class: 'rli-group__lbl' }, label, el('span', {}, String(n))), node);
    return el('section', { class: `rli-col side-${side}` },
      el('header', { class: 'rli-col__head' },
        el('b', {}, SIDE_LABEL[side]),
        el('span', { class: 'rli-col__model' }, side === 'input' ? SIDE_LONG.input : modelLine(t, side)),
        el('span', { class: 'spacer' }),
        side !== 'input' && v != null ? el('span', { class: 'rli-col__pct' }, pct(v)) : null),
      files.length ? null : el('div', { class: 'hint-line rli-col__empty' }, 'No files delivered.'),
      model ? el('div', { class: 'rli-hero' },
        el('div', { class: 'rli-hero__stage' }, lazyModel(model),
          el('button', { type: 'button', class: 'rli-fsbtn', title: 'Open full screen', onclick: () => openViewer(t, model, files, { fullscreen: true }) }, el('span', { 'aria-hidden': 'true' }, '⤢'), 'Full screen')),
        el('div', { class: 'rli-hero__open' }, `${model.name}${model.viewPath ? ' · converted to GLB' : ''}`)) : scenePreview(t, files),
      images.length ? group('Renders & images', images.length, el('div', { class: `rli-tiles${dense ? ' rli-tiles--dense' : ''}` }, images.map((f) => fileTile(t, f, { list: files })))) : null,
      videos.length ? group('Video', videos.length, el('div', { class: 'rli-vids' }, videos.map((f) => el('div', { class: 'rli-vid' },
        el('video', { src: rawUrl(f.path), controls: '', preload: 'metadata' }),
        el('button', { type: 'button', class: 'rli-frow__name', onclick: () => openViewer(t, f, files) }, f.rel),
        mediaLine(f))))) : null,
      audio.length ? group('Audio', audio.length, el('div', { class: 'rli-audio' }, audio.map((f) => el('div', { class: 'rli-audio__row' },
        el('span', { class: 'rli-audio__name', title: f.rel }, f.rel),
        el('audio', { controls: '', preload: 'none', src: rawUrl(f.path) }),
        mediaLine(f))))) : null,
      pdfs.length ? group('PDF', pdfs.length, fileList(t, pdfs, files)) : null,
      rest.length ? group('Source & other files', rest.length, fileList(t, rest, files)) : null,
    );
  }

  // No 3D in the browser for this side — show the scene file's embedded preview.
  function scenePreview(t, files) {
    const f = files.find((x) => x.derived?.kind === 'image');
    if (!f) return null;
    return el('div', { class: 'rli-hero' },
      el('div', { class: 'rli-hero__stage rli-hero__stage--img' }, el('img', { src: rawUrl(f.derived.path), alt: f.name, onclick: () => openViewer(t, f, files) })),
      el('button', { type: 'button', class: 'rli-hero__open', onclick: () => openViewer(t, f, files), title: f.derived.label }, `${f.name} · saved preview ↗`));
  }

  // Inline 3D viewer that only boots when scrolled into view.
  function lazyModel(f) {
    const holder = el('div', { class: 'rli-lazy3d' }, el('span', {}, 'Loading 3D…'));
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { io.disconnect(); holder.replaceChildren(model3d(f, true)); }
    });
    requestAnimationFrame(() => io.observe(holder));
    return holder;
  }

  // ---------- Deliverables ----------
  // Two ways in: BY ARTIFACT (one deliverable at a time, RD | AD1 | AD2 at
  // equal size — the comparison graders actually make) and BY SIDE (each
  // side's whole delivery in a column). Inputs live here too, as a third view.
  let delivMode = 'artifact';
  const delivState = { slot: 0, layout: 'sbs', side: 'golden' };
  const KIND_NAME = { model3d: '3D model', cad: 'CAD / scene file', image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF', design: 'Design file', sheet: 'Spreadsheet', doc: 'Document', text: 'Text', archive: 'Archive', other: 'File' };
  const KIND_RANK = ['model3d', 'cad', 'image', 'video', 'audio', 'pdf', 'design', 'sheet', 'doc', 'text', 'archive', 'other'];
  const normName = (n) => n.toLowerCase().replace(/\.[^.]+$/, '').replace(/[\s_\-.]+/g, '').replace(/v?\d{3}$|final$/g, '');
  // Model-run notes aren't a deliverable the golden could have; they'd read as "RD missing".
  const isRunNote = (f) => /^generation[_ -]?notes/i.test(f.name);

  // What an image IS, from its name — so "Render01.jpg" pairs with
  // "render_01_front_upright.jpg" and never with a UV sheet or a wireframe.
  const IMG_CATS = [
    ['UV layout', /\buv|uv[_ -]?layout|unwrap/i],
    ['Wireframe', /wire/i],
    ['Materials', /material|texture|swatch|palette|moodboard/i],
    ['Drawing', /plan|section|elevation[_ -]?drawing|drawing|sheet/i],
    ['Render', /render|view|shot|persp|front|rear|side|aerial|street|exterior|interior|hero|beauty|turntable|cam/i],
  ];
  const imageCat = (name) => (IMG_CATS.find(([, re]) => re.test(name)) || ['Image'])[0];
  const firstNum = (name) => { const m = name.match(/(\d+)/); return m ? Number(m[1]) : Infinity; };

  // Match one deliverable across the three sides. 3D/CAD pair by format
  // (BUILDING.3ds ↔ BUILDING.3ds, .fbx ↔ .fbx); images by what they are, then
  // their number (Render01 ↔ render_01_front…); a name match is trusted only
  // when the golden is part of it, so two ADs sharing a name can't shift RD.
  function artifactSlots(t) {
    const sides = ['golden', 'ad1', 'ad2'];
    const groups = new Map();
    for (const s of sides) {
      for (const f of t.files[s] || []) {
        if (isRunNote(f)) continue;
        const ext = (f.name.split('.').pop() || '').toLowerCase();
        const cat = ['model3d', 'cad'].includes(f.kind) ? `${KIND_NAME[f.kind]} · ${ext.toUpperCase()}` : f.kind === 'image' ? imageCat(f.name) : KIND_NAME[f.kind];
        const key = `${f.kind}:${cat}`;
        if (!groups.has(key)) groups.set(key, { kind: f.kind, cat, files: { golden: [], ad1: [], ad2: [] } });
        groups.get(key).files[s].push(f);
      }
    }
    const CAT_RANK = ['Render', 'Drawing', 'Materials', 'Wireframe', 'UV layout', 'Image'];
    const slots = [];
    const ordered = [...groups.values()].sort((x, y) => KIND_RANK.indexOf(x.kind) - KIND_RANK.indexOf(y.kind)
      || CAT_RANK.indexOf(x.cat) - CAT_RANK.indexOf(y.cat) || x.cat.localeCompare(y.cat));
    for (const g of ordered) {
      const byNum = (x, y) => firstNum(x.name) - firstNum(y.name) || x.rel.localeCompare(y.rel, undefined, { numeric: true });
      const pools = Object.fromEntries(sides.map((s) => [s, [...g.files[s]].sort(byNum)]));
      const rows = [];
      for (const f of [...pools.golden]) {
        const hit = { golden: f };
        for (const s of ['ad1', 'ad2']) { const m = pools[s].find((x) => normName(x.name) === normName(f.name)); if (m) hit[s] = m; }
        if (Object.keys(hit).length < 2) continue;
        rows.push(hit);
        for (const s of sides) if (hit[s]) pools[s] = pools[s].filter((x) => x !== hit[s]);
      }
      const n = Math.max(...sides.map((s) => pools[s].length));
      for (let i = 0; i < n; i++) rows.push(Object.fromEntries(sides.map((s) => [s, pools[s][i]]).filter(([, f]) => f)));
      rows.forEach((r, i) => {
        const any = r.golden || r.ad1 || r.ad2;
        slots.push({ id: `${g.cat.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i + 1}`, label: rows.length > 1 ? `${g.cat} ${i + 1}` : g.cat, kind: g.kind, name: any.name, files: r });
      });
    }
    return slots;
  }
  const fileFlags = (f) => [
    ...(f.media?.flags || []),
    f.media?.video && f.media.video.height && f.media.video.height < 720 ? `low resolution (${f.media.video.width}×${f.media.video.height})` : null,
  ].filter(Boolean);
  const slotMark = (f) => (!f ? { g: '–', cls: 'is-missing', t: 'not delivered' } : fileFlags(f).length ? { g: '!', cls: 'is-flag', t: fileFlags(f).join('; ') } : { g: '✓', cls: 'is-ok', t: 'delivered' });

  function artifactView(t) {
    const slots = artifactSlots(t);
    if (!slots.length) return el('div', { class: 'callout warn' }, 'No deliverables in this record.');
    delivState.slot = Math.min(delivState.slot, slots.length - 1);
    const rail = el('nav', { class: 'art-rail', 'aria-label': 'Deliverables' });
    const main = el('div', { class: 'art-main' });
    const sides = ['golden', 'ad1', 'ad2'];
    const pane = (s, f, big = false) => el('div', { class: `art-pane${f ? '' : ' is-missing'}${big ? ' is-big' : ''}` },
      el('div', { class: 'art-pane__head' }, el('b', {}, SIDE_LABEL[s]), el('span', {}, modelLine(t, s))),
      f ? el('div', { class: 'art-pane__stage', onclick: (e) => { if (['image'].includes(f.kind) && e.target.tagName === 'IMG') openViewer(t, f, t.files[s]); } }, mediaNode(f, { compact: !big }))
        : el('div', { class: 'art-pane__none' }, el('b', {}, 'Not delivered'), el('span', {}, `${SIDE_LABEL[s]} has no matching ${KIND_NAME[slots[delivState.slot].kind].toLowerCase()}`)),
      f ? el('div', { class: 'art-pane__meta' },
        el('button', { type: 'button', class: 'art-pane__name', title: 'Open in the viewer', onclick: () => openViewer(t, f, t.files[s]) }, f.rel),
        el('span', {}, fmtSize(f.size)),
        f.media ? mediaLine(f) : null) : null,
      f && fileFlags(f).length ? el('div', { class: 'art-pane__flags' }, fileFlags(f).map((x) => el('span', {}, x))) : null);

    const render = () => {
      const slot = slots[delivState.slot];
      rail.replaceChildren(el('div', { class: 'art-rail__lbl' }, 'Deliverables', el('span', {}, 'RD · AD1 · AD2')),
        ...slots.map((sl, i) => el('button', { type: 'button', class: `art-slot${i === delivState.slot ? ' is-on' : ''}`, 'data-slot': sl.id,
          onclick: () => { delivState.slot = i; render(); } },
          el('span', { class: 'art-slot__name' }, el('b', {}, sl.label), el('span', {}, sl.name)),
          el('span', { class: 'art-slot__marks' }, sides.map((s) => { const m = slotMark(sl.files[s]); return el('i', { class: m.cls, title: `${SIDE_LABEL[s]}: ${m.t}` }, m.g); })))));
      requestAnimationFrame(() => rail.querySelector('.art-slot.is-on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
      const layoutSeg = el('div', { class: 'seg rli-seg' },
        ...[['sbs', 'Side by side'], ['one', 'One at a time']].map(([k, l]) => el('button', { type: 'button', 'aria-pressed': String(delivState.layout === k), onclick: () => { delivState.layout = k; render(); } }, l)));
      const head = el('div', { class: 'art-head' },
        el('div', { class: 'art-head__t' }, el('h3', {}, slot.label), el('span', {}, `${delivState.slot + 1} of ${slots.length} · ← → to step${delivState.layout === 'one' ? ' · 1 2 3 to pick a side' : ''}`)),
        el('span', { class: 'spacer' }), layoutSeg);
      if (delivState.layout === 'sbs') {
        main.replaceChildren(head, el('div', { class: 'art-panes' }, sides.map((s) => pane(s, slot.files[s]))));
      } else {
        const tabs = el('div', { class: 'seg rli-seg art-sidetabs' }, sides.map((s, i) => el('button', { type: 'button', 'aria-pressed': String(delivState.side === s),
          onclick: () => { delivState.side = s; render(); } }, `${i + 1} · ${SIDE_LABEL[s]}`, slotMark(slot.files[s]).cls === 'is-missing' ? ' (none)' : '')));
        main.replaceChildren(head, tabs, pane(delivState.side, slot.files[delivState.side], true));
      }
    };
    render();
    const root = el('div', { class: 'art' }, rail, main);
    const onKeys = (e) => {
      if (!root.isConnected) return document.removeEventListener('keydown', onKeys);
      if (lb || e.target.closest?.('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { delivState.slot = Math.min(slots.length - 1, delivState.slot + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { delivState.slot = Math.max(0, delivState.slot - 1); render(); e.preventDefault(); }
      else if (['1', '2', '3'].includes(e.key)) { delivState.side = sides[Number(e.key) - 1]; delivState.layout = 'one'; render(); }
    };
    document.addEventListener('keydown', onKeys);
    root.selectSlot = (id) => { const i = slots.findIndex((x) => x.id === id); if (i >= 0) { delivState.slot = i; render(); } return i >= 0; };
    root.slotId = () => slots[delivState.slot]?.id;
    return root;
  }

  async function buildDeliverables() {
    const t = await load();
    const body = el('div', { class: 'rli-deliv__body' });
    const seg = el('div', { class: 'seg rli-seg', role: 'group' });
    const modes = [
      ['artifact', 'By artifact'],
      ['compare', 'By side'],
      ['input', `Inputs (${t.files.input.length})`],
    ];
    if (!modes.some(([m]) => m === delivMode)) delivMode = 'artifact';
    const render = () => {
      for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.mode === delivMode));
      if (delivMode === 'artifact') mount(body, artifactView(t));
      else if (delivMode === 'compare') mount(body, el('div', { class: 'rli-cols' }, sideColumn(t, 'golden', { dense: true }), sideColumn(t, 'ad1', { dense: true }), sideColumn(t, 'ad2', { dense: true })));
      else mount(body, el('div', { class: 'rli-cols rli-cols--one' }, sideColumn(t, delivMode)));
    };
    for (const [m, label] of modes) {
      seg.append(el('button', { type: 'button', 'data-mode': m, 'aria-pressed': 'false', onclick: () => { delivMode = m; render(); } }, label));
    }
    render();
    const root = el('div', { class: 'rli rli-deliv' },
      el('div', { class: 'rli-toolbar', title: 'Click any file to open it. In the viewer ← → step through a side; C compares the same file across RD / AD1 / AD2.' }, seg),
      body,
    );
    root.selectSlot = (id) => { delivMode = 'artifact'; render(); return body.firstChild?.selectSlot?.(id); };
    return root;
  }

  // ---------- lightbox viewer ----------
  let lb = null;
  function closeViewer() { if (document.fullscreenElement === lb) document.exitFullscreen?.().catch(() => {}); lb?.remove(); lb = null; lbState = null; document.removeEventListener('keydown', onKey, true); }
  let lbState = null;
  function onKey(e) {
    if (!lbState || !lb) return;
    if (e.target.closest?.('input, textarea')) return;
    const k = e.key;
    if (k === 'Escape') closeViewer();
    else if (k === 'ArrowRight' || k === 'ArrowDown') step(1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp') step(-1);
    else if (k.toLowerCase() === 'c') toggleCompare();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  function step(d) {
    const { list, i } = lbState;
    const j = (i + d + list.length) % list.length;
    lbState.i = j;
    renderViewer();
  }
  function toggleCompare() { lbState.compare = !lbState.compare; renderViewer(); }

  function openViewer(t, f, list, { fullscreen = false } = {}) {
    closeViewer();
    lbState = { t, list, i: Math.max(0, list.findIndex((x) => x.path === f.path)), compare: false };
    // Any click that lands on empty backdrop — not on the media or a control — closes.
    lb = el('div', { class: 'rli-lb', onclick: (e) => {
      if (e.target.closest('img, video, audio, iframe, canvas, pre, button, a, .rli-media--none, .rli-lb__bar, .rli-3d__tools')) return;
      closeViewer();
    } });
    document.body.append(lb);
    document.addEventListener('keydown', onKey, true);
    renderViewer();
    if (fullscreen) lb.requestFullscreen?.().catch(() => {});
  }

  // Same file on the other sides: exact name, else same position among files of that kind.
  function counterparts(t, f) {
    const side = f.path.split('/')[1];
    const sameKind = (s) => (t.files[s] || []).filter((x) => x.kind === f.kind);
    const idx = sameKind(side).findIndex((x) => x.path === f.path);
    return ['golden', 'ad1', 'ad2'].map((s) => {
      const pool = sameKind(s);
      const hit = (t.files[s] || []).find((x) => x.name === f.name) || pool[idx] || pool[0] || null;
      return { side: s, file: hit };
    });
  }

  function renderViewer() {
    const { t, list, i, compare } = lbState;
    const f = list[i];
    const side = f.path.split('/')[1];
    const stage = compare && side !== 'input'
      ? el('div', { class: 'rli-lb__compare' }, counterparts(t, f).map(({ side: s, file }) =>
        el('div', { class: 'rli-lb__cell' },
          el('div', { class: 'rli-lb__cellhead' }, el('b', {}, SIDE_LABEL[s]), el('span', {}, file ? file.rel : 'no matching file')),
          file ? mediaNode(file, { compact: true }) : el('div', { class: 'rli-lb__none' }, '—'))))
      : el('div', { class: 'rli-lb__stage' }, mediaNode(f));
    mount(lb,
      el('div', { class: 'rli-lb__bar' },
        el('b', {}, SIDE_LABEL[side] || side),
        el('span', { class: 'rli-lb__name' }, f.rel),
        el('span', { class: 'rli-lb__pos' }, `${i + 1} / ${list.length}`),
        el('span', { class: 'spacer' }),
        side !== 'input' ? el('button', { type: 'button', class: `btn btn--ghost${compare ? ' is-on' : ''}`, onclick: toggleCompare }, compare ? 'Single view' : 'Compare RD · AD1 · AD2') : null,
        el('a', { class: 'btn btn--ghost', href: rawUrl(f.path, true) }, 'Download'),
        el('button', { type: 'button', class: 'btn btn--ghost', title: 'Toggle full screen', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : lb.requestFullscreen?.()) },
          document.fullscreenElement ? '⤡ Exit full screen' : '⤢ Full screen'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: closeViewer }, '✕'),
      ),
      stage,
      list.length > 1 ? el('button', { type: 'button', class: 'rli-lb__nav is-prev', title: 'Previous (←)', onclick: () => step(-1) }, '‹') : null,
      list.length > 1 ? el('button', { type: 'button', class: 'rli-lb__nav is-next', title: 'Next (→)', onclick: () => step(1) }, '›') : null,
    );
  }

  function mediaNode(f, { compact = false } = {}) {
    if (f.derived) {
      const d = f.derived;
      const note = el('div', { class: 'rli-derived-note' }, d.label, ' · ', el('a', { href: rawUrl(f.path, true) }, `download ${f.name}`));
      if (d.kind === 'model3d') return el('div', { class: 'rli-derived' }, model3d({ ...f, viewPath: d.path }, compact), note);
      if (d.kind === 'cad2d') return el('div', { class: 'rli-derived' }, dxfView(d, f), note);
      if (d.kind === 'drawing') return el('div', { class: 'rli-derived' }, el('div', { class: 'rli-drawing', title: 'Click to zoom', onclick: (e) => e.currentTarget.classList.toggle('is-zoom') }, el('img', { src: rawUrl(d.path), alt: f.name })), note);
      return el('div', { class: 'rli-derived' }, el('img', { class: 'rli-media rli-media--img', src: rawUrl(d.path), alt: f.name }), note);
    }
    const src = rawUrl(f.path);
    switch (f.kind) {
      case 'image': return el('img', { class: 'rli-media rli-media--img', src, alt: f.name });
      case 'video': return el('video', { class: 'rli-media', src, controls: '', preload: 'metadata' });
      case 'audio': return el('div', { class: 'rli-media rli-media--audio' }, el('div', { class: 'rli-audio__big' }, '♪'), el('audio', { src, controls: '' }));
      case 'pdf': return el('iframe', { class: 'rli-media rli-media--frame', src, title: f.name });
      case 'model3d': return model3d(f, compact);
      case 'text': {
        const pre = el('pre', { class: 'rli-media rli-media--text' }, 'Loading…');
        fetch(src).then((r) => r.text()).then((x) => { pre.textContent = x.length > 400000 ? `${x.slice(0, 400000)}\n…(truncated)` : x; });
        return pre;
      }
      default:
        return el('div', { class: 'rli-media rli-media--none' },
          el('div', { class: 'rli-tile__glyph big' }, glyph(f.kind)),
          el('p', {}, `${f.name} · ${fmtSize(f.size)}`),
          el('p', { class: 'hint-line' }, f.kind === 'cad'
            ? 'CAD/scene files can\'t render in the browser. Download it and open it in its native app or the free Autodesk Viewer (viewer.autodesk.com).'
            : 'No in-browser preview for this format — download it to inspect.'),
          el('div', {}, el('a', { class: 'btn', href: rawUrl(f.path, true) }, 'Download'),
            f.kind === 'cad' ? el('a', { class: 'btn btn--ghost', href: 'https://viewer.autodesk.com/', target: '_blank', rel: 'noopener' }, 'Open Autodesk Viewer') : null));
    }
  }

  // DXF (incl. DWG converted at ingest) in a real CAD viewer: model space,
  // layers and text, pan with drag, zoom with the wheel.
  function dxfView(d, f) {
    const host = el('div', { class: 'rli-dxf' });
    const status = el('div', { class: 'rli-3d__status' }, 'Loading drawing…');
    host.append(status);
    (async () => {
      try {
        const [{ DxfViewer }, T] = await Promise.all([
          import('https://esm.sh/dxf-viewer@1.0.43?deps=three@0.160.0'),
          import('https://esm.sh/three@0.160.0'),
        ]);
        const canvasHost = el('div', { class: 'rli-dxf__canvas' });
        host.prepend(canvasHost);
        const viewer = new DxfViewer(canvasHost, { clearColor: new T.Color('#ffffff'), autoResize: true, colorCorrection: true, sceneOptions: { wireframeMesh: true } });
        await viewer.Load({
          url: rawUrl(d.path),
          fonts: ['https://cdn.jsdelivr.net/npm/@fontsource/roboto@5.0.8/files/roboto-latin-400-normal.woff'],
          progressCbk: (phase, n, total) => { status.textContent = `${phase}${total ? ` ${Math.round((100 * n) / total)}%` : ''}…`; },
        });
        const layers = [...viewer.GetLayers()];
        status.textContent = `${layers.length} layer${layers.length === 1 ? '' : 's'} · drag to pan, scroll to zoom`;
      } catch (e) {
        status.textContent = `Couldn't render this drawing (${e.message || e}).`;
        status.classList.add('is-err');
        if (f.derived?.thumb) host.prepend(el('div', { class: 'rli-drawing' }, el('img', { src: rawUrl(f.derived.thumb), alt: f.name })));
      }
    })();
    return host;
  }

  // three.js loaded on demand from esm.sh (rewrites bare 'three' imports, so no import map needed).
  let three = null;
  async function loadThree() {
    if (three) return three;
    const v = '0.160.0';
    const [T, orbit, obj, fbx, gltf, stl, ply, tds, dae] = await Promise.all([
      import(`https://esm.sh/three@${v}`),
      import(`https://esm.sh/three@${v}/examples/jsm/controls/OrbitControls.js`),
      import(`https://esm.sh/three@${v}/examples/jsm/loaders/OBJLoader.js`),
      import(`https://esm.sh/three@${v}/examples/jsm/loaders/FBXLoader.js`),
      import(`https://esm.sh/three@${v}/examples/jsm/loaders/GLTFLoader.js`),
      import(`https://esm.sh/three@${v}/examples/jsm/loaders/STLLoader.js`),
      import(`https://esm.sh/three@${v}/examples/jsm/loaders/PLYLoader.js`),
      import(`https://esm.sh/three@${v}/examples/jsm/loaders/TDSLoader.js`),
      import(`https://esm.sh/three@${v}/examples/jsm/loaders/ColladaLoader.js`),
    ]);
    three = { T, OrbitControls: orbit.OrbitControls, OBJLoader: obj.OBJLoader, FBXLoader: fbx.FBXLoader, GLTFLoader: gltf.GLTFLoader, STLLoader: stl.STLLoader, PLYLoader: ply.PLYLoader, TDSLoader: tds.TDSLoader, ColladaLoader: dae.ColladaLoader };
    return three;
  }

  // 3D viewer. Framing ignores outlier geometry (site planes, stray objects),
  // zoom goes to the cursor, double-click re-centres the orbit on what you hit,
  // and a compact view bar gives Fit / Front / Back / Left / Right / Top / Iso,
  // shading modes and a grid. Keys: F fit, 1–7 views, W wireframe.
  function model3d(f, compact) {
    const host = el('div', { class: `rli-3d${compact ? ' rli-3d--compact' : ''}`, tabindex: '0' });
    const status = el('div', { class: 'rli-3d__status' }, 'Loading 3D viewer…');
    const bar = el('div', { class: 'rli-3d__bar' });
    const hint = el('div', { class: 'rli-3d__hint' }, 'Drag orbit · Right-drag or ⇧-drag pan · Pinch / scroll zoom · Double-click focus');
    host.append(status, bar, hint);
    (async () => {
      try {
        const { T, OrbitControls, OBJLoader, FBXLoader, GLTFLoader, STLLoader, PLYLoader, TDSLoader, ColladaLoader } = await loadThree();
        const w = host.clientWidth || 800, h = host.clientHeight || 520;
        const renderer = new T.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(w, h);
        host.prepend(renderer.domElement);
        const light = document.documentElement.dataset.theme === 'light';
        const scene = new T.Scene();
        scene.background = new T.Color(light ? 0xf1f1f3 : 0x16171b);
        const camera = new T.PerspectiveCamera(40, w / h, 0.01, 1e7);
        scene.add(new T.HemisphereLight(0xffffff, 0x3a3a44, 1.15));
        const key = new T.DirectionalLight(0xffffff, 1.1); scene.add(key);
        const controls = new OrbitControls(camera, renderer.domElement);
        // Zoom is ours, not OrbitControls': its wheel handler moves one fixed step
        // per event, which lurches on a trackpad (dozens of tiny events per swipe)
        // and crawls on pinch. See the wheel handler below.
        Object.assign(controls, { enableDamping: true, dampingFactor: 0.12, screenSpacePanning: true, enableZoom: false, rotateSpeed: 0.8 });

        const url = rawUrl(f.viewPath || f.path);
        const ext = (f.viewPath || f.name).split('.').pop().toLowerCase();
        status.textContent = `Loading ${f.name} (${fmtSize(f.size)})…`;
        const flat = new T.MeshStandardMaterial({ color: 0xc9ccd6, roughness: 0.65, metalness: 0.05, side: T.DoubleSide });
        let obj3d;
        if (ext === 'obj') obj3d = await new OBJLoader().loadAsync(url);
        else if (ext === 'fbx') obj3d = await new FBXLoader().loadAsync(url);
        else if (ext === 'glb' || ext === 'gltf') obj3d = (await new GLTFLoader().loadAsync(url)).scene;
        else if (ext === 'stl') obj3d = new T.Mesh(await new STLLoader().loadAsync(url), flat);
        else if (ext === 'ply') obj3d = new T.Mesh(await new PLYLoader().loadAsync(url), flat);
        else if (ext === '3ds') { const l = new TDSLoader(); l.setResourcePath(url.replace(/[^/]*$/, '')); obj3d = await l.loadAsync(url); }
        else if (ext === 'dae') obj3d = (await new ColladaLoader().loadAsync(url)).scene;
        if (ext === '3ds') obj3d.rotation.x = -Math.PI / 2; // 3DS is Z-up
        scene.add(obj3d);
        obj3d.updateMatrixWorld(true);

        // Materials: keep the originals; "Shaded" swaps in one neutral clay material.
        let meshes = 0, tris = 0;
        const meshList = [];
        obj3d.traverse((o) => {
          if (!o.isMesh) return;
          meshes++; meshList.push(o);
          const g = o.geometry;
          tris += g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
          o.userData.orig = o.material;
        });
        const hasMats = meshList.some((m) => [].concat(m.userData.orig || []).some((x) => x && (x.map || (x.color && x.color.getHex() !== 0xffffff))));
        let mode = hasMats && ext !== 'obj' ? 'materials' : 'shaded';
        const applyMode = () => {
          for (const m of meshList) {
            if (mode === 'shaded') m.material = flat;
            else m.material = m.userData.orig || flat;
            [].concat(m.material).forEach((x) => { if (x) x.wireframe = mode === 'wire'; });
          }
          if (mode === 'wire') for (const m of meshList) m.material = flat;
          flat.wireframe = mode === 'wire';
        };
        applyMode();

        // Framing: the main object, not the whole file. Seed with the most
        // voluminous mesh (flat site planes have ~no volume), then absorb every
        // mesh whose centre sits inside that box grown by 35%, twice. Exported
        // scenes often park a component library beside the model — this skips it.
        const full = new T.Box3().setFromObject(obj3d);
        const boxes = meshList.map((m) => new T.Box3().setFromObject(m)).filter((bx) => !bx.isEmpty());
        const vol = (bx) => { const sz = bx.getSize(new T.Vector3()); const t = Math.max(sz.x, sz.y, sz.z) * 0.002; return Math.max(sz.x, t) * Math.max(sz.y, t) * Math.max(sz.z, t); };
        let main = boxes.slice().sort((x, y) => vol(y) - vol(x))[0]?.clone() || full.clone();
        for (let pass = 0; pass < 2; pass++) {
          const grown = main.clone().expandByScalar(main.getSize(new T.Vector3()).length() * 0.35);
          for (const bx of boxes) if (grown.containsPoint(bx.getCenter(new T.Vector3()))) main.union(bx);
        }
        const clusterShare = main.getSize(new T.Vector3()).length() / (full.getSize(new T.Vector3()).length() || 1);
        let frameBox = main;
        const center = frameBox.getCenter(new T.Vector3());
        const size = frameBox.getSize(new T.Vector3());
        const lo = frameBox.min.clone();
        let radius = Math.max(size.length() / 2, 1e-3);
        const fullRadius = Math.max(full.getSize(new T.Vector3()).length() / 2, 1e-3);
        const fullSize = full.getSize(new T.Vector3());

        // Ground grid sized to the framed geometry, at its base.
        const gridSize = Math.pow(10, Math.ceil(Math.log10(radius * 4)));
        const grid = new T.GridHelper(gridSize, 20, light ? 0xb5b7c0 : 0x3b3d45, light ? 0xd5d7de : 0x26282e);
        grid.position.set(center.x, lo.y, center.z);
        grid.visible = false;
        scene.add(grid);

        const DIRS = {
          fit: [1.1, 0.75, 1.35], front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0.0001], iso: [1, 1, 1],
        };
        let anim = null;
        const flyTo = (dirKey, target = center, dist = null, r = radius) => {
          const d = new T.Vector3(...DIRS[dirKey === 'all' ? 'fit' : dirKey]).normalize();
          const fov = (camera.fov * Math.PI) / 180;
          const distance = dist ?? (r / Math.sin(fov / 2)) * 1.05;
          const toPos = target.clone().add(d.multiplyScalar(distance));
          anim = { fromPos: camera.position.clone(), toPos, fromT: controls.target.clone(), toT: target.clone(), t: 0 };
        };
        // Start framed, no animation.
        { const d = new T.Vector3(...DIRS.fit).normalize(); camera.position.copy(center).add(d.multiplyScalar((radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.05)); controls.target.copy(center); }
        camera.near = radius / 2000; camera.far = Math.max(radius, fullSize.length()) * 200; camera.updateProjectionMatrix();

        // Gesture-aware zoom toward the cursor, proportional to the gesture:
        //   pinch (ctrl+wheel on macOS)     → fast, smooth
        //   two-finger scroll (pixel deltas) → gentle, continuous
        //   mouse wheel (line/large deltas)  → ~12% per notch
        // The camera and orbit target both slide toward the point under the
        // cursor on the plane through the target, so what you point at stays put.
        const ndc = new T.Vector2();
        const zoomRay = new T.Raycaster();
        renderer.domElement.addEventListener('wheel', (e) => {
          e.preventDefault();
          anim = null;
          hint.classList.add('gone');
          let dy = e.deltaY;
          if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 400;
          const k = e.ctrlKey ? 0.012 : Math.abs(dy) >= 50 && Number.isInteger(dy) ? 0.0012 : 0.0035;
          const factor = Math.exp(Math.max(-0.5, Math.min(0.5, dy * k)));  // >1 = out
          const r = renderer.domElement.getBoundingClientRect();
          ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
          zoomRay.setFromCamera(ndc, camera);
          const viewDir = controls.target.clone().sub(camera.position).normalize();
          const plane = new T.Plane().setFromNormalAndCoplanarPoint(viewDir, controls.target);
          const p = new T.Vector3();
          if (!zoomRay.ray.intersectPlane(plane, p)) p.copy(controls.target);
          camera.position.sub(p).multiplyScalar(factor).add(p);
          controls.target.sub(p).multiplyScalar(factor).add(p);
        }, { passive: false });
        // Safari sends pinch as gesture events rather than ctrl+wheel.
        let gScale = 1;
        renderer.domElement.addEventListener('gesturestart', (e) => { e.preventDefault(); gScale = 1; });
        renderer.domElement.addEventListener('gesturechange', (e) => {
          e.preventDefault();
          const f = gScale / e.scale; gScale = e.scale;
          camera.position.sub(controls.target).multiplyScalar(f).add(controls.target);
        });

        // Double-click: orbit around the point under the cursor.
        const ray = new T.Raycaster();
        renderer.domElement.addEventListener('dblclick', (e) => {
          const r = renderer.domElement.getBoundingClientRect();
          ray.setFromCamera(new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
          const hit = ray.intersectObjects(meshList, false)[0];
          if (!hit) return;
          const dist = camera.position.distanceTo(hit.point) * 0.6;
          const dir = camera.position.clone().sub(hit.point).normalize();
          anim = { fromPos: camera.position.clone(), toPos: hit.point.clone().add(dir.multiplyScalar(dist)), fromT: controls.target.clone(), toT: hit.point.clone(), t: 0 };
        });

        const units = (n) => (n >= 1000 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
        status.textContent = `${meshes.toLocaleString()} mesh${meshes === 1 ? '' : 'es'} · ${Math.round(tris).toLocaleString()} tris · ${units(fullSize.x)} × ${units(fullSize.y)} × ${units(fullSize.z)}`;

        const btn = (label, title, on) => el('button', { type: 'button', class: 'rli-3d__b', title, onclick: (e) => { e.stopPropagation(); on(e); host.focus({ preventScroll: true }); } }, label);
        const modeSeg = el('div', { class: 'rli-3d__seg' });
        const setMode = (m) => { mode = m; applyMode(); for (const b of modeSeg.children) b.classList.toggle('on', b.dataset.m === m); };
        for (const [m, label] of [['shaded', 'Shaded'], ...(hasMats ? [['materials', 'Materials']] : []), ['wire', 'Wire']]) {
          const b = btn(label, `${label} view`, () => setMode(m)); b.dataset.m = m; modeSeg.append(b);
        }
        setMode(mode);
        const views = el('div', { class: 'rli-3d__seg' },
          btn('Fit', 'Frame the main model (F)', () => flyTo('fit')),
          ...(clusterShare < 0.8 ? [btn('All', 'Frame everything in the file (A)', () => flyTo('all', full.getCenter(new T.Vector3()), null, fullRadius))] : []),
          ...(compact ? [btn('Top', 'Top view', () => flyTo('top')), btn('Front', 'Front view', () => flyTo('front'))]
            : [['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['iso', 'Iso']].map(([k, l], i) => btn(l, `${l} view (${i + 2})`, () => flyTo(k)))));
        const gridBtn = btn('Grid', 'Toggle ground grid (G)', () => { grid.visible = !grid.visible; gridBtn.classList.toggle('on', grid.visible); });
        const zoomBy = (f) => {
          const toPos = camera.position.clone().sub(controls.target).multiplyScalar(f).add(controls.target);
          anim = { fromPos: camera.position.clone(), toPos, fromT: controls.target.clone(), toT: controls.target.clone(), t: 0 };
        };
        const zoomSeg = el('div', { class: 'rli-3d__seg rli-3d__zoom' },
          btn('−', 'Zoom out (−)', () => zoomBy(1.4)),
          btn('+', 'Zoom in (+)', () => zoomBy(1 / 1.4)));
        bar.append(zoomSeg, views, modeSeg, gridBtn);
        host.addEventListener('keydown', (e) => {
          if (e.key === '+' || e.key === '=') { zoomBy(1 / 1.4); e.preventDefault(); e.stopPropagation(); }
          else if (e.key === '-' || e.key === '_') { zoomBy(1.4); e.preventDefault(); e.stopPropagation(); }
        });

        host.addEventListener('keydown', (e) => {
          const k = e.key.toLowerCase();
          const map = { f: 'fit', 2: 'front', 3: 'back', 4: 'left', 5: 'right', 6: 'top', 7: 'iso', 1: 'fit' };
          if (map[k]) { flyTo(map[k]); e.stopPropagation(); e.preventDefault(); }
          else if (k === 'w') { setMode(mode === 'wire' ? (hasMats ? 'materials' : 'shaded') : 'wire'); e.stopPropagation(); }
          else if (k === 'g') { gridBtn.click(); e.stopPropagation(); }
          else if (k === 'a') { flyTo('all', full.getCenter(new T.Vector3()), null, fullRadius); e.stopPropagation(); }
        });
        renderer.domElement.addEventListener('pointerdown', (e) => {
          anim = null; host.focus({ preventScroll: true }); hint.classList.add('gone');
          controls.mouseButtons.LEFT = e.shiftKey || e.metaKey ? T.MOUSE.PAN : T.MOUSE.ROTATE;
        }, true);

        let alive = true;
        const ease = (x) => 1 - Math.pow(1 - x, 3);
        const tick = () => {
          if (!alive || !host.isConnected) { alive = false; renderer.dispose(); return; }
          if (anim) {
            anim.t = Math.min(1, anim.t + 0.07);
            const k = ease(anim.t);
            camera.position.lerpVectors(anim.fromPos, anim.toPos, k);
            controls.target.lerpVectors(anim.fromT, anim.toT, k);
            if (anim.t >= 1) anim = null;
          }
          key.position.copy(camera.position).add(new T.Vector3(radius, radius * 2, radius));
          controls.update();
          renderer.render(scene, camera);
          requestAnimationFrame(tick);
        };
        tick();
        new ResizeObserver(() => {
          const W = host.clientWidth, H = host.clientHeight;
          if (!W || !H) return;
          renderer.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix();
        }).observe(host);
      } catch (e) {
        status.textContent = `Couldn't render this model in the browser (${e.message || e}). Download it to inspect.`;
        status.classList.add('is-err');
      }
    })();
    return host;
  }

  // ---------- Rubric ----------
  // One row per criterion: what it asks, how heavy it is, and the three
  // verdicts — with the side that disagrees called out, because "why do the
  // verdicts differ" is the question an auditor opens this tab to answer.
  const rubricFilter = { q: '', cat: '', only: '' };
  const rubricOpen = { agree: false };
  const SIDE_KEYS = ['golden', 'ad1', 'ad2'];
  // The side whose verdict differs from the other two, or null.
  function oddOne(c) {
    const g = SIDE_KEYS.map((s) => c.verdicts[s].good);
    if (g.some((x) => x == null)) return null;
    if (g[0] === g[1] && g[1] === g[2]) return null;
    return SIDE_KEYS[g[0] === g[1] ? 2 : g[0] === g[2] ? 1 : 0];
  }
  function splitNote(c) {
    const odd = oddOne(c);
    if (odd) return { text: `${SIDE_LABEL[odd]} is the odd one out`, cls: 'is-split' };
    const g = c.verdicts.golden.good;
    if (g == null) return { text: 'Verdict missing', cls: '' };
    return g ? { text: 'All three pass', cls: '' } : { text: 'All three fail', cls: 'is-allfail' };
  }
  const FILTERS = [
    ['', 'All', () => true],
    ['split', 'Verdicts differ', (c) => !!oddOne(c)],
    ['goldenfail', 'RD fails', (c) => c.verdicts.golden.good === false],
    ['ad1only', 'Only AD1 fails', (c) => oddOne(c) === 'ad1' && c.verdicts.ad1.good === false],
    ['heavy', 'Weight ≥ 8', (c) => Math.abs(c.weight) >= 8],
    ['negative', 'Penalties', (c) => c.weight < 0],
  ];

  async function buildRubric() {
    const t = await load();
    const weights = t.checks.find((c) => c.id === 'weights');
    const mix = weights?.mix;
    const cats = [...new Set(t.criteria.map((c) => c.category))].sort();
    const maxW = Math.max(1, ...t.criteria.map((c) => Math.abs(c.weight)));
    const body = el('div', { class: 'rub-body' });
    const chips = el('div', { class: 'rub-chips' });

    const baseMatch = (c) => {
      const f = rubricFilter;
      if (f.q && !(`C${c.n} ${c.title}`.toLowerCase().includes(f.q.toLowerCase()))) return false;
      if (f.cat && c.category !== f.cat) return false;
      return true;
    };
    const verdictCell = (c, side, odd) => {
      const v = c.verdicts[side];
      const neg = c.weight < 0;
      if (v.passed == null) return el('div', { class: 'rub-v is-na' }, el('b', {}, '—'), el('span', {}, 'n/a'));
      const label = neg ? (v.passed ? 'Present' : 'Absent') : (v.passed ? 'Pass' : 'Fail');
      return el('div', { class: `rub-v ${v.good ? 'is-good' : 'is-bad'}${odd === side ? ' is-odd' : ''}`, title: `${SIDE_LABEL[side]}: ${label}${neg ? ' (penalty — present means the defect is there)' : ''}` },
        el('b', {}, v.good ? '✓' : '✕'), el('span', {}, label));
    };
    const row = (c) => {
      const odd = oddOne(c);
      const note = splitNote(c);
      const detail = el('div', { class: 'rub-detail', hidden: '' },
        SIDE_KEYS.map((s) => {
          const v = c.verdicts[s];
          const label = c.weight < 0 ? (v.passed ? 'defect present' : 'defect absent') : (v.passed ? 'passed' : 'failed');
          return el('div', { class: `rli-just rub-just ${v.good ? 'is-good' : v.good === false ? 'is-bad' : ''}${odd === s ? ' is-odd' : ''}` },
            el('div', { class: 'rub-just__head' },
              el('b', {}, SIDE_LABEL[s]), el('span', { class: 'rub-just__model' }, modelLine(t, s)),
              el('span', { class: `rub-just__verdict ${v.good ? 'is-good' : 'is-bad'}` }, label),
              odd === s ? el('span', { class: 'rub-odd-tag' }, 'odd one out') : null),
            el('div', { class: 'rub-just__text' }, v.justification || '(no justification)'));
        }),
        onCompare ? el('div', { class: 'rub-detail__foot' }, el('button', { type: 'button', class: 'link', onclick: () => onCompare() }, 'Compare the deliverables side by side →')) : null);
      const wPct = (Math.abs(c.weight) / maxW) * 100;
      const node = el('div', { class: `rub-row${c.weight < 0 ? ' is-neg' : ''}${odd ? ' is-split' : ''}`, id: `crit-C${c.n}` },
        el('button', { type: 'button', class: 'rub-row__main', 'aria-expanded': 'false',
          onclick: () => { detail.hidden = !detail.hidden; node.classList.toggle('is-open', !detail.hidden); node.firstChild.setAttribute('aria-expanded', String(!detail.hidden)); } },
          el('span', { class: 'rub-n' }, `C${c.n}`),
          el('span', { class: 'rub-crit' },
            el('span', { class: 'rub-title' }, c.weight < 0 ? el('span', { class: 'rub-pen' }, 'Penalty') : null, c.title),
            el('span', { class: 'rub-meta' }, el('span', { class: `rub-cat b-${c.bucket}` }, c.category || '—'), el('span', { class: `rub-note ${note.cls}` }, note.text))),
          el('span', { class: `rub-w ${c.weight < 0 ? 'is-neg' : ''}`, title: `weight ${c.weight}` },
            el('span', { class: 'rub-w__bar' }, el('i', { style: `width:${wPct}%` })),
            el('b', {}, c.weight > 0 ? `+${c.weight}` : String(c.weight))),
          ...SIDE_KEYS.map((s) => verdictCell(c, s, odd))),
        detail);
      return node;
    };
    const head = () => el('div', { class: 'rub-head' },
      el('span', {}, '#'), el('span', {}, 'Criterion'), el('span', {}, 'Weight'),
      ...SIDE_KEYS.map((s) => el('span', { class: 'rub-head__side', title: modelLine(t, s) }, SIDE_LABEL[s])));

    const render = () => {
      const base = t.criteria.filter(baseMatch);
      chips.replaceChildren(...FILTERS.map(([key, label, fn]) => el('button', {
        type: 'button', class: `rub-chip${rubricFilter.only === key ? ' is-on' : ''}`,
        onclick: () => { rubricFilter.only = key; render(); },
      }, label, el('span', {}, String(base.filter(fn).length)))));
      const fn = FILTERS.find(([k]) => k === rubricFilter.only)?.[2] || (() => true);
      const shown = base.filter(fn);
      if (!shown.length) { body.replaceChildren(el('div', { class: 'rub-empty' }, 'No criteria match.')); return; }
      // Unfiltered: split verdicts first and open; agreements folded underneath.
      if (!rubricFilter.only) {
        const split = shown.filter((c) => oddOne(c));
        const agree = shown.filter((c) => !oddOne(c));
        const agreeWrap = el('div', { class: 'rub-group__rows', hidden: rubricOpen.agree ? null : '' }, agree.map(row));
        const agreeHead = el('button', { type: 'button', class: 'rub-group', 'aria-expanded': String(rubricOpen.agree),
          onclick: () => { rubricOpen.agree = !rubricOpen.agree; agreeWrap.hidden = !rubricOpen.agree; agreeHead.setAttribute('aria-expanded', String(rubricOpen.agree)); } },
          el('span', { class: 'rub-group__caret' }, '▸'), `All three agree`, el('span', {}, String(agree.length)));
        body.replaceChildren(
          split.length ? el('div', { class: 'rub-group rub-group--static' }, 'Verdicts differ', el('span', {}, String(split.length))) : null,
          ...split.map(row),
          agree.length ? agreeHead : null,
          agree.length ? agreeWrap : null);
      } else {
        body.replaceChildren(...shown.map(row));
      }
    };

    const search = el('input', { class: 'input rli-search', type: 'search', placeholder: 'Search criteria…', oninput: (e) => { rubricFilter.q = e.target.value; render(); } });
    search.value = rubricFilter.q;
    const catSel = el('select', { class: 'select', onchange: (e) => { rubricFilter.cat = e.target.value; render(); } },
      el('option', { value: '' }, 'All categories'), cats.map((c) => el('option', { value: c }, c)));
    catSel.value = rubricFilter.cat;
    render();

    return el('div', { class: 'rli rli-rubric rub' },
      mix ? mixBar(mix, weights) : null,
      el('div', { class: 'rub-tools' }, chips, el('span', { class: 'spacer' }), search, catSel),
      el('div', { class: 'rub-table' }, head(), body),
      el('p', { class: 'rub-foot' }, 'Penalty criteria (negative weight): "Present" means the defect is there and its weight is deducted — that is what the record\'s "passed: true" means on a penalty, and it matches the printed scores.'),
    );
  }

  function mixBar(mix, check) {
    const segs = [['format', 'Format', mix.format, 5], ['brief', 'Brief', mix.brief, 30], ['quality', 'Quality', mix.quality, 65], ...(mix.other ? [['other', 'Other', mix.other, 0]] : [])];
    return el('div', { class: `rub-mix is-${check.status}` },
      el('div', { class: 'rub-mix__head' },
        el('b', {}, 'Weight mix'),
        el('span', { class: 'rub-mix__sub' }, 'share of positive weight · target 5 / 30 / 65'),
        el('span', { class: 'spacer' }),
        el('span', { class: `rub-mix__status is-${check.status}` }, mix.quality >= 65 ? `Quality ${mix.quality}% — clears the 65% gate` : `Quality ${mix.quality}% — under the 65% gate`)),
      el('div', { class: 'rub-mix__bar' },
        segs.map(([b, label, val, target]) => el('i', { class: `b-${b}`, style: `flex:${Math.max(val || 0, 0.001)}`, title: `${label}: ${val}% (target ${target}%)` })),
        el('span', { class: 'rub-mix__gate', style: 'left:35%', title: 'Quality must start left of this line (≥ 65% of positive weight)' }, el('em', {}, '65% gate'))),
      el('div', { class: 'rub-mix__legend' },
        segs.map(([b, label, val, target]) => el('span', {}, el('i', { class: `b-${b}` }), `${label} `, el('b', {}, `${val}%`), el('small', {}, ` / ${target}`)))),
    );
  }

  function statusPill(s) {
    const txt = { pass: 'Pass', fail: 'Fail', warn: 'Check', info: 'Note', na: 'N/A' }[s] || s;
    return el('span', { class: `rli-pill is-${s}` }, el('span', { class: 'rli-pill__i' }, statusIcon[s] || '·'), txt);
  }

  // ---------- Preference ----------
  // One block per comparison. Each dimension is a 7-step scale (1 = left side
  // better … 4 comparable … 7 = right side better) with the pick marked, read
  // out in words; the rubric gap sits beside the overall reading as a number,
  // so a preference that contradicts the scores is visible without arithmetic.
  async function buildPreference() {
    const t = await load();
    const comps = t.pref?.comparisons || [];
    if (!comps.length) return el('div', { class: 'rli rli-prefs' }, el('div', { class: 'callout warn' }, 'No preference ranking in this record.'));
    const align = new Map((t.checks.find((c) => c.id === 'alignment')?.align || []).map((a) => [a.pair, a]));
    const sc = (lbl) => t.scores?.[{ RD: 'golden', AD1: 'ad1', AD2: 'ad2' }[lbl]]?.percentage;
    const STRENGTH = { 1: 'much better', 2: 'clearly better', 3: 'slightly better', 5: 'slightly better', 6: 'clearly better', 7: 'much better' };
    const reading = (v, c) => {
      if (v == null || Number.isNaN(v)) return '—';
      const r = Math.round(v);
      if (r === 4) return 'Comparable';
      return `${r < 4 ? c.left : c.right} ${STRENGTH[r]}`;
    };
    const track = (v) => el('div', { class: 'pref-track', role: 'img', 'aria-label': `${v} on a 1–7 scale` },
      [1, 2, 3, 4, 5, 6, 7].map((k) => el('i', { class: `${k === 4 ? 'mid' : ''}${Math.round(v) === k ? ' on' : ''}${k < 4 ? ' l' : k > 4 ? ' r' : ''}` })));
    const mean = (c) => {
      const xs = (c.dimensions || []).map((d) => Number(d.score)).filter(Boolean);
      return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null;
    };

    const blocks = comps.map((c) => {
      const a = align.get(c.pair);
      const L = sc(c.left), R = sc(c.right);
      const gap = L != null && R != null ? Math.round((L - R) * 10) / 10 : null;
      const gapText = gap == null ? '' : Math.abs(gap) < 0.05 ? 'rubric: even' : `rubric: ${gap > 0 ? c.left : c.right} +${Math.abs(gap)} pts`;
      const just = el('div', { class: 'pref-just', hidden: '' }, el('div', { class: 'pref-just__lbl' }, 'Justification'), el('p', {}, c.justification || '(no justification)'));
      const toggle = () => { just.hidden = !just.hidden; blk.classList.toggle('is-open', !just.hidden); };
      const dimRow = (label, v, extra, cls = '') => el('button', { type: 'button', class: `pref-row ${cls}`, onclick: toggle, title: 'Show the justification' },
        el('span', { class: 'pref-row__lbl' }, label),
        el('span', { class: 'pref-row__end l' }, c.left),
        track(v),
        el('span', { class: 'pref-row__end r' }, c.right),
        el('span', { class: 'pref-row__read' }, reading(v, c), v != null ? el('b', {}, ` · ${Number.isInteger(v) ? v : v.toFixed(1)}`) : null, extra || null));
      const m = mean(c);
      const status = a?.why ? 'disagree' : 'agree';
      const blk = el('section', { class: `pref-blk is-${a?.status || 'pass'}`, id: `pref-${c.pair}` },
        el('header', { class: 'pref-blk__head' },
          el('h3', {}, `${c.left} vs ${c.right}`),
          el('span', { class: 'pref-blk__scores' }, `${c.left} ${pct(L)} · ${c.right} ${pct(R)}`),
          el('span', { class: 'spacer' }),
          el('span', { class: `pref-blk__status is-${status}`, title: a?.why || 'The preference leans the same way as the rubric scores.' }, status === 'agree' ? 'Agrees with the rubric' : 'Disagrees with the rubric'),
          el('button', { type: 'button', class: 'link', onclick: toggle }, 'Justification')),
        el('div', { class: 'pref-rows' },
          (c.dimensions || []).map((d) => {
            const r = dimRow(d.title || d.id, Number(d.score) || null);
            r.dataset.dim = d.id;
            return r;
          }),
          dimRow('Overall (mean)', m, el('span', { class: 'pref-row__gap' }, gapText), 'is-overall')),
        just);
      return blk;
    });

    const issues = comps.map((c) => [c, align.get(c.pair)]).filter(([, a]) => a?.why);
    return el('div', { class: 'rli pref' },
      issues.length ? el('div', { class: 'pref-banners' }, issues.map(([c, a]) => el('div', { class: `pref-banner is-${a.status}` },
        el('b', {}, a.status === 'fail' ? 'Preference contradicts the rubric' : 'Preference and rubric pull apart'),
        el('span', {}, a.why),
        el('button', { type: 'button', class: 'link', onclick: () => flashPref(c.pair) }, 'Jump to it →')))) : null,
      el('p', { class: 'pref-legend' }, 'Each row is a 1–7 rating: 1 = the left side is much better, 4 = comparable, 7 = the right side is much better. Click any row for the contributor\'s justification.'),
      ...blocks,
      t.pref.rd_better_than_ads != null ? el('p', { class: 'pref-legend' }, `Contributor marked RD better than both ADs: ${t.pref.rd_better_than_ads ? 'yes' : 'no'}.`) : null,
    );
  }

  // ---------- auto-check panel, shown at the top of Review ----------
  async function checksPanel() {
    const t = await load();
    const order = { fail: 0, warn: 1, info: 2 };
    const open = t.checks.filter((c) => c.status in order).sort((a, b) => order[a.status] - order[b.status]);
    const passed = t.checks.filter((c) => c.status === 'pass');
    const row = (c) => {
      const more = c.detail || c.note || c.evidence?.length;
      const detail = more ? el('div', { class: 'rli-row__more' },
        c.detail ? el('div', { class: 'rli-row__detail' }, c.detail) : null,
        c.note ? el('div', { class: 'rli-row__note' }, c.note) : null,
        c.evidence?.length ? el('div', { class: 'rli-row__ev' }, c.evidence.slice(0, 24).map(critChip)) : null) : null;
      if (detail && c.status !== 'fail') detail.hidden = true;
      return el('div', { class: `rli-row is-${c.status}` },
        el('button', { type: 'button', class: 'rli-row__main', onclick: () => { if (detail) detail.hidden = !detail.hidden; } },
          el('span', { class: `rli-dot is-${c.status}` }),
          el('b', {}, c.label),
          el('span', { class: 'rli-row__sum' }, c.summary),
          specChip(c.dim),
          more ? el('span', { class: 'rli-row__chev' }, '▾') : null),
        detail);
    };
    return el('section', { class: 'rli-autoqc' },
      el('header', { class: 'rli-sec__head' }, el('h3', {}, 'Auto-checks'), el('span', { class: 'hint-line' }, 'spec dimensions the record alone can decide')),
      open.length ? el('div', { class: 'rli-rows' }, open.map(row)) : null,
      passed.length ? el('div', { class: 'rli-passline' },
        el('span', { class: 'rli-passline__lbl' }, `${passed.length} passed`),
        passed.map((c) => el('button', { type: 'button', class: 'rli-passchip', title: c.summary, onclick: () => onSpec(c.dim) }, '✓ ', c.label.split(' (')[0]))) : null);
  }

  function flashCrit(n, side = null) {
    const row = document.getElementById(`crit-C${n}`);
    if (!row) return false;
    const group = row.closest('.rub-group__rows');
    if (group?.hidden) { group.hidden = false; rubricOpen.agree = true; group.previousElementSibling?.setAttribute('aria-expanded', 'true'); }
    row.querySelector('.rub-detail')?.removeAttribute('hidden');
    row.classList.add('is-open', 'flash');
    if (side) {
      const idx = { rd: 0, golden: 0, ad1: 1, ad2: 2 }[side];
      const card = row.querySelectorAll('.rub-just')[idx];
      if (card) { card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 2000); }
    }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => row.classList.remove('flash'), 1600);
    return true;
  }

  async function openArtifact(p) {
    const t = await load();
    const side = p.split('/')[1];
    const list = t.files[side] || [];
    const f = list.find((x) => x.path === p);
    if (f) openViewer(t, f, list);
  }
  function flashPref(pair, dim) {
    const blk = document.getElementById(`pref-${pair}`);
    if (!blk) return false;
    const target = (dim && [...blk.querySelectorAll('.pref-row')].find((r) => r.dataset.dim === dim)) || blk;
    target.classList.add('flash');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => target.classList.remove('flash'), 1600);
    return true;
  }


  return { load, summaryBar, openArtifact, flashPref, buildBrief, buildDeliverables, buildRubric, buildPreference, checksPanel, flashCrit, setDelivMode: (m) => { delivMode = m; }, resetFilter: () => { rubricFilter.q = ''; rubricFilter.cat = ''; rubricFilter.only = ''; } };
}
