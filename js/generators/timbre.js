import { mulberry32, finalize, resamplePolyline } from './common.js';

// The recording's journey through (centroid, rms, spread) space as a ribbon
// bundle: tube radius & density grow where the sound dwelt (slow trajectory).
export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));
  const traj = fp.trajectory && fp.trajectory.length >= 12
    ? fp.trajectory
    : new Float32Array([...Array(60)].flatMap((_, i) => [0.3 + 0.2 * Math.sin(i / 6), 0.25 + 0.1 * Math.sin(i / 4), 0.3]));

  const M = 512;
  const center = resamplePolyline(smooth(traj, 5), M);
  // expand around mean to fill space
  for (let i = 0; i < center.length; i += 3) {
    center[i] = (center[i] - 0.4) * 3.2;
    center[i + 1] = (center[i + 1] - 0.25) * 3.2;
    center[i + 2] = (center[i + 2] - 0.3) * 3.2;
  }

  // dwell = inverse local speed
  const dwell = new Float32Array(M);
  let dMax = 1e-6;
  for (let i = 1; i < M; i++) {
    const sp = Math.hypot(center[i * 3] - center[(i - 1) * 3], center[i * 3 + 1] - center[(i - 1) * 3 + 1], center[i * 3 + 2] - center[(i - 1) * 3 + 2]);
    dwell[i] = 1 / (sp + 0.002);
    dMax = Math.max(dMax, dwell[i]);
  }
  dwell[0] = dwell[1];
  for (let i = 0; i < M; i++) dwell[i] /= dMax;

  const positions = new Float32Array(N * 3);
  const attr = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = Math.floor(rnd() * (M - 1));
    const rad = (0.02 + dwell[t] * 0.14) * (0.6 + params.complexity);
    positions[i * 3] = center[t * 3] + (rnd() - 0.5) * rad * 2;
    positions[i * 3 + 1] = center[t * 3 + 1] + (rnd() - 0.5) * rad * 2;
    positions[i * 3 + 2] = center[t * 3 + 2] + (rnd() - 0.5) * rad * 2;
    attr[i] = t / (M - 1); // palette follows time
    if (onProgress && i % 300000 === 0) onProgress(i / N);
  }

  // Strands: the centreline plus offset tube lines
  const want = Math.max(24, Math.min(96, params.strandCount || 96));
  const strands = [resamplePolyline(center, 300)];
  for (let s = 1; s < want; s++) {
    const phase = rnd() * Math.PI * 2, freq = 1 + Math.floor(rnd() * 3);
    const copy = new Float32Array(300 * 3);
    const rs = resamplePolyline(center, 300);
    for (let i = 0; i < 300; i++) {
      const dw = dwell[Math.floor((i / 299) * (M - 1))];
      const rad = (0.02 + dw * 0.14) * (0.6 + params.complexity);
      copy[i * 3] = rs[i * 3] + Math.cos(phase + i * 0.05 * freq) * rad;
      copy[i * 3 + 1] = rs[i * 3 + 1] + Math.sin(phase + i * 0.05 * freq) * rad;
      copy[i * 3 + 2] = rs[i * 3 + 2] + Math.cos(phase * 1.7 + i * 0.04 * freq) * rad;
    }
    strands.push(copy);
  }
  return finalize(positions, attr, strands, params);
}

function smooth(arr, win) {
  const n = arr.length / 3;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < 3; d++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) { s += arr[j * 3 + d]; c++; }
      out[i * 3 + d] = s / c;
    }
  }
  return out;
}
