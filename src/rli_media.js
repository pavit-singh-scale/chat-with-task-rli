// Measurements for video and audio artifacts, so the eval (and the auditor)
// can check claims about media the model cannot watch or hear.
//
// Run once at ingest by deriveTask() and cached under files/_derived/:
//   <rel>.media.json   duration, codecs, resolution/fps, sample rate, bit
//                      depth, peak/RMS, silence spans, clipping/truncation flags
//   <rel>.frames/      evenly spaced stills from a video (f01.jpg …)
//
// Two ffmpeg traps, both learned the hard way on this project:
//   - astats and silencedetect report through the filter logger at INFO level;
//     with -v error every number is dropped and the command still exits 0.
//   - deliverables include 24-bit WAV, so never assume 16-bit samples — let
//     ffmpeg decode and only read its measurements.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

function which(bin) {
  try { return execFileSync('which', [bin], { stdio: 'pipe' }).toString().trim() || null; } catch { return null; }
}
const FFMPEG = which('ffmpeg');
const FFPROBE = which('ffprobe');
export const mediaTools = () => ({ ffmpeg: !!FFMPEG, ffprobe: !!FFPROBE });

export const FRAME_COUNT = 6;
const SILENCE_DB = -60;          // below this is silence
const SILENCE_MIN_S = 0.5;
const EDGE_SILENCE_S = 2;        // leading/trailing silence longer than this is flagged
const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

function ffprobe(abs) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out.toString('utf8'));
}

function fps(rate) {
  const [n, d] = String(rate || '').split('/').map(Number);
  return n && d ? round(n / d, 3) : null;
}

// One decode pass: overall levels (astats) + silence spans (silencedetect).
// Both report on stderr, so read it from spawnSync rather than execFileSync.
function audioLevels(abs) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-v', 'info', '-i', abs, '-vn',
    '-af', `astats=measure_perchannel=none,silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_MIN_S}`, '-f', 'null', '-'],
  { encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r.stderr || '';
}

function parseLevels(log) {
  // astats prints an "Overall" block last; take the last occurrence of each key.
  const last = (key) => {
    const all = [...log.matchAll(new RegExp(`${key}:\\s*(-?[\\d.]+|-inf)`, 'g'))];
    if (!all.length) return null;
    const v = all[all.length - 1][1];
    return v === '-inf' ? -Infinity : Number(v);
  };
  const spans = [];
  let open = null;
  for (const line of log.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) { open = Math.max(0, Number(s[1])); continue; }
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && open != null) { spans.push([round(open), round(Number(e[1]))]); open = null; }
  }
  return {
    peak_db: last('Peak level dB'),
    rms_db: last('RMS level dB'),
    flat_factor: last('Flat factor'),
    peak_count: last('Peak count'),
    spans,
    openSilenceFrom: open, // silence that never ended = runs to end of file
  };
}

export function probeMedia(abs) {
  if (!FFPROBE) return null;
  const info = ffprobe(abs);
  const v = info.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = info.streams.find((s) => s.codec_type === 'audio');
  const duration = round(Number(info.format?.duration) || Number(v?.duration) || Number(a?.duration));
  const out = { duration_s: duration, container: info.format?.format_name || null, size_bytes: Number(info.format?.size) || null };
  if (v) {
    const w = v.width, h = v.height;
    const rot = Number(v.side_data_list?.find((d) => d.rotation != null)?.rotation || v.tags?.rotate || 0);
    const [W, H] = Math.abs(rot) === 90 ? [h, w] : [w, h];
    out.video = { codec: v.codec_name, width: W, height: H, fps: fps(v.avg_frame_rate || v.r_frame_rate),
      orientation: W > H ? 'landscape' : W < H ? 'portrait' : 'square', aspect: v.display_aspect_ratio || null,
      bitrate_kbps: v.bit_rate ? Math.round(v.bit_rate / 1000) : null };
  }
  if (a) {
    out.audio = { codec: a.codec_name, sample_rate: Number(a.sample_rate) || null, channels: a.channels || null,
      layout: a.channel_layout || null, bit_depth: Number(a.bits_per_raw_sample || a.bits_per_sample) || null,
      sample_fmt: a.sample_fmt || null, bitrate_kbps: a.bit_rate ? Math.round(a.bit_rate / 1000) : null };
    if (FFMPEG) {
      const L = parseLevels(audioLevels(abs));
      const spans = L.spans.slice();
      if (L.openSilenceFrom != null && duration) spans.push([round(L.openSilenceFrom), duration]);
      const leading = spans.find(([s]) => s <= 0.05);
      const trailing = duration ? spans.find(([, e]) => duration - e <= 0.25) : null;
      const len = (sp) => (sp ? round(sp[1] - sp[0]) : 0);
      Object.assign(out.audio, {
        peak_db: round(L.peak_db, 1), rms_db: round(L.rms_db, 1),
        silent: L.peak_db === -Infinity || (L.peak_db != null && L.peak_db < SILENCE_DB),
        leading_silence_s: len(leading), trailing_silence_s: len(trailing),
        silence_total_s: round(spans.reduce((s, sp) => s + (sp[1] - sp[0]), 0)),
        silence_spans: spans.slice(0, 40),
        // A true-peak at full scale that also sits flat there, or keeps hitting
        // it — not just a loud master that touches −0.1 dB once.
        likely_clipping: L.peak_db != null && L.peak_db >= -0.1 && ((L.flat_factor ?? 0) > 0 || (L.peak_count ?? 0) >= 8),
        likely_truncated: len(trailing) > EDGE_SILENCE_S,
      });
    }
  }
  return out;
}

export function extractFrames(abs, outDir, duration, n = FRAME_COUNT) {
  if (!FFMPEG || !duration) return [];
  fs.mkdirSync(outDir, { recursive: true });
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = round(duration * (i + 0.5) / n, 3); // centres of n equal slices — skips black first/last frames
    const out = path.join(outDir, `f${String(i + 1).padStart(2, '0')}.jpg`);
    try {
      execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-ss', String(t), '-i', abs, '-frames:v', '1',
        '-vf', "scale='min(1568,iw)':-2", '-q:v', '3', out], { stdio: 'pipe', timeout: 120_000 });
      if (fs.existsSync(out) && fs.statSync(out).size > 0) frames.push({ file: path.basename(out), t });
    } catch { /* keep the frames that worked */ }
  }
  return frames;
}

// Plain-language flags for the UI and the eval.
export function mediaFlags(m) {
  if (!m) return [];
  const f = [];
  if (m.audio?.silent) return ['audio track is silent'];
  if (m.audio?.likely_clipping) f.push(`possible clipping (peak ${m.audio.peak_db} dB)`);
  if (m.audio?.likely_truncated) f.push(`${m.audio.trailing_silence_s}s of silence at the end`);
  if (m.audio?.leading_silence_s > EDGE_SILENCE_S) f.push(`${m.audio.leading_silence_s}s of silence at the start`);
  return f;
}
