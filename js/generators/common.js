// Deterministic utilities shared by all generators. DOM/THREE-free.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Robust normalization: centre on mean, scale so the 95th-percentile radius = 1.
export function computeNormalization(pos) {
  const n = pos.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;
  const radii = [];
  const step = Math.max(1, Math.floor(n / 4096));
  for (let i = 0; i < n; i += step) {
    const x = pos[i * 3] - cx, y = pos[i * 3 + 1] - cy, z = pos[i * 3 + 2] - cz;
    radii.push(Math.sqrt(x * x + y * y + z * z));
  }
  radii.sort((a, b) => a - b);
  const r95 = radii[Math.floor(radii.length * 0.95)] || 1;
  return { cx, cy, cz, scale: r95 > 1e-6 ? 1 / r95 : 1 };
}

export function applyNormalization(arr, t) {
  for (let i = 0; i < arr.length; i += 3) {
    arr[i] = (arr[i] - t.cx) * t.scale;
    arr[i + 1] = (arr[i + 1] - t.cy) * t.scale;
    arr[i + 2] = (arr[i + 2] - t.cz) * t.scale;
  }
}

// Twist: rotate around Y by amount·y radians (shear along height).
export function applyTwistArr(arr, amount) {
  if (!amount) return;
  for (let i = 0; i < arr.length; i += 3) {
    const a = amount * arr[i + 1];
    const c = Math.cos(a), s = Math.sin(a);
    const x = arr[i], z = arr[i + 2];
    arr[i] = x * c + z * s;
    arr[i + 2] = -x * s + z * c;
  }
}

// k-fold rotational replication around Y. Returns a new array k× as long.
export function replicateSymmetry(arr, k) {
  if (k <= 1) return arr;
  const n = arr.length / 3;
  const out = new Float32Array(arr.length * k);
  for (let j = 0; j < k; j++) {
    const ang = (j / k) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
    for (let i = 0; i < n; i++) {
      const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
      const o = (j * n + i) * 3;
      out[o] = x * c + z * s;
      out[o + 1] = y;
      out[o + 2] = -x * s + z * c;
    }
  }
  return out;
}

// Standard post-pass every generator calls last:
// normalize (using the CLOUD's transform for strands too, so they stay aligned),
// then symmetry replication, then twist.
export function finalize(positions, attr, strands, params) {
  const t = computeNormalization(positions);
  applyNormalization(positions, t);
  for (const s of strands) applyNormalization(s, t);

  const k = Math.max(1, Math.round(params.symmetry || 1));
  let outPos = positions, outAttr = attr, outStrands = strands;
  if (k > 1) {
    outPos = replicateSymmetry(positions, k);
    outAttr = new Float32Array(attr.length * k);
    for (let j = 0; j < k; j++) outAttr.set(attr, j * attr.length);
    outStrands = [];
    for (let j = 0; j < k; j++) {
      const ang = (j / k) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
      for (const st of strands) {
        const copy = new Float32Array(st.length);
        for (let i = 0; i < st.length; i += 3) {
          copy[i] = st[i] * c + st[i + 2] * s;
          copy[i + 1] = st[i + 1];
          copy[i + 2] = -st[i] * s + st[i + 2] * c;
        }
        outStrands.push(copy);
      }
    }
  }
  applyTwistArr(outPos, params.twist || 0);
  for (const s of outStrands) applyTwistArr(s, params.twist || 0);
  return { positions: outPos, attr: outAttr, strands: outStrands };
}

// Arc-length resample a polyline (xyz triplets) to exactly m points.
export function resamplePolyline(arr, m) {
  const n = arr.length / 3;
  if (n < 2) return new Float32Array(m * 3);
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dx = arr[i * 3] - arr[(i - 1) * 3];
    const dy = arr[i * 3 + 1] - arr[(i - 1) * 3 + 1];
    const dz = arr[i * 3 + 2] - arr[(i - 1) * 3 + 2];
    cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const total = cum[n - 1] || 1;
  const out = new Float32Array(m * 3);
  let j = 1;
  for (let i = 0; i < m; i++) {
    const target = (i / (m - 1)) * total;
    while (j < n - 1 && cum[j] < target) j++;
    const t0 = cum[j - 1], t1 = cum[j];
    const f = t1 > t0 ? (target - t0) / (t1 - t0) : 0;
    for (let d = 0; d < 3; d++) {
      out[i * 3 + d] = arr[(j - 1) * 3 + d] + (arr[j * 3 + d] - arr[(j - 1) * 3 + d]) * f;
    }
  }
  return out;
}

// Live form-family selector: buckets the sound's CHARACTER into one of three
// archetypes (0 tonal-smooth, 1 bright-piercing, 2 rough-noisy) and derives a
// continuous wildness range-widener. Pure function of the fingerprint and
// deliberately seed-free: a steady sound keeps its archetype across morphs;
// speech vs whistle vs music land in different ones.
export function formArchetype(fp) {
  const cons = fp.consonance ?? 0.5;
  const tonal  = cons * (1 - fp.spread) * (1 - fp.centroid * 0.5);
  const bright = fp.centroid * (0.4 + 0.6 * fp.pitchMedian);
  const rough  = (1 - cons) * (0.5 + fp.spread) + fp.velocity * 0.3;
  const scores = [tonal, bright, rough];
  let index = 0;
  for (let i = 1; i < 3; i++) if (scores[i] > scores[index]) index = i;
  const wildness = Math.max(0, Math.min(1,
    0.45 * (1 - cons) + 0.3 * (fp.volVar ?? 0) + 0.25 * (fp.attackSlope ?? 0)));
  return { index, wildness };
}
