import { mulberry32, finalize } from './common.js';

// 3D standing-wave interference on a sphere, sampled with soft acceptance
// around nodal surfaces (exp falloff) → silky bands instead of hard dots.
// Each active note maps directly to a (m, n) wave-mode pair.
export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));

  const modes = fp.noteSet.map((pc, idx) => ({
    m: 1 + (pc % 6) + Math.round(params.complexity * 4),
    n: 2 + Math.floor(pc / 2) + idx + Math.round(fp.centroid * 3),
    amp: fp.chroma[pc],
    idx,
  }));
  const field = (theta, phi) => {
    let f = 0, domIdx = 0, domAmp = 0;
    for (const md of modes) {
      const v = (Math.sin(md.m * theta) * Math.cos(md.n * phi)
               + Math.sin(md.n * theta) * Math.cos(md.m * phi)) * md.amp;
      f += v;
      if (Math.abs(v) > domAmp) { domAmp = Math.abs(v); domIdx = md.idx; }
    }
    return { f, domIdx };
  };

  const sigma = 0.022 + fp.spread * 0.03; // band softness
  const positions = new Float32Array(N * 3);
  const attr = new Float32Array(N);
  let count = 0, guard = 0;
  while (count < N && guard < N * 40) {
    guard++;
    const theta = Math.acos(2 * rnd() - 1);
    const phi = rnd() * Math.PI * 2;
    const { f, domIdx } = field(theta, phi);
    if (rnd() > Math.exp(-((f / sigma) ** 2))) continue; // accept near nodes
    const R = 1 + (rnd() - 0.5) * 0.012 * (1 + fp.velocity * 2); // shell thickness ← velocity
    const st = Math.sin(theta);
    positions[count * 3] = st * Math.cos(phi) * R;
    positions[count * 3 + 1] = Math.cos(theta) * R;
    positions[count * 3 + 2] = st * Math.sin(phi) * R;
    attr[count] = (domIdx / Math.max(1, modes.length - 1)) * 0.7 + Math.min(0.3, Math.abs(f) * 3);
    count++;
    if (onProgress && count % 200000 === 0) onProgress(count / N);
  }

  // Strands: nodal contours via marching squares on a (theta, phi) grid
  const strands = marchNodalContours(field, Math.max(24, Math.min(96, params.strandCount || 96)));
  return finalize(positions.subarray(0, count * 3).slice(), attr.subarray(0, count).slice(), strands, params);
}

function marchNodalContours(field, want) {
  const T = 128, P = 256;
  const grid = new Float32Array(T * P);
  for (let i = 0; i < T; i++) for (let j = 0; j < P; j++) {
    grid[i * P + j] = field((i / (T - 1)) * Math.PI, (j / (P - 1)) * Math.PI * 2).f;
  }
  const segs = [];
  for (let i = 0; i < T - 1; i++) for (let j = 0; j < P - 1; j++) {
    const a = grid[i * P + j], b = grid[i * P + j + 1], c = grid[(i + 1) * P + j];
    const pts = [];
    if (a * b < 0) pts.push([i, j + Math.abs(a) / (Math.abs(a) + Math.abs(b))]);
    if (a * c < 0) pts.push([i + Math.abs(a) / (Math.abs(a) + Math.abs(c)), j]);
    if (pts.length === 2) segs.push(pts);
  }
  // Greedy chaining of segments into polylines
  const chains = [];
  const used = new Set();
  for (let s = 0; s < segs.length && chains.length < want * 2; s++) {
    if (used.has(s)) continue;
    used.add(s);
    const chain = [segs[s][0], segs[s][1]];
    let grew = true;
    while (grew && chain.length < 400) {
      grew = false;
      const tail = chain[chain.length - 1];
      for (let t = 0; t < segs.length; t++) {
        if (used.has(t)) continue;
        for (const end of [0, 1]) {
          const d = Math.hypot(segs[t][end][0] - tail[0], segs[t][end][1] - tail[1]);
          if (d < 2.5) { used.add(t); chain.push(segs[t][1 - end]); grew = true; break; }
        }
        if (grew) break;
      }
    }
    if (chain.length >= 4) chains.push(chain);
  }
  // Pad by emitting all chains >= 4 points, then sort by length if needed
  const out = [];
  for (const chain of chains) {
    const mapped = new Float32Array(chain.length * 3);
    chain.forEach(([gi, gj], idx) => {
      const theta = (gi / 127) * Math.PI, phi = (gj / 255) * Math.PI * 2;
      const st = Math.sin(theta);
      mapped[idx * 3] = st * Math.cos(phi);
      mapped[idx * 3 + 1] = Math.cos(theta);
      mapped[idx * 3 + 2] = st * Math.sin(phi);
    });
    out.push(mapped);
  }
  // If we have more than want, sort by length and slice
  if (out.length > want) {
    out.sort((x, y) => y.length - x.length);
    out.length = want;
  }
  return out;
}
