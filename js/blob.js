// Metaball geometry for the Liquid mode.
//
// The form is an isocontour of a smooth-union signed distance field over a
// handful of circles. Nothing here touches the DOM, THREE or a canvas, so it
// is fully node-testable — and, more importantly, the SAME field definition
// is mirrored in the renderer's GLSL. That is what lets the vector export
// trace the TRUE shape instead of tracing a rasterisation of it, which is how
// the existing point-cloud modes have to do it.
//
// If the GLSL in density.js and `smin`/`fieldAt` here ever drift apart, the
// exported outline stops matching what is on screen. Keep them in lockstep.

// Polynomial smooth minimum (Inigo Quilez). Blending circle SDFs with this,
// rather than taking a hard min, is what produces the tapered necks between
// lobes — the join in the reference construction diagram. k is the blend
// radius in world units: 0 gives hard circle unions, larger values pull
// neighbouring lobes into one another.
export function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

// Signed field: negative inside the blob, zero on the outline.
export function fieldAt(circles, k, x, y) {
  if (!circles.length) return 1;
  let d = Math.hypot(x - circles[0].x, y - circles[0].y) - circles[0].r;
  for (let i = 1; i < circles.length; i++) {
    const c = circles[i];
    d = smin(d, Math.hypot(x - c.x, y - c.y) - c.r, k);
  }
  return d;
}

export function makeBlobField(circles, k = 0.18) {
  return (x, y) => fieldAt(circles, k, x, y);
}

// Axis-aligned bounds that comfortably contain the blob. The smooth union
// pushes the surface OUTWARD past the raw circles (by up to k), so the pad
// has to account for the blend radius or the contour gets clipped at the
// frame edge and stitches into an open path.
export function blobBounds(circles, k = 0.18, pad = 0.08) {
  if (!circles.length) return { x0: -1, y0: -1, x1: 1, y1: 1 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of circles) {
    x0 = Math.min(x0, c.x - c.r); y0 = Math.min(y0, c.y - c.r);
    x1 = Math.max(x1, c.x + c.r); y1 = Math.max(y1, c.y + c.r);
  }
  const m = k + pad;
  return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
}

// Marching squares at iso = 0, returning closed loops of [x, y] points.
export function marchingSquares(field, bounds, res = 320, iso = 0) {
  const { x0, y0, x1, y1 } = bounds;
  const dx = (x1 - x0) / res, dy = (y1 - y0) / res;
  const n = res + 1;
  const v = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) v[j * n + i] = field(x0 + i * dx, y0 + j * dy) - iso;
  }

  const px = (i) => x0 + i * dx, py = (j) => y0 + j * dy;
  // Zero crossing along an edge. Guarded: two equal values would divide by
  // zero and emit NaN vertices, which stitch into garbage loops.
  const cross = (va, vb, a, b) => (va === vb ? a : a + (b - a) * (va / (va - vb)));

  const segs = [];
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const va = v[j * n + i], vb = v[j * n + i + 1];
      const vc = v[(j + 1) * n + i + 1], vd = v[(j + 1) * n + i];
      let code = 0;
      if (va < 0) code |= 1;
      if (vb < 0) code |= 2;
      if (vc < 0) code |= 4;
      if (vd < 0) code |= 8;
      if (code === 0 || code === 15) continue;

      const eB = () => [cross(va, vb, px(i), px(i + 1)), py(j)];
      const eR = () => [px(i + 1), cross(vb, vc, py(j), py(j + 1))];
      const eT = () => [cross(vd, vc, px(i), px(i + 1)), py(j + 1)];
      const eL = () => [px(i), cross(va, vd, py(j), py(j + 1))];

      switch (code) {
        case 1: case 14: segs.push([eL(), eB()]); break;
        case 2: case 13: segs.push([eB(), eR()]); break;
        case 3: case 12: segs.push([eL(), eR()]); break;
        case 4: case 11: segs.push([eR(), eT()]); break;
        case 6: case 9:  segs.push([eB(), eT()]); break;
        case 7: case 8:  segs.push([eT(), eL()]); break;
        // Saddles: two crossings in one cell, and which pair joins is
        // genuinely ambiguous from the corners alone. Resolve with the cell
        // average — the standard heuristic, and correct for smooth fields.
        case 5:
          if ((va + vb + vc + vd) < 0) segs.push([eL(), eT()], [eB(), eR()]);
          else segs.push([eL(), eB()], [eT(), eR()]);
          break;
        case 10:
          if ((va + vb + vc + vd) < 0) segs.push([eL(), eB()], [eT(), eR()]);
          else segs.push([eL(), eT()], [eB(), eR()]);
          break;
      }
    }
  }
  return stitchLoops(segs, Math.min(dx, dy) * 1e-3);
}

