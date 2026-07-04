import { mulberry32, finalize, resamplePolyline } from './common.js';

// Orbital ribbon shells. Each shell is a tilted, harmonically deformed orbit;
// points scatter in a gaussian tube around it so overlaps build luminous cores.
// Consonant sound → golden-angle even interleaving; dissonant → seed-clustered tilts.
export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));
  const shells = Math.max(6, Math.round(6 + fp.noteCount * 2 + fp.volMean * 10 + params.complexity * 12));
  const golden = Math.PI * (3 - Math.sqrt(5));
  const perShell = Math.floor(N / shells);

  const positions = new Float32Array(perShell * shells * 3);
  const attr = new Float32Array(perShell * shells);
  const strands = [];
  let w = 0;

  for (let s = 0; s < shells; s++) {
    const tS = s / Math.max(1, shells - 1);
    const lobes = 2 + (fp.noteSet[s % fp.noteCount] % 5) + Math.round(params.complexity * 3);
    const baseR = 0.35 + tS * 0.75;
    const wobble = 0.08 + fp.pitchRange * 0.3;
    const tiltA = fp.consonance > 0.5 ? s * golden : rnd() * Math.PI * 2;
    const tiltB = fp.consonance > 0.5 ? tS * Math.PI * 0.8 : rnd() * Math.PI;
    const ca = Math.cos(tiltA), sa = Math.sin(tiltA), cb = Math.cos(tiltB), sb = Math.sin(tiltB);
    const tube = 0.007 + fp.velocity * 0.014 + tS * 0.005;
    const phase = fp.contour[s % 8] * Math.PI * 2;

    const orbit = (t) => {
      const th = t * Math.PI * 2;
      const r = baseR * (1 + wobble * Math.sin(lobes * th + phase));
      const x0 = Math.cos(th) * r, y0 = Math.sin(lobes * th * 0.5 + phase) * wobble * 1.6, z0 = Math.sin(th) * r;
      // rotate around Y by tiltA then around X by tiltB
      const x1 = x0 * ca + z0 * sa, z1 = -x0 * sa + z0 * ca;
      return [x1, y0 * cb - z1 * sb, y0 * sb + z1 * cb];
    };

    for (let i = 0; i < perShell; i++) {
      const [x, y, z] = orbit(rnd());
      // Random direction + product-of-two-uniforms magnitude: bounded, and its
      // density spikes near r=0 with a soft taper to the cap — a real bright
      // core instead of the old flat cube scatter, without a heavy unbounded tail.
      const u = rnd() * 2 - 1, phi2 = rnd() * Math.PI * 2;
      const s2 = Math.sqrt(Math.max(0, 1 - u * u));
      const m = rnd() * rnd() * 3 * tube;
      positions[w * 3] = x + s2 * Math.cos(phi2) * m;
      positions[w * 3 + 1] = y + s2 * Math.sin(phi2) * m;
      positions[w * 3 + 2] = z + u * m;
      attr[w] = tS;
      w++;
    }
    if (onProgress && s % 8 === 0) onProgress(s / shells);

    const raw = new Float32Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const [x, y, z] = orbit(i / 255);
      raw[i * 3] = x; raw[i * 3 + 1] = y; raw[i * 3 + 2] = z;
    }
    strands.push(resamplePolyline(raw, 200));
  }
  // Duplicate shells' centrelines with slight offsets until strand budget met
  while (strands.length < Math.min(96, params.strandCount || 96)) {
    const src = strands[strands.length % shells];
    const copy = src.slice();
    for (let i = 0; i < copy.length; i++) copy[i] += (rnd() - 0.5) * 0.02;
    strands.push(copy);
  }
  return finalize(positions, attr, strands, params);
}
