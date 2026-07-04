import { mulberry32, finalize, resamplePolyline } from './common.js';

// Harmonic helix: each active note spirals a glowing filament at its
// pitch-class angle; chords braid into columns. Filament brightness ← chroma.
export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));
  const turns = 1.5 + params.complexity * 2.5 + fp.pitchRange * 1.5;
  const H = 2.2;
  const filaments = [];
  for (const pc of fp.noteSet) {
    // 3 octave copies of each note for depth
    for (let oct = 0; oct < 3; oct++) filaments.push({ pc, oct, amp: fp.chroma[pc] * (1 - oct * 0.25) });
  }
  const perFil = Math.floor(N / filaments.length);
  const positions = new Float32Array(perFil * filaments.length * 3);
  const attr = new Float32Array(perFil * filaments.length);
  const strands = [];
  let w = 0;

  filaments.forEach((fil, fi) => {
    const angle0 = (fil.pc / 12) * Math.PI * 2;
    const braid = fp.consonance * 0.25; // consonant chords braid toward each other
    const jitter = 0.02 + fp.velocity * 0.06;
    const path = (t) => {
      const y = (t - 0.5) * H + fil.oct * 0.12;
      const ang = angle0 + t * Math.PI * 2 * turns;
      const r = 0.55 + 0.18 * Math.sin(t * Math.PI * (2 + fil.oct)) - braid * Math.sin(t * Math.PI);
      return [Math.cos(ang) * r, y, Math.sin(ang) * r];
    };
    for (let i = 0; i < perFil; i++) {
      const t = rnd();
      const [x, y, z] = path(t);
      positions[w * 3] = x + (rnd() - 0.5) * jitter;
      positions[w * 3 + 1] = y + (rnd() - 0.5) * jitter;
      positions[w * 3 + 2] = z + (rnd() - 0.5) * jitter;
      attr[w] = Math.min(1, fil.amp);
      w++;
    }
    const raw = new Float32Array(300 * 3);
    for (let i = 0; i < 300; i++) {
      const [x, y, z] = path(i / 299);
      raw[i * 3] = x; raw[i * 3 + 1] = y; raw[i * 3 + 2] = z;
    }
    strands.push(resamplePolyline(raw, 260));
    if (onProgress) onProgress(fi / filaments.length);
  });

  while (strands.length < Math.min(96, params.strandCount || 96)) {
    const src = strands[strands.length % filaments.length].slice();
    for (let i = 0; i < src.length; i++) src[i] += (rnd() - 0.5) * 0.03;
    strands.push(src);
  }
  return finalize(positions, attr, strands, params);
}
