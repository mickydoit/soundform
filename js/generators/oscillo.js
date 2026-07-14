import { mulberry32, finalize, resamplePolyline } from './common.js';

// Waveform mandala: the recording's timeline as concentric rings on a shallow
// watch-glass dome — time spirals outward, each ring one moment. Wave cycles
// come from that moment's pitch, amplitude from loudness, fray from spectral
// spread. The sound is legible centre → rim like tree rings.

// Linear-interpolated read of the trajectory at normalized time t.
// Returns [centroid, rms, spread, pitch]; 3-channel legacy shapes get pitch 0.
function frameAt(traj, ch, t) {
  const n = Math.floor(traj.length / ch);
  if (n === 0) return [0.4, 0, 0.15, 0];
  const x = Math.min(n - 1, Math.max(0, t * (n - 1)));
  const i = Math.floor(x), f = x - i, j = Math.min(n - 1, i + 1);
  const read = (idx, c) => (c < ch ? traj[idx * ch + c] : 0);
  const out = [];
  for (let c = 0; c < 4; c++) out.push(read(i, c) + (read(j, c) - read(i, c)) * f);
  return out;
}

export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const N = Math.max(1000, Math.floor(params.density));
  const traj = fp.trajectory && fp.trajectory.length >= 3 ? fp.trajectory : null;
  const ch = fp.trajectoryChannels === 4 ? 4 : 3;

  const rings = 90 + Math.round((params.complexity || 0.5) * 90); // 90..180
  const perRing = Math.max(30, Math.floor(N / rings));
  const total = perRing * rings;
  const positions = new Float32Array(total * 3);
  const attr = new Float32Array(total);
  const strands = [];
  const domeH = 0.35;
  const jit = 0.0035;
  let w = 0;

  for (let i = 0; i < rings; i++) {
    const t = rings === 1 ? 0 : i / (rings - 1);
    const [centroid, rms, spread, pitch] = traj ? frameAt(traj, ch, t) : [0.4, 0, 0.15, 0];
    const baseR = 0.15 + t * 0.85;
    const drive = pitch > 0 ? pitch : centroid;
    const k = Math.max(2, Math.round(4 + drive * 44)); // wave cycles per ring
    const amp = rms * 0.35 * baseR;
    const phase = rnd() * Math.PI * 2;
    const y0 = domeH * (1 - t * t) + rms * 0.15; // dome + loudness bas-relief
    const fray = spread * 0.02;

    const ringR = (ang) => baseR + amp * Math.sin(k * ang + phase);

    for (let p = 0; p < perRing; p++) {
      const ang = rnd() * Math.PI * 2;
      const r = ringR(ang) + (rnd() - 0.5) * fray;
      positions[w * 3]     = r * Math.cos(ang) + (rnd() - 0.5) * jit;
      positions[w * 3 + 1] = y0 + (rnd() - 0.5) * (jit + fray * 0.5);
      positions[w * 3 + 2] = r * Math.sin(ang) + (rnd() - 0.5) * jit;
      attr[w] = Math.max(0, Math.min(1, 0.25 + rms * 2.2));
      w++;
    }
    const raw = new Float32Array(256 * 3);
    for (let s = 0; s < 256; s++) {
      const ang = (s / 255) * Math.PI * 2;
      const r = ringR(ang);
      raw[s * 3] = r * Math.cos(ang); raw[s * 3 + 1] = y0; raw[s * 3 + 2] = r * Math.sin(ang);
    }
    strands.push(resamplePolyline(raw, 200));
    if (onProgress && i % 16 === 0) onProgress(i / rings);
  }
  return finalize(positions, attr, strands, params);
}
