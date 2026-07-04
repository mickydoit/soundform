// Strand → editable SVG path machinery. DOM/THREE-free (works under node).

export function projectStrand(strand, m, w, h) {
  const pts = [];
  let depthSum = 0, count = 0;
  for (let i = 0; i < strand.length; i += 3) {
    const x = strand[i], y = strand[i + 1], z = strand[i + 2];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 1e-6) continue;
    const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
    const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
    const cz = (m[2] * x + m[6] * y + m[10] * z + m[14]) / cw;
    if (cz < -1 || cz > 1) continue;
    pts.push([(cx + 1) * 0.5 * w, (1 - cy) * 0.5 * h]);
    depthSum += cz; count++;
  }
  return { pts, depth: count ? depthSum / count : 1 };
}

// Ramer–Douglas–Peucker, iterative (stack), epsilon in pixels.
export function rdp(pts, epsilon) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = 0, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilon && maxI > 0) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// Catmull-Rom → cubic bezier SVG path.
export function toBezierPath(pts) {
  if (pts.length < 2) return '';
  const f = v => +v.toFixed(1);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

// Coarse 3D occupancy grid over [-1.3, 1.3]³, max-normalised.
export function buildDensityGrid(positions, res = 24) {
  const grid = new Float32Array(res * res * res);
  const idx = v => Math.max(0, Math.min(res - 1, Math.floor((v + 1.3) / 2.6 * res)));
  const step = Math.max(1, Math.floor(positions.length / 3 / 300000)); // sample big clouds
  let max = 1e-9;
  for (let i = 0; i < positions.length; i += 3 * step) {
    const g = (idx(positions[i]) * res + idx(positions[i + 1])) * res + idx(positions[i + 2]);
    grid[g]++;
    if (grid[g] > max) max = grid[g];
  }
  return {
    sample(x, y, z) {
      return grid[(idx(x) * res + idx(y)) * res + idx(z)] / max;
    },
  };
}
