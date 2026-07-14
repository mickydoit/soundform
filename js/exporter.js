import { projectStrand, rdp, toBezierPath, buildDensityGrid } from './strands.js?v=27';
import { sampleRamp, rgbToHex } from './palettes.js?v=27';

export async function exportCanvas(canvas, format) {
  switch (format) {
    case 'png':
      _dl(canvas.toDataURL('image/png'), 'soundform.png');
      break;

    case 'jpg':
      _dl(_onBlack(canvas, 'image/jpeg', 0.95), 'soundform.jpg');
      break;

    case 'webp':
      _dl(canvas.toDataURL('image/webp', 0.95), 'soundform.webp');
      break;

    case 'pdf': {
      const { jsPDF } = window.jspdf;
      const w = canvas.width, h = canvas.height;
      const mmW = w > h ? 297 : 210;
      const mmH = mmW * (h / w);
      const doc = new jsPDF({
        orientation: w > h ? 'landscape' : 'portrait',
        unit: 'mm',
        format: [mmW, mmH],
      });
      doc.addImage(_onBlack(canvas, 'image/jpeg', 0.92), 'JPEG', 0, 0, mmW, mmH);
      doc.save('soundform.pdf');
      break;
    }
  }
}

// Composite WebGL canvas (alpha channel) onto a solid background before saving as JPEG
function _onBlack(canvas, mime, quality) {
  const tmp = document.createElement('canvas');
  tmp.width  = canvas.width;
  tmp.height = canvas.height;
  const ctx = tmp.getContext('2d');
  ctx.fillStyle = '#060810';
  ctx.fillRect(0, 0, tmp.width, tmp.height);
  ctx.drawImage(canvas, 0, 0);
  return tmp.toDataURL(mime, quality);
}

function _dl(url, name) {
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// Structured vector export: one named group per strand, real bezier paths,
// density-driven stroke weight/opacity, palette gradient along each path.
export function exportStrandSVG({ strands, positions, mvp, width, height, stops, background, weight }) {
  const grid = buildDensityGrid(positions);
  const items = [];

  strands.forEach((strand, si) => {
    const { pts, depth } = projectStrand(strand, mvp, width, height);
    if (pts.length < 2) return;
    const simplified = rdp(pts, 1.4);
    if (simplified.length < 2 || simplified.length > 300) return;
    // mean local 3D density along the strand
    let dSum = 0, dN = 0;
    for (let i = 0; i < strand.length; i += 30) {
      dSum += grid.sample(strand[i], strand[i + 1], strand[i + 2]); dN++;
    }
    const density = dN ? dSum / dN : 0.3;
    items.push({ si, depth, density, d: toBezierPath(simplified),
                 x1: simplified[0][0], y1: simplified[0][1],
                 x2: simplified[simplified.length - 1][0], y2: simplified[simplified.length - 1][1] });
  });

  items.sort((a, b) => b.depth - a.depth); // far strands first (painter's order)

  const defs = [], groups = [];
  items.forEach((it, order) => {
    const id = String(order + 1).padStart(2, '0');
    const c1 = rgbToHex(sampleRamp(stops, 0.35 + it.density * 0.3));
    const c2 = rgbToHex(sampleRamp(stops, 0.6 + it.density * 0.4));
    defs.push(
      `    <linearGradient id="grad-${id}" gradientUnits="userSpaceOnUse" x1="${it.x1.toFixed(1)}" y1="${it.y1.toFixed(1)}" x2="${it.x2.toFixed(1)}" y2="${it.y2.toFixed(1)}">` +
      `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`);
    const sw = ((0.6 + it.density * 3.4) * weight).toFixed(2);
    const op = (0.35 + it.density * 0.55).toFixed(2);
    groups.push(
      `  <g id="strand-${id}">\n` +
      `    <path d="${it.d}" fill="none" stroke="url(#grad-${id})" stroke-width="${sw}" stroke-linecap="round" opacity="${op}"/>\n` +
      `  </g>`);
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <rect id="background" width="${width}" height="${height}" fill="${background}"/>`,
    '  <defs>',
    ...defs,
    '  </defs>',
    ...groups,
    '</svg>',
  ].join('\n');
}

// ── MP4 export ─────────────────────────────────────────────────────
// One seamless loop: frame i renders at phase i/frames, so frame `frames`
// would equal frame 0 — the file loops perfectly by construction.
export function framePlan(periodSeconds, fps = 30) {
  const frames = Math.max(2, Math.round(periodSeconds * fps));
  return { frames, fps, phase: (i) => (i % frames) / frames };
}

// Deterministic offline encode: caller renders each frame (offscreen, fixed
// phase), we push it through WebCodecs H.264 into an mp4-muxer container.
export async function exportMP4({ renderFrame, fps, frames, onProgress, shouldCancel }) {
  const { Muxer, ArrayBufferTarget } = window.Mp4Muxer;
  const first = renderFrame(0);
  const W = first.width & ~1, H = first.height & ~1; // H.264 needs even dims
  const stage = document.createElement('canvas');
  stage.width = W; stage.height = H;
  const ctx = stage.getContext('2d');

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H },
    fastStart: 'in-memory',
  });
  let encError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encError = e; },
  });
  let cfg = { codec: 'avc1.640028', width: W, height: H, bitrate: 12_000_000, framerate: fps };
  if (!(await VideoEncoder.isConfigSupported(cfg)).supported) cfg = { ...cfg, codec: 'avc1.42001f' };
  encoder.configure(cfg);

  for (let i = 0; i < frames; i++) {
    if (shouldCancel && shouldCancel()) { encoder.close(); return false; }
    if (encError) throw encError;
    ctx.drawImage(i === 0 ? first : renderFrame(i), 0, 0, W, H);
    const frame = new VideoFrame(stage, {
      timestamp: Math.round((i * 1e6) / fps),
      duration: Math.round(1e6 / fps),
    });
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    if (onProgress) onProgress((i + 1) / frames);
    while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 10));
  }
  await encoder.flush();
  muxer.finalize();
  const url = URL.createObjectURL(new Blob([muxer.target.buffer], { type: 'video/mp4' }));
  _dl(url, 'soundform.mp4');
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  return true;
}