// Join unordered segments end-to-end into closed rings.
function stitchLoops(segs, eps) {
  const K = (p) => `${Math.round(p[0] / eps)}|${Math.round(p[1] / eps)}`;
  const at = new Map();
  segs.forEach((s, idx) => {
    for (const p of s) {
      const k = K(p);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(idx);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const loop = [segs[s0][0], segs[s0][1]];
    let end = segs[s0][1];
    const startK = K(segs[s0][0]);
    for (;;) {
      const cands = at.get(K(end));
      if (!cands) break;
      const next = cands.find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = 1;
      const s = segs[next];
      const other = K(s[0]) === K(end) ? s[1] : s[0];
      loop.push(other);
      end = other;
      if (K(end) === startK) break;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

// Ramer-Douglas-Peucker for a CLOSED ring. The open-chain form collapses a
// ring outright: its first and last points coincide, so the chord it measures
// against has ~zero length and every point looks collinear. Splitting the
// ring at its farthest point and simplifying two open halves avoids that —
// the same fix strands.js carries for closed strand loops.
export function simplifyRing(pts, epsilon) {
  if (pts.length < 4) return pts;
  const a = pts[0];
  let far = 1, best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]);
    if (d > best) { best = d; far = i; }
  }
  const h1 = rdpOpen(pts.slice(0, far + 1), epsilon);
  const h2 = rdpOpen(pts.slice(far), epsilon);
  return h1.slice(0, -1).concat(h2.slice(0, -1));
}

function rdpOpen(pts, epsilon) {
  if (pts.length < 3) return pts;
  const [x0, y0] = pts[0], [x1, y1] = pts[pts.length - 1];
  const ex = x1 - x0, ey = y1 - y0;
  const len = Math.hypot(ex, ey);
  let idx = -1, max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const px = pts[i][0] - x0, py = pts[i][1] - y0;
    const d = len < 1e-12 ? Math.hypot(px, py) : Math.abs(px * ey - py * ex) / len;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= epsilon || idx < 0) return [pts[0], pts[pts.length - 1]];
  return rdpOpen(pts.slice(0, idx + 1), epsilon).slice(0, -1).concat(rdpOpen(pts.slice(idx), epsilon));
}

// Periodic Catmull-Rom. The open form in strands.js clamps its end tangents,
// which leaves a visible corner exactly where a ring closes.
export function closedCatmullRom(pts) {
  const n = pts.length;
  const at = (i) => pts[((i % n) + n) % n];
  const segs = [];
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    segs.push({
      c1: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      c2: [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      end: p2,
    });
  }
  return segs;
}

export function ringToPath(pts, decimals = 2) {
  if (pts.length < 3) return '';
  const f = (v) => +v.toFixed(decimals);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (const { c1, c2, end } of closedCatmullRom(pts)) {
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(end[0])} ${f(end[1])}`;
  }
  return d + 'Z';
}

// World (blob space) -> pixel space, preserving aspect and centring.
export function makeProjector(bounds, width, height, margin = 0.06) {
  const bw = bounds.x1 - bounds.x0, bh = bounds.y1 - bounds.y0;
  const s = Math.min(width * (1 - 2 * margin) / bw, height * (1 - 2 * margin) / bh);
  const ox = width / 2 - ((bounds.x0 + bounds.x1) / 2) * s;
  // Y is flipped: world Y points up, screen Y points down.
  const oy = height / 2 + ((bounds.y0 + bounds.y1) / 2) * s;
  return { scale: s, project: (x, y) => [x * s + ox, -y * s + oy] };
}

// Full outline of a blob in pixel space, ready for SVG/PDF.
export function blobOutline(circles, { smooth = 0.18, width = 1600, height = 1200,
                                        res = 320, simplify = 0.6 } = {}) {
  const bounds = blobBounds(circles, smooth);
  const { project, scale } = makeProjector(bounds, width, height);
  const loops = marchingSquares(makeBlobField(circles, smooth), bounds, res);
  return {
    bounds, scale, project,
    rings: loops.map((loop) => simplifyRing(loop.map(([x, y]) => project(x, y)), simplify)),
  };
}

// Outline of ANY scalar field (negative inside), in pixel space. The
// contouring above never cared what produced the field — that is what let
// Liquid swap its circle SDF for a cymatic thickness field without touching
// the export pipeline. Resolution is higher here than for blobs because a
// nodal figure has far finer structure than a handful of fused circles.
export function fieldOutline(field, { bounds = { x0: -1.35, y0: -1.35, x1: 1.35, y1: 1.35 },
                                      width = 1600, height = 1200,
                                      res = 520, simplify = 0.8 } = {}) {
  const { project, scale } = makeProjector(bounds, width, height, 0.02);
  const loops = marchingSquares(field, bounds, res);
  return {
    bounds, scale, project,
    rings: loops
      .map((loop) => simplifyRing(loop.map(([x, y]) => project(x, y)), simplify))
      // A cymatic field throws off tiny specks at the resolution limit; they
      // add hundreds of paths to the SVG and are invisible at any print size.
      .filter((r) => r.length >= 6),
  };
}
