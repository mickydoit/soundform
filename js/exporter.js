import { buildVectorPaths, toBezierPath, buildPdfOps, toRelativeBezierLegs } from './strands.js?v=56';
import { hexToRgb } from './palettes.js?v=56';
import { buildTraceSVG, buildTracePdfOps } from './trace.js?v=56';
import { fieldOutline, ringToPath, closedCatmullRom } from './blob.js?v=56';
import { makeWaterField } from './cymafield.js?v=56';

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

// Structured vector export. Legacy strands: one named group per strand, real
// bezier paths, density-driven weight/opacity, palette gradient along each
// path. Tone strands (cymatics fringe arcs): grouped by radial band
// (band-01 inner … band-08 outer), flat tone-class stroke colors — no
// gradient defs — with data-tone for tooling.
export function exportStrandSVG({ strands, positions, mvp, width, height, stops, background, weight }) {
  const items = buildVectorPaths({ strands, positions, mvp, width, height, stops, weight });

  const defs = [], groups = [];
  const bands = new Map();
  items.forEach((it, order) => {
    if (it.color) {
      const path =
        `    <path d="${toBezierPath(it.points)}" fill="none" stroke="${it.color}"` +
        ` stroke-width="${it.strokeWidth.toFixed(2)}" stroke-linecap="round"` +
        ` opacity="${it.opacity.toFixed(2)}" data-tone="${it.toneClass}"/>`;
      if (!bands.has(it.band)) bands.set(it.band, []);
      bands.get(it.band).push(path);
      return;
    }
    const id = String(order + 1).padStart(2, '0');
    defs.push(
      `    <linearGradient id="grad-${id}" gradientUnits="userSpaceOnUse" x1="${it.x1.toFixed(1)}" y1="${it.y1.toFixed(1)}" x2="${it.x2.toFixed(1)}" y2="${it.y2.toFixed(1)}">` +
      `<stop offset="0" stop-color="${it.c1}"/><stop offset="1" stop-color="${it.c2}"/></linearGradient>`);
    groups.push(
      `  <g id="strand-${id}">\n` +
      `    <path d="${toBezierPath(it.points)}" fill="none" stroke="url(#grad-${id})" stroke-width="${it.strokeWidth.toFixed(2)}" stroke-linecap="round" opacity="${it.opacity.toFixed(2)}"/>\n` +
      `  </g>`);
  });
  const bandGroups = [...bands.keys()].sort((a, b) => a - b).map((b) =>
    `  <g id="band-${String(b + 1).padStart(2, '0')}">\n${bands.get(b).join('\n')}\n  </g>`);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    ...(background != null ? [`  <rect id="background" width="${width}" height="${height}" fill="${background}"/>`] : []),
    ...(defs.length ? ['  <defs>', ...defs, '  </defs>'] : []),
    ...bandGroups,
    ...groups,
    '</svg>',
  ].join('\n');
}

// Native vector PDF: same path data as exportStrandSVG, drawn with jsPDF's
// core lines() API (accepts bezier-curve segments as relative deltas) —
// no raster image embed, stays crisp at any zoom.
export function exportStrandPDF({ strands, positions, mvp, width, height, stops, background, weight }) {
  const { jsPDF } = window.jspdf;
  const ops = buildPdfOps({ strands, positions, mvp, width, height, stops, weight, background });
  const mmW = width > height ? 297 : 210;
  const mmH = mmW * (height / width);
  const doc = new jsPDF({
    orientation: width > height ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [mmW, mmH],
  });
  const px2mm = mmW / width;

  if (ops.background != null) {
    const [r, g, b] = hexToRgb(ops.background).map((v) => Math.round(v * 255));
    doc.setFillColor(r, g, b);
    doc.rect(0, 0, mmW, mmH, 'F');
  }

  const hasAlpha = typeof doc.setGState === 'function' && typeof doc.GState === 'function';
  doc.setLineCap('round');
  ops.strokes.forEach(({ runs, strokeWidth, opacity }) => {
    doc.setLineWidth(strokeWidth * px2mm);
    if (hasAlpha) doc.setGState(new doc.GState({ opacity }));
    runs.forEach(({ start, legs, color }) => {
      const [r, g, b] = hexToRgb(color).map((v) => Math.round(v * 255));
      doc.setDrawColor(r, g, b);
      doc.lines(legs, start[0] * px2mm, start[1] * px2mm, [px2mm, px2mm], 'S', false);
    });
  });
  if (hasAlpha) doc.setGState(new doc.GState({ opacity: 1 }));

  doc.save('soundform.pdf');
}

// ── Liquid (metaball blob) vector export ────────────────────────────────
//
// Unlike every other export path in this file, this one is not tracing or
// approximating a raster. The blob's outline is analytic — an isocontour of
// the same field the shader draws — so these paths ARE the shape, contoured
// on the CPU at whatever resolution is asked for and fitted with periodic
// beziers. Small files, smooth curves, genuinely editable.
//
// Two flavours:
//   'flat'         — the filled silhouette (one path per ring)
//   'construction' — the outline plus the constituent circles, so the
//                    underlying geometry stays adjustable in Illustrator
export function buildBlobSVG({ state, width, height, ink, background, variant = 'flat' }) {
  const { rings, project } = fieldOutline(makeWaterField(state), { width, height });
  const paths = rings.map((r, i) =>
    `    <path id="pool-${String(i + 1).padStart(3, '0')}" d="${ringToPath(r)}"/>`);

  const body = variant === 'construction'
    // Outline-only: the cymatic skeleton as editable strokes. (The old
    // construction view drew the generating circles; a modal field has no
    // circles to draw, so what is useful now is the unfilled figure.)
    ? [`  <g id="outline" fill="none" stroke="${ink}" stroke-width="2">`, ...paths, '  </g>']
    // ONE path with every ring as a subpath: fill-rule is per-path, so
    // separate <path> elements would fill the enclosed voids solid.
    : [`  <path id="water" fill="${ink}" fill-rule="evenodd" d="${rings.map((r) => ringToPath(r)).join(' ')}"/>`];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    ...(background != null ? [`  <rect id="background" width="${width}" height="${height}" fill="${background}"/>`] : []),
    ...body,
    '</svg>',
  ].join('\n');
}

