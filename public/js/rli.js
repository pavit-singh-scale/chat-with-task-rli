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

export function createRli({ bucket, taskId, onCrit, onSpec, onOpenDoc }) {
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
      sub = margin < 0
        ? `${Math.abs(Math.round(margin * 10) / 10)} ${side === 'golden' ? 'under' : 'over'} ${gate}`
        : side === 'golden' ? `clears ${gate}` : `${Math.round(margin * 10) / 10} pts under ${gate}`;
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
        el('div', { class: `rli-stat is-${t.criteria.length < 40 ? 'bad' : 'ok'}` },
          el('div', { class: 'rli-stat__k' }, 'Criteria'),
          el('div', { class: 'rli-stat__v' }, String(t.criteria.length)),
          el('div', { class: 'rli-stat__s' }, `${mix?.negatives || 0} penalties`)),
        mix ? el('div', { class: `rli-stat rli-stat--mix is-${mixCheck.status === 'fail' ? 'bad' : mixCheck.status === 'warn' ? 'warn' : 'ok'}`, title: `Format ${mix.format}% · Brief ${mix.brief}% · Quality ${mix.quality}% of positive weight (target 5 / 30 / 65)` },
          el('div', { class: 'rli-stat__k' }, 'Weight mix'),
          el('div', { class: 'rli-stat__v' }, `${mix.quality}`, el('small', {}, '% quality')),
          el('div', { class: 'rli-minimix' }, mixSeg('format', mix.format), mixSeg('brief', mix.brief), mixSeg('quality', mix.quality), mix.other ? mixSeg('other', mix.other) : null, el('b', {}))) : null,
        el('button', { type: 'button', class: `rli-stat rli-stat--checks is-${n('fail') ? 'bad' : n('warn') ? 'warn' : 'ok'}`, onclick: onChecks },
          el('div', { class: 'rli-stat__k' }, 'Auto-checks'),
          el('div', { class: 'rli-stat__v' }, n('fail') ? String(n('fail')) : '✓', n('fail') ? el('small', {}, n('fail') > 1 ? ' fails' : ' fail') : null),
          el('div', { class: 'rli-stat__s' }, fails.length ? fails.map((c) => c.label.split(' (')[0].split(':')[0]).join(' · ') : n('warn') ? `${n('warn')} to check` : 'all clear')),
      ),
    );
  }

  // ---------- Brief ----------
  async function buildBrief() {
    const t = await load();
    const paths = t.checks.find((c) => c.id === 'paths')?.paths;
    const unlisted = new Set((paths?.unlisted || []).map((f) => f.rel));
    const sections = t.briefSections.length
      ? t.briefSections.map((s) => {
        const body = el('div', { class: 'cb-prose' });
        body.innerHTML = renderMarkdown(s.body || '_(empty)_');
        return el('section', { class: 'rli-brief__sec' }, el('div', { class: 'cb-label' }, s.heading), body);
      })
      : [el('div', { class: 'callout warn' }, 'This record has no brief.')];
    const inputs = t.files.input;
    return el('div', { class: 'rli rli-brief' },
      el('div', { class: 'rli-brief__grid' },
        el('div', { class: 'rli-brief__main' }, ...sections,
          el('p', { class: 'hint-line' }, 'This is the brief as exported. If it was rewritten at the brief-sufficiency step, the contributor\'s original may differ — the models may have worked from either.')),
        el('aside', { class: 'rli-brief__side' },
          el('div', { class: 'cb-label' }, `Input files · ${inputs.length}${t.inputsDeclared != null && t.inputsDeclared !== inputs.length ? ` (record says ${t.inputsDeclared})` : ''}`),
          inputs.length
            ? el('div', { class: 'rli-inputs' }, inputs.map((f) => fileTile(t, f, { mark: unlisted.has(f.rel) ? 'not in brief' : null, list: inputs })))
            : el('div', { class: 'hint-line' }, 'No input files.'),
          paths?.problems?.length
            ? el('div', { class: 'rli-probs' }, paths.problems.map((p) => el('div', { class: `rli-prob is-${p.sev}` }, p.text)))
            : null,
        ),
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

  function sideColumn(t, side, { dense = false } = {}) {
    const files = t.files[side] || [];
    const byKind = new Map();
    for (const f of files) {
      if (!byKind.has(f.kind)) byKind.set(f.kind, []);
      byKind.get(f.kind).push(f);
    }
    const v = t.scores?.[side]?.percentage;
    return el('section', { class: `rli-col side-${side}` },
      el('header', { class: 'rli-col__head' },
        el('b', {}, SIDE_LABEL[side]),
        el('span', { class: 'rli-col__model' }, side === 'input' ? SIDE_LONG.input : modelLine(t, side)),
        el('span', { class: 'spacer' }),
        side !== 'input' && v != null ? el('span', { class: 'rli-col__pct' }, pct(v)) : null,
        el('span', { class: 'rli-col__count' }, `${files.length} file${files.length === 1 ? '' : 's'}`),
      ),
      files.length ? null : el('div', { class: 'hint-line rli-col__empty' }, 'No files delivered.'),
      ...KIND_ORDER.filter((k) => byKind.has(k)).map((k) =>
        el('div', { class: 'rli-group' },
          el('div', { class: 'rli-group__lbl' }, `${KIND_LABEL[k]} · ${byKind.get(k).length}`),
          k === 'audio'
            ? el('div', { class: 'rli-audio' }, byKind.get(k).map((f) => el('div', { class: 'rli-audio__row' },
              el('span', { class: 'rli-audio__name', title: f.rel }, f.rel),
              el('audio', { controls: '', preload: 'none', src: rawUrl(f.path) }))))
            : el('div', { class: `rli-tiles${dense ? ' rli-tiles--dense' : ''}` }, byKind.get(k).map((f) => fileTile(t, f, { list: files }))),
        )),
    );
  }

  let delivMode = 'compare';
  async function buildDeliverables() {
    const t = await load();
    const body = el('div', { class: 'rli-deliv__body' });
    const seg = el('div', { class: 'seg rli-seg', role: 'group' });
    const modes = [
      ['compare', 'RD · AD1 · AD2'],
      ['input', `Inputs (${t.files.input.length})`],
      ['golden', 'RD'],
      ['ad1', 'AD1'],
      ['ad2', 'AD2'],
    ];
    const render = () => {
      for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.mode === delivMode));
      if (delivMode === 'compare') {
        mount(body, el('div', { class: 'rli-cols' }, sideColumn(t, 'golden', { dense: true }), sideColumn(t, 'ad1', { dense: true }), sideColumn(t, 'ad2', { dense: true })));
      } else {
        mount(body, el('div', { class: 'rli-cols rli-cols--one' }, sideColumn(t, delivMode)));
      }
    };
    for (const [m, label] of modes) {
      seg.append(el('button', { type: 'button', 'data-mode': m, 'aria-pressed': 'false', onclick: () => { delivMode = m; render(); } }, label));
    }
    render();
    return el('div', { class: 'rli rli-deliv' },
      el('div', { class: 'rli-toolbar', title: 'Click any file to open it. ← → step through a side; C compares the same file across RD / AD1 / AD2.' }, seg),
      body,
    );
  }

  // ---------- lightbox viewer ----------
  let lb = null;
  function closeViewer() { lb?.remove(); lb = null; document.removeEventListener('keydown', onKey); }
  let lbState = null;
  function onKey(e) {
    if (!lbState) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key.toLowerCase() === 'c') toggleCompare();
  }
  function step(d) {
    const { list, i } = lbState;
    const j = (i + d + list.length) % list.length;
    lbState.i = j;
    renderViewer();
  }
  function toggleCompare() { lbState.compare = !lbState.compare; renderViewer(); }

  function openViewer(t, f, list) {
    closeViewer();
    lbState = { t, list, i: Math.max(0, list.findIndex((x) => x.path === f.path)), compare: false };
    lb = el('div', { class: 'rli-lb', onclick: (e) => { if (e.target === lb) closeViewer(); } });
    document.body.append(lb);
    document.addEventListener('keydown', onKey);
    renderViewer();
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
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => step(-1) }, '←'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => step(1) }, '→'),
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: closeViewer }, '✕'),
      ),
      stage,
    );
  }

  function mediaNode(f, { compact = false } = {}) {
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

  // three.js loaded on demand from esm.sh (rewrites bare 'three' imports, so no import map needed).
  let three = null;
  async function loadThree() {
    if (three) return three;
    const v = '0.160.0';
    const [T, orbit, obj, fbx, gltf, stl, ply] = await Promise.all([
      import(`https://esm.sh/three@${v}`),
      import(`https://esm.sh/three@${v}/examples/jsm/controls/OrbitControls.js`),
      import(`https://esm.sh/three@${v}/examples/jsm/loaders/OBJLoader.js`),
      import(`https://esm.sh/three@${v}/examples/jsm/loaders/FBXLoader.js`),
      import(`https://esm.sh/three@${v}/examples/jsm/loaders/GLTFLoader.js`),
      import(`https://esm.sh/three@${v}/examples/jsm/loaders/STLLoader.js`),
      import(`https://esm.sh/three@${v}/examples/jsm/loaders/PLYLoader.js`),
    ]);
    three = { T, OrbitControls: orbit.OrbitControls, OBJLoader: obj.OBJLoader, FBXLoader: fbx.FBXLoader, GLTFLoader: gltf.GLTFLoader, STLLoader: stl.STLLoader, PLYLoader: ply.PLYLoader };
    return three;
  }

  function model3d(f, compact) {
    const host = el('div', { class: `rli-3d${compact ? ' rli-3d--compact' : ''}` });
    const status = el('div', { class: 'rli-3d__status' }, 'Loading 3D viewer…');
    const toolbar = el('div', { class: 'rli-3d__tools' });
    host.append(status, toolbar);
    (async () => {
      try {
        const { T, OrbitControls, OBJLoader, FBXLoader, GLTFLoader, STLLoader, PLYLoader } = await loadThree();
        const w = host.clientWidth || 800, h = host.clientHeight || 520;
        const renderer = new T.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(w, h);
        host.prepend(renderer.domElement);
        const scene = new T.Scene();
        scene.background = new T.Color(document.documentElement.dataset.theme === 'light' ? 0xf1f1f3 : 0x16171b);
        const camera = new T.PerspectiveCamera(45, w / h, 0.001, 100000);
        scene.add(new T.HemisphereLight(0xffffff, 0x444455, 1.1));
        const key = new T.DirectionalLight(0xffffff, 1.2); key.position.set(3, 5, 4); scene.add(key);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        const url = rawUrl(f.path);
        const ext = f.name.split('.').pop().toLowerCase();
        status.textContent = `Loading ${f.name} (${fmtSize(f.size)})…`;
        const material = new T.MeshStandardMaterial({ color: 0xc9ccd6, roughness: 0.6, metalness: 0.05, side: T.DoubleSide });
        let obj3d;
        if (ext === 'obj') obj3d = await new OBJLoader().loadAsync(url);
        else if (ext === 'fbx') obj3d = await new FBXLoader().loadAsync(url);
        else if (ext === 'glb' || ext === 'gltf') obj3d = (await new GLTFLoader().loadAsync(url)).scene;
        else if (ext === 'stl') obj3d = new T.Mesh(await new STLLoader().loadAsync(url), material);
        else if (ext === 'ply') obj3d = new T.Mesh(await new PLYLoader().loadAsync(url), material);
        let meshes = 0, tris = 0;
        const originals = new Map();
        obj3d.traverse((o) => {
          if (o.isMesh) {
            meshes++;
            const g = o.geometry;
            tris += g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
            originals.set(o, o.material);
            if (ext === 'obj' || !o.material) o.material = material;
          }
        });
        scene.add(obj3d);
        const box = new T.Box3().setFromObject(obj3d);
        const size = box.getSize(new T.Vector3()), center = box.getCenter(new T.Vector3());
        const radius = size.length() / 2 || 1;
        controls.target.copy(center);
        camera.position.copy(center).add(new T.Vector3(radius * 1.4, radius * 0.9, radius * 1.6));
        camera.near = radius / 1000; camera.far = radius * 100; camera.updateProjectionMatrix();
        status.textContent = `${meshes} mesh${meshes === 1 ? '' : 'es'} · ${Math.round(tris).toLocaleString()} tris · ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} units`;
        let wire = false;
        toolbar.append(
          el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => { wire = !wire; obj3d.traverse((o) => { if (o.isMesh) [].concat(o.material).forEach((m) => { m.wireframe = wire; }); }); } }, 'Wireframe'),
          el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => { camera.position.copy(center).add(new T.Vector3(radius * 1.4, radius * 0.9, radius * 1.6)); controls.target.copy(center); } }, 'Reset view'),
        );
        let alive = true;
        const tick = () => { if (!alive || !host.isConnected) { alive = false; renderer.dispose(); return; } controls.update(); renderer.render(scene, camera); requestAnimationFrame(tick); };
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
  const rubricFilter = { q: '', cat: '', only: '' };
  async function buildRubric() {
    const t = await load();
    const weights = t.checks.find((c) => c.id === 'weights');
    const mix = weights?.mix;
    const cats = [...new Set(t.criteria.map((c) => c.category))].sort();
    const rows = el('div', { class: 'rli-crits' });
    const count = el('span', { class: 'hint-line' });

    const verdictChip = (c, side) => {
      const v = c.verdicts[side];
      if (v.passed == null) return el('span', { class: 'rli-v is-na' }, '—');
      const neg = c.weight < 0;
      const label = neg ? (v.passed ? 'present' : 'absent') : (v.passed ? 'pass' : 'fail');
      return el('span', { class: `rli-v ${v.good ? 'is-good' : 'is-bad'}`, title: `${SIDE_LABEL[side]}: ${label}` }, v.good ? '✓' : '✕');
    };
    const matches = (c) => {
      const f = rubricFilter;
      if (f.q && !(`C${c.n} ${c.title}`.toLowerCase().includes(f.q.toLowerCase()))) return false;
      if (f.cat && c.category !== f.cat) return false;
      const g = c.verdicts.golden.good, a1 = c.verdicts.ad1.good, a2 = c.verdicts.ad2.good;
      if (f.only === 'ad1only' && !(g && !a1 && a2)) return false;
      if (f.only === 'goldenfail' && g !== false) return false;
      if (f.only === 'split' && new Set([g, a1, a2]).size < 2) return false;
      if (f.only === 'negative' && c.weight >= 0) return false;
      if (f.only === 'heavy' && Math.abs(c.weight) < 8) return false;
      return true;
    };
    const renderRows = () => {
      const shown = t.criteria.filter(matches);
      count.textContent = `${shown.length} of ${t.criteria.length} criteria`;
      mount(rows, shown.map((c) => {
        const detail = el('div', { class: 'rli-crit__detail', hidden: '' },
          ['golden', 'ad1', 'ad2'].map((s) => el('div', { class: `rli-just ${c.verdicts[s].good ? 'is-good' : c.verdicts[s].good === false ? 'is-bad' : ''}` },
            el('div', { class: 'rli-just__head' }, verdictChip(c, s), el('b', {}, SIDE_LABEL[s]),
              el('span', { class: 'rli-just__model' }, modelLine(t, s)),
              el('span', { class: 'rli-just__raw' }, c.weight < 0 ? (c.verdicts[s].passed ? 'defect present' : 'defect absent') : (c.verdicts[s].passed ? 'passed' : 'failed'))),
            el('div', { class: 'rli-just__text' }, c.verdicts[s].justification || '(no justification)'))));
        const row = el('div', { class: `rli-crit${c.weight < 0 ? ' is-neg' : ''}`, id: `crit-C${c.n}` },
          el('button', { type: 'button', class: 'rli-crit__row', onclick: () => { detail.hidden = !detail.hidden; row.classList.toggle('is-open', !detail.hidden); } },
            el('span', { class: 'rli-crit__n' }, `C${c.n}`),
            el('span', { class: 'rli-crit__title' }, c.title),
            el('span', { class: `rli-w ${c.weight < 0 ? 'is-neg' : Math.abs(c.weight) >= 8 ? 'is-crit' : ''}`, title: 'weight' }, c.weight > 0 ? `+${c.weight}` : String(c.weight)),
            el('span', { class: `rli-cat b-${c.bucket}`, title: `bucket: ${c.bucket}` }, c.category || '—'),
            el('span', { class: 'rli-crit__vs' }, verdictChip(c, 'golden'), verdictChip(c, 'ad1'), verdictChip(c, 'ad2')),
          ),
          detail,
        );
        return row;
      }));
    };

    const onlyBtn = (key, label) => el('button', { type: 'button', 'aria-pressed': String(rubricFilter.only === key),
      onclick: (e) => { rubricFilter.only = rubricFilter.only === key ? '' : key; for (const b of e.currentTarget.parentNode.children) b.setAttribute('aria-pressed', String(b === e.currentTarget && !!rubricFilter.only)); renderRows(); } }, label);
    const search = el('input', { class: 'input rli-search', type: 'search', placeholder: 'Search criteria…', oninput: (e) => { rubricFilter.q = e.target.value; renderRows(); } });
    search.value = rubricFilter.q;
    const catSel = el('select', { class: 'select', onchange: (e) => { rubricFilter.cat = e.target.value; renderRows(); } },
      el('option', { value: '' }, 'All categories'), cats.map((c) => el('option', { value: c }, c)));
    catSel.value = rubricFilter.cat;
    renderRows();

    return el('div', { class: 'rli rli-rubric' },
      mix ? mixBar(mix, weights) : null,
      el('div', { class: 'rli-toolbar rli-toolbar--wrap' }, search, catSel,
        el('div', { class: 'seg rli-seg' },
          onlyBtn('split', 'Verdicts differ'), onlyBtn('ad1only', 'Only AD1 fails'), onlyBtn('goldenfail', 'Golden fails'),
          onlyBtn('heavy', '|w| ≥ 8'), onlyBtn('negative', 'Penalties')),
        el('span', { class: 'spacer' }), count),
      el('div', { class: 'rli-crits__head' }, el('span', {}, '#'), el('span', {}, 'Criterion'), el('span', {}, 'Weight'), el('span', {}, 'Category'),
        el('span', { class: 'rli-crit__vs' }, el('span', {}, 'RD'), el('span', {}, 'AD1'), el('span', {}, 'AD2'))),
      rows,
      el('p', { class: 'hint-line' }, 'Penalty criteria (negative weight) show ✕ when the defect is present — that is what the record\'s "passed: true" means on a penalty, and it matches the printed scores.'),
    );
  }

  function mixBar(mix, check) {
    const seg = (b, label, val, target) => el('div', { class: `rli-mix__seg b-${b}`, style: `flex: ${Math.max(val || 0, 0.001)}`, title: `${label}: ${val}% (target ${target}%)` },
      (val || 0) >= 7 ? `${label} ${val}%` : '');
    return el('div', { class: `rli-mix is-${check.status}` },
      el('div', { class: 'rli-mix__head' },
        el('b', {}, 'Weight mix'), el('span', { class: 'hint-line' }, 'share of positive weight · target 5 / 30 / 65 · quality ≥ 65% is the hard gate'),
        el('span', { class: 'spacer' }), statusPill(check.status)),
      el('div', { class: 'rli-mix__bar' },
        seg('format', 'Format', mix.format, 5), seg('brief', 'Brief', mix.brief, 30), seg('quality', 'Quality', mix.quality, 65),
        mix.other ? seg('other', 'Other', mix.other, 0) : null,
        el('i', { class: 'rli-mix__gate', style: 'left: 35%', title: '65% quality gate' })),
      el('div', { class: 'rli-mix__legend' }, mix.byCategory.map((c) => el('span', { class: `rli-cat b-${c.bucket}` }, `${c.category} ${c.pct}%`))),
    );
  }

  function statusPill(s) {
    const txt = { pass: 'Pass', fail: 'Fail', warn: 'Check', info: 'Note', na: 'N/A' }[s] || s;
    return el('span', { class: `rli-pill is-${s}` }, el('span', { class: 'rli-pill__i' }, statusIcon[s] || '·'), txt);
  }

  // ---------- Preference ----------
  // One matrix: dimensions × the three comparisons. Each cell is a 1–7 scale
  // with the pick marked and tinted toward the side it favours; justifications
  // sit collapsed underneath.
  async function buildPreference() {
    const t = await load();
    const comps = t.pref?.comparisons || [];
    if (!comps.length) return el('div', { class: 'rli rli-prefs' }, el('div', { class: 'callout warn' }, 'No preference ranking in this record.'));
    const align = new Map((t.checks.find((c) => c.id === 'alignment')?.align || []).map((a) => [a.pair, a]));
    const sc = (lbl) => t.scores?.[{ RD: 'golden', AD1: 'ad1', AD2: 'ad2' }[lbl]]?.percentage;
    const dims = [];
    for (const c of comps) for (const d of c.dimensions || []) if (!dims.find((x) => x.id === d.id)) dims.push({ id: d.id, title: d.title || d.id });
    const lean = (score, c) => (score < 4 ? c.left : score > 4 ? c.right : '≈');
    const strength = (score) => ['', 'strongly', 'clearly', 'slightly', '', 'slightly', 'clearly', 'strongly'][score] || '';
    const cell = (c, d) => {
      const s = Number(d?.score);
      if (!s) return el('td', { class: 'rli-pm__cell' }, '—');
      const side = s < 4 ? 'l' : s > 4 ? 'r' : 'm';
      return el('td', { class: `rli-pm__cell is-${side}`, title: `${d.score}: ${s === 4 ? 'comparable' : `${lean(s, c)} ${strength(s)} better`}` },
        el('div', { class: 'rli-pm__scale' }, [1, 2, 3, 4, 5, 6, 7].map((k) => el('i', { class: `${k === s ? 'on' : ''}${k === 4 ? ' mid' : ''}` }))),
        el('span', { class: 'rli-pm__lbl' }, s === 4 ? '≈' : lean(s, c), el('b', {}, String(s))));
    };
    const mean = (c) => {
      const xs = (c.dimensions || []).map((d) => Number(d.score)).filter(Boolean);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 4;
    };
    const issues = [...align.values()].filter((a) => a.why);
    return el('div', { class: 'rli rli-prefs' },
      issues.length ? el('div', { class: 'rli-inline-issues' }, issues.map((a) => el('div', { class: `rli-issue is-${a.status}` }, statusPill(a.status), el('span', {}, a.why)))) : null,
      el('table', { class: 'rli-pm' },
        el('thead', {}, el('tr', {},
          el('th', { class: 'rli-pm__dimh' }, el('span', {}, '1 = left better · 7 = right better')),
          comps.map((c) => {
            const a = align.get(c.pair);
            return el('th', {},
              el('div', { class: 'rli-pm__pair' }, el('b', {}, c.left), el('span', {}, 'vs'), el('b', {}, c.right), a ? el('span', { class: `rli-dot is-${a.status}`, title: a.why || 'Preference and rubric agree' }) : null),
              el('div', { class: 'rli-pm__rub' }, `rubric ${pct(sc(c.left))} · ${pct(sc(c.right))}`));
          }))),
        el('tbody', {},
          dims.map((d) => el('tr', {}, el('th', { class: 'rli-pm__dim' }, d.title), comps.map((c) => cell(c, (c.dimensions || []).find((x) => x.id === d.id))))),
          el('tr', { class: 'rli-pm__overall' }, el('th', { class: 'rli-pm__dim' }, 'Mean'),
            comps.map((c) => { const m = mean(c); return el('td', { class: `rli-pm__cell is-${m < 3.5 ? 'l' : m > 4.5 ? 'r' : 'm'}` }, el('b', {}, m.toFixed(1)), ' ', el('span', { class: 'rli-pm__lean' }, m < 3.5 ? `favours ${c.left}` : m > 4.5 ? `favours ${c.right}` : 'comparable')); })),
        )),
      el('div', { class: 'rli-justs' }, comps.map((c) => {
        const body = el('div', { class: 'cb-prose rli-clamp' });
        body.innerHTML = renderMarkdown(c.justification || '_(none)_');
        const box = el('div', { class: 'rli-justcard' },
          el('div', { class: 'rli-justcard__head' }, el('b', {}, `${c.left} vs ${c.right}`), el('span', { class: 'hint-line' }, 'justification')),
          body,
          el('button', { type: 'button', class: 'link', onclick: (e) => { const open = body.classList.toggle('is-open'); e.currentTarget.textContent = open ? 'Show less' : 'Read all'; } }, 'Read all'));
        return box;
      })),
      t.pref.rd_better_than_ads != null ? el('p', { class: 'hint-line' }, `Contributor marked RD better than the ADs: ${t.pref.rd_better_than_ads ? 'yes' : 'no'}.`) : null,
    );
  }

  // ---------- Audit (checks + auditor dimensions + docs) ----------
  async function buildAudit(specDims = [], docs = {}) {
    const t = await load();
    const auto = new Set(t.checks.map((c) => c.dim).filter(Boolean));
    const human = specDims.filter((d) => !auto.has(d.key));
    const order = { fail: 0, warn: 1, info: 2 };
    const open = t.checks.filter((c) => c.status in order).sort((a, b) => order[a.status] - order[b.status]);
    const passed = t.checks.filter((c) => c.status === 'pass');
    const na = t.checks.filter((c) => c.status === 'na');
    const row = (c) => {
      const more = c.detail || c.note || c.evidence?.length;
      const detail = more ? el('div', { class: 'rli-row__more', hidden: c.status === 'fail' ? null : '' },
        c.detail ? el('div', { class: 'rli-row__detail' }, c.detail) : null,
        c.note ? el('div', { class: 'rli-row__note' }, c.note) : null,
        c.evidence?.length ? el('div', { class: 'rli-row__ev' }, c.evidence.slice(0, 24).map(critChip)) : null) : null;
      if (detail && c.status === 'fail') detail.removeAttribute('hidden');
      return el('div', { class: `rli-row is-${c.status}` },
        el('button', { type: 'button', class: 'rli-row__main', onclick: () => { if (detail) detail.hidden = !detail.hidden; } },
          el('span', { class: `rli-dot is-${c.status}` }),
          el('b', {}, c.label),
          el('span', { class: 'rli-row__sum' }, c.summary),
          specChip(c.dim),
          more ? el('span', { class: 'rli-row__chev' }, '▾') : null),
        detail);
    };
    const docCard = (key, label, blurb) => el('button', { type: 'button', class: `rli-doc${docs[key] ? ' is-ready' : ''}`, onclick: () => onOpenDoc(key) },
      el('b', {}, label),
      el('span', {}, docs[key] ? 'Open' : 'Not generated yet'),
      el('p', {}, blurb));
    return el('div', { class: 'rli rli-audit' },
      el('section', { class: 'rli-sec' },
        el('header', { class: 'rli-sec__head' }, el('h3', {}, 'Automated checks'), el('span', { class: 'hint-line' }, 'decided from the record alone')),
        open.length ? el('div', { class: 'rli-rows' }, open.map(row)) : el('div', { class: 'rli-allclear' }, 'Nothing flagged.'),
        passed.length || na.length ? el('div', { class: 'rli-passline' },
          el('span', { class: 'rli-passline__lbl' }, `${passed.length} passed`),
          passed.map((c) => el('button', { type: 'button', class: 'rli-passchip', title: c.summary, onclick: () => onSpec(c.dim) }, '✓ ', c.label.split(' (')[0])),
          na.map((c) => el('span', { class: 'rli-passchip is-na', title: c.summary }, `– ${c.label} (n/a)`))) : null),
      el('section', { class: 'rli-sec' },
        el('header', { class: 'rli-sec__head' }, el('h3', {}, 'Auditor dimensions'), el('span', { class: 'hint-line' }, `${human.length} need eyes on the files and the rubric`)),
        el('div', { class: 'rli-dims' }, human.map((d) => el('button', { type: 'button', class: 'rli-dim', onclick: () => onSpec(d.key), title: d.description?.slice(0, 300) || '' },
          el('span', { class: 'rli-dim__k' }, d.key), el('span', { class: 'rli-dim__n' }, d.name), el('span', { class: 'rli-dim__c' }, d.category))))),
      el('section', { class: 'rli-sec' },
        el('header', { class: 'rli-sec__head' }, el('h3', {}, 'Reports')),
        el('div', { class: 'rli-docs' },
          docCard('review', 'Review', 'Findings per spec dimension, each with the evidence that decides it.'),
          docCard('remediation', 'Remediation', 'The fix list for the contributor, with approve / edit / deny on each fix.'))),
    );
  }

  function flashCrit(n) {
    const row = document.getElementById(`crit-C${n}`);
    if (!row) return false;
    row.querySelector('.rli-crit__detail')?.removeAttribute('hidden');
    row.classList.add('is-open', 'flash');
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => row.classList.remove('flash'), 1600);
    return true;
  }

  return { load, summaryBar, buildBrief, buildDeliverables, buildRubric, buildPreference, buildAudit, flashCrit, resetFilter: () => { rubricFilter.q = ''; rubricFilter.cat = ''; rubricFilter.only = ''; } };
}
