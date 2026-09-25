// Browser-viewable derivatives for artifact formats a browser can't open.
//
// Run once at ingest (tools/rli/derive.mjs) and cached under files/_derived/,
// so the web app only ever serves GLB / SVG / PNG and a hosted deploy never
// needs Blender or libredwg:
//   .blend        → Blender CLI (headless) → .glb       real 3D
//   .dwg          → libredwg dwg2SVG       → .svg       2D drawing
//   .dxf          → served as-is to the client DXF viewer
//   .skp          → the preview PNG SketchUp embeds in every save (a snapshot,
//                   not a render). Full 3D for SketchUp / Revit / Max needs
//                   Autodesk's Model Derivative service (APS) — see apsStatus().
//   .3ds .obj .fbx .glb .stl  load natively in the three.js viewer.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BLENDER = ['/Applications/Blender.app/Contents/MacOS/Blender', 'blender'].find((b) => b.includes('/') ? fs.existsSync(b) : which(b));
const DWG2SVG = which('dwg2SVG');
const DWG2DXF = which('dwg2dxf');

function which(bin) {
  try { return execFileSync('which', [bin], { stdio: 'pipe' }).toString().trim() || null; } catch { return null; }
}

export function derivedPath(taskDir, rel, ext) {
  // rel is "files/<side>/<path>"; mirror it under files/_derived/
  return path.join(taskDir, 'files', '_derived', rel.replace(/^files\//, '') + ext);
}

// SketchUp stores a PNG preview near the head of every .skp — lift it out.
function skpThumbnail(src, out) {
  const fd = fs.openSync(src, 'r');
  const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 8_000_000));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const start = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (start < 0) return false;
  const iend = buf.indexOf(Buffer.from('IEND'), start);
  if (iend < 0) return false;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf.subarray(start, iend + 8));
  return true;
}

const BLEND_PY = `
import bpy, sys
out = sys.argv[sys.argv.index('--') + 1]
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_apply=True, export_yup=True)
`;

function blendToGlb(src, out) {
  if (!BLENDER) return false;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const py = path.join(path.dirname(out), '_export.py');
  fs.writeFileSync(py, BLEND_PY);
  try {
    execFileSync(BLENDER, ['-b', src, '--python', py, '--', out], { stdio: 'pipe', timeout: 600_000 });
  } finally { fs.rmSync(py, { force: true }); }
  return fs.existsSync(out) && fs.statSync(out).size > 0;
}

function dwgToSvg(src, out) {
  if (!DWG2SVG) return false;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const svg = execFileSync(DWG2SVG, [src], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024, timeout: 300_000 });
  if (!svg.length) return false;
  // libredwg strokes everything white at 0 width (AutoCAD's dark-canvas
  // defaults), which is invisible on paper. Draw dark hairlines that stay 1px
  // at any zoom, and keep coloured layers readable on white.
  const fixed = svg.toString('utf8')
    .replace(/stroke:\s*(white|#fff(?:fff)?|rgb\(255,\s*255,\s*255\))/gi, 'stroke:#1d1f24')
    .replace(/stroke:\s*(yellow|#ffff00)/gi, 'stroke:#a37c00')
    .replace(/stroke-width:\s*0(\.0+)?px/g, 'stroke-width:1px;vector-effect:non-scaling-stroke')
    .replace(/fill:\s*(white|#fff(?:fff)?)/gi, 'fill:#1d1f24');
  fs.writeFileSync(out, fixed);
  return true;
}

// DWG → DXF for the in-browser CAD viewer (full model space, text, pan/zoom).
function dwgToDxf(src, out) {
  if (!DWG2DXF) return false;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try { execFileSync(DWG2DXF, ['-y', '-o', out, src], { stdio: 'pipe', timeout: 300_000 }); } catch { /* dwg2dxf exits non-zero on warnings */ }
  return fs.existsSync(out) && fs.statSync(out).size > 0;
}

const RULES = [
  { re: /\.dwg$/i, ext: '.dxf', kind: 'cad2d', label: 'Converted from .dwg with libredwg', run: dwgToDxf },
  { re: /\.skp$/i, ext: '.preview.png', kind: 'image', label: 'Embedded SketchUp preview (saved snapshot, not a render)', run: skpThumbnail },
  { re: /\.blend$/i, ext: '.glb', kind: 'model3d', label: 'Converted from .blend with Blender', run: blendToGlb },
  { re: /\.dwg$/i, ext: '.svg', kind: 'drawing', label: 'Sheet preview from .dwg (libredwg)', run: dwgToSvg },
];

// Existing derivative for a file, or null.
export function derivedFor(taskDir, rel) {
  const hits = [];
  for (const r of RULES) {
    if (!r.re.test(rel)) continue;
    const out = derivedPath(taskDir, rel, r.ext);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      hits.push({ kind: r.kind, label: r.label, path: path.relative(taskDir, out).split(path.sep).join('/') });
    }
  }
  if (!hits.length) return null;
  const best = { ...hits[0] };
  const thumb = hits.find((h) => h.kind === 'drawing' || h.kind === 'image');
  if (thumb && thumb !== hits[0]) best.thumb = thumb.path;
  return best;
}

// Build every missing derivative for one task. Returns a per-file log.
export function deriveTask(taskDir, { force = false, log = () => {} } = {}) {
  const results = [];
  for (const side of ['input', 'golden', 'ad1', 'ad2']) {
    const root = path.join(taskDir, 'files', side);
    if (!fs.existsSync(root)) continue;
    (function walk(d) {
      for (const name of fs.readdirSync(d)) {
        const abs = path.join(d, name);
        if (fs.statSync(abs).isDirectory()) { walk(abs); continue; }
        const rel = path.relative(taskDir, abs).split(path.sep).join('/');
        for (const rule of RULES.filter((r) => r.re.test(name))) {
        const out = derivedPath(taskDir, rel, rule.ext);
        if (!force && fs.existsSync(out)) { results.push({ rel, status: 'cached' }); continue; }
        try {
          const ok = rule.run(abs, out);
          results.push({ rel, status: ok ? 'ok' : 'none' });
          log(`${ok ? '✓' : '·'} ${rel} → ${ok ? rule.ext : 'no derivative (tool missing or no preview)'}`);
        } catch (e) {
          results.push({ rel, status: 'error', error: String(e.message || e).slice(0, 200) });
          log(`✕ ${rel}: ${String(e.message || e).split('\n')[0]}`);
        }
        }
      }
    })(root);
  }
  return results;
}

export const toolStatus = () => ({ blender: !!BLENDER, dwg2svg: !!DWG2SVG, aps: !!(process.env.APS_CLIENT_ID && process.env.APS_CLIENT_SECRET) });