export function exportBlobPDF({ state, width, height, ink, background, variant = 'flat' }) {
  const { jsPDF } = window.jspdf;
  const { rings } = fieldOutline(makeWaterField(state), { width, height });
  const mmW = width > height ? 297 : 210;
  const mmH = mmW * (height / width);
  const doc = new jsPDF({
    orientation: width > height ? 'landscape' : 'portrait',
    unit: 'mm', format: [mmW, mmH],
  });
  const px2mm = mmW / width;

  if (background != null) {
    const [r, g, b] = hexToRgb(background).map((v) => Math.round(v * 255));
    doc.setFillColor(r, g, b);
    doc.rect(0, 0, mmW, mmH, 'F');
  }
  const [ir, ig, ib] = hexToRgb(ink).map((v) => Math.round(v * 255));
  doc.setFillColor(ir, ig, ib);
  doc.setDrawColor(ir, ig, ib);

  if (variant !== 'construction') {
    // Raw operators rather than lines(): each lines() call paints its own
    // path, which fills the enclosed voids solid. One path across every ring
    // closed with an EVEN-ODD fill (f*) is what punches them through.
    const ci = (x) => doc.internal.getCoordinateString(x);
    const cv = (y) => doc.internal.getVerticalCoordinateString(y);
    for (const ring of rings) {
      if (ring.length < 3) continue;
      const pts = ring.map(([x, y]) => [x * px2mm, y * px2mm]);
      doc.internal.write(`${ci(pts[0][0])} ${cv(pts[0][1])} m`);
      for (const { c1, c2, end } of closedCatmullRom(pts)) {
        doc.internal.write(
          `${ci(c1[0])} ${cv(c1[1])} ${ci(c2[0])} ${cv(c2[1])} ${ci(end[0])} ${cv(end[1])} c`);
      }
      doc.internal.write('h');
    }
    doc.internal.write('f*');
  } else {
    doc.setLineWidth(2 * px2mm);
    for (const ring of rings) {
      if (ring.length < 3) continue;
      // jsPDF's lines() reads all three pairs of a curve entry as offsets
      // from the point BEFORE the curve, not chained from one to the next.
      const legs = toRelativeBezierLegs(ring[0], closedCatmullRom(ring));
      doc.lines(legs, ring[0][0] * px2mm, ring[0][1] * px2mm, [px2mm, px2mm], 'S', true);
    }
  }
  doc.save(`soundform-${variant}.pdf`);
}

// Trace export: grouped filled tone-band SVG (one <g id="tone-NN"> per level).
export function exportTraceSVG(tracedata, { background }) {
  return buildTraceSVG(tracedata, { background });
}

// Trace export as native vector PDF: each tone layer drawn as filled paths.
// Page sizing mirrors exportStrandPDF (A4-ish, orientation by aspect).
export function exportTracePDF(tracedata, { background }) {
  const { jsPDF } = window.jspdf;
  const ops = buildTracePdfOps(tracedata, { background });
  const { width, height } = ops;
  const mmW = width > height ? 297 : 210;
  const mmH = mmW * (height / width);
  const doc = new jsPDF({
    orientation: width > height ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [mmW, mmH],
  });
  const px2mm = mmW / width;

  if (ops.background != null) {
    const [r, g, b] = hexToRgb(ops.background).map((v) => Math.round(v * 255));
    doc.setFillColor(r, g, b);
    doc.rect(0, 0, mmW, mmH, 'F');
  }

  ops.layers.forEach(({ color, paths }) => {
    doc.setFillColor(color.r, color.g, color.b);
    paths.forEach(({ start, legs }) => {
      // 'F' fills, closed=true closes the subpath; scale px→mm.
      doc.lines(legs, start[0] * px2mm, start[1] * px2mm, [px2mm, px2mm], 'F', true);
    });
  });

  doc.save('soundform-trace.pdf');
}

// ── MP4 export ─────────────────────────────────────────────────────
// One seamless loop: frame i renders at phase i/frames, so frame `frames`
// would equal frame 0 — the file loops perfectly by construction.
// Whole seamless loops that best match a requested duration (0 → one loop).
export function loopsForDuration(targetSec, periodSec) {
  if (!targetSec) return 1;
  return Math.max(1, Math.round(targetSec / Math.max(0.5, periodSec)));
}

export function framePlan(periodSeconds, fps = 30) {
  const frames = Math.max(2, Math.round(periodSeconds * fps));
  return { frames, fps, phase: (i) => (i % frames) / frames };
}

// Deterministic offline encode: caller renders each frame (offscreen, fixed
// phase), we push it through WebCodecs H.264 into an mp4-muxer container.
export async function exportMP4({ renderFrame, fps, frames, onProgress, shouldCancel, bitrate }) {
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
  let cfg = { codec: 'avc1.640028', width: W, height: H, bitrate: bitrate || 12_000_000, framerate: fps };
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
