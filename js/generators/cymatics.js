import { mulberry32, finalize, resamplePolyline } from './common.js';

// Water-mandala cymatics: standing waves on a circular membrane.
// Each detected note = one (m petals, ring wavenumber) mode; modes superpose
// into an interference field. Points survive where |amplitude| is high, so
// crests glow under the log-density tonemap. Radial profile is a damped
// cosine — a visually faithful stand-in for Bessel J_m modes.
export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));

  const kBase = 6 + fp.pitchMedian * 10 + params.complexity * 8;
  const detune = (1 - fp.consonance) * 0.9;
  // Atonal/spoken input (low consonance) loosens the modes: wavenumber and
  // amplitude gain seeded variance, so speech reads wilder than sung tones.
  const wild = 0.5 + (1 - (fp.consonance ?? 0.5));
  const modes = fp.noteSet.map((pc, idx) => ({
    m: 2 + (pc % 7) + Math.round(params.complexity * 3),
    kr: kBase * (0.55 + 0.45 * ((idx + 1) / fp.noteCount)) * (1 + (rnd() - 0.5) * 0.15 * wild),
    amp: Math.max(0.15, fp.chroma[pc]) * (1 + (rnd() - 0.5) * 0.4 * wild),
    phase: detune * rnd() * Math.PI * 2,
  }));
  // CymaScope intricacy: each note mode's second harmonic (finer petals,
  // half strength; reuses the base phase — no extra rnd calls), plus a
  // bullseye core of pure radial rings (m = 0).
  for (const md of [...modes]) {
    modes.push({ m: md.m, kr: md.kr * 2, amp: md.amp * 0.5, phase: md.phase });
  }
  modes.push({ m: 0, kr: kBase * 1.8, amp: 0.45, phase: 0 });

  // Prosody envelope: the utterance's pitch contour shapes the membrane from
  // centre to rim, so spoken phrases with different intonation read differently.
  const contour = fp.contour && fp.contour.length >= 8 ? fp.contour : null;
  const prosody = (r) => {
    if (!contour) return 1;
    const x = Math.min(6.999, Math.max(0, r * 7));
    const i = Math.floor(x), f2 = x - i;
    return 0.7 + (contour[i] + (contour[i + 1] - contour[i]) * f2) * 0.6;
  };

  const field = (r, th) => {
    let f = 0;
    for (const md of modes) {
      f += md.amp * (Math.cos(md.kr * r - md.m * 0.5) / Math.sqrt(1 + md.kr * r * 0.5))
                  * Math.cos(md.m * th + md.phase);
    }
    return f * prosody(r);
  };

  let fMax = 1e-6;
  for (let i = 0; i < 4000; i++) {
    const a = Math.abs(field(Math.sqrt(rnd()), rnd() * Math.PI * 2));
    if (a > fMax) fMax = a;
  }

  const relief = 0.22 + fp.volMean * 0.25;
  const spray = fp.velocity * 0.015;
  const positions = new Float32Array(N * 3);
  const attr = new Float32Array(N);
  // Hairline interference striations: a fine radial carrier gates survival,
  // so crests break into CymaScope-style fringes. Harder falloff + lower
  // floor give the bold black voids of the reference photographs.
  const kFine = 40 + fp.pitchMedian * 30;
  let count = 0, guard = 0;
  while (count < N && guard < N * 60) {
    guard++;
    const r = Math.sqrt(rnd());
    const th = rnd() * Math.PI * 2;
    const f = field(r, th) / fMax;
    const fine = 0.55 + 0.45 * Math.pow(Math.cos(kFine * r), 2);
    const af = Math.min(1, Math.abs(f)) * fine;
    if (rnd() > Math.max(Math.pow(af, 2.2), 0.03)) continue;
    positions[count * 3] = Math.cos(th) * r;
    positions[count * 3 + 1] = f * relief + (rnd() + rnd() - 1) * spray * af;
    positions[count * 3 + 2] = Math.sin(th) * r;
    attr[count] = af;
    count++;
    if (onProgress && count % 250000 === 0) onProgress(count / N);
  }

  // Strands: crest rings (petal-modulated circles) + radial spokes.
  const want = Math.max(24, Math.min(96, params.strandCount || 96));
  const rings = Math.min(want, 12 + Math.round(params.complexity * 8));
  const strands = [];
  for (let ri = 0; ri < rings; ri++) {
    const r0 = (ri + 0.5) / rings;
    const pts = new Float32Array(220 * 3);
    for (let i = 0; i < 220; i++) {
      const th = (i / 219) * Math.PI * 2;
      const f = field(r0, th) / fMax;
      pts[i * 3] = Math.cos(th) * r0;
      pts[i * 3 + 1] = f * relief;
      pts[i * 3 + 2] = Math.sin(th) * r0;
    }
    strands.push(resamplePolyline(pts, 200));
  }
  for (let si = 0; strands.length < want; si++) {
    const th0 = (si / Math.max(1, want - rings)) * Math.PI * 2;
    const pts = new Float32Array(160 * 3);
    for (let i = 0; i < 160; i++) {
      const r = i / 159;
      const f = field(r, th0) / fMax;
      pts[i * 3] = Math.cos(th0) * r;
      pts[i * 3 + 1] = f * relief;
      pts[i * 3 + 2] = Math.sin(th0) * r;
    }
    strands.push(resamplePolyline(pts, 140));
  }
  return finalize(positions.subarray(0, count * 3).slice(), attr.subarray(0, count).slice(), strands, params);
}
