const MAX_LINES   = 64;
const MAX_PTS     = 1025;     // 1024 points + close loop
const MAX_DENSITY = 250000;

export class SoundRenderer {
  constructor(container) {
    this.container = container;
    this._rotY = 0; this._rotX = 0;
    this._dragX = 0; this._dragY = 0;
    this._zoom = 1;
    this._initThree();
    this._initPools();
    this._initDrag();
  }

  // ── Three.js ──────────────────────────────────────────────────
  _initThree() {
    const w = this.container.clientWidth  || (window.innerWidth  - 272);
    const h = this.container.clientHeight || window.innerHeight;

    this.scene  = new THREE.Scene();
    this.scene.background = new THREE.Color(0x03040a);

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 100);
    this.camera.position.z = 4;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.container.appendChild(this.renderer.domElement);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    window.addEventListener('resize', () => {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
  }

  // ── Object pools ──────────────────────────────────────────────
  _initPools() {
    // Lines group — used by Timbre mode
    this._linesGroup = new THREE.Group();
    for (let i = 0; i < MAX_LINES; i++) {
      const pos  = new Float32Array(MAX_PTS * 3);
      const attr = new THREE.BufferAttribute(pos, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      const geo  = new THREE.BufferGeometry();
      geo.setAttribute('position', attr);
      const mat  = new THREE.LineBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.7,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      this._linesGroup.add(line);
    }
    this.group.add(this._linesGroup);

    // Particle system — used by Chladni, Spectral, Timbre, Attractor
    const pPos  = new Float32Array(MAX_DENSITY * 3);
    const pCol  = new Float32Array(MAX_DENSITY * 3);
    const posA  = new THREE.BufferAttribute(pPos, 3);
    posA.setUsage(THREE.DynamicDrawUsage);
    const colA  = new THREE.BufferAttribute(pCol, 3);
    colA.setUsage(THREE.DynamicDrawUsage);
    const pGeo  = new THREE.BufferGeometry();
    pGeo.setAttribute('position', posA);
    pGeo.setAttribute('color',    colA);
    const pMat  = new THREE.PointsMaterial({
      size: 0.012, vertexColors: true, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this._points = new THREE.Points(pGeo, pMat);
    this._points.visible = false;
    this.group.add(this._points);
  }

  // ── Drag & pinch ──────────────────────────────────────────────
  _initDrag() {
    const el = this.renderer.domElement;
    let down = false, ox = 0, oy = 0, pinch0 = 0;
    const start = (x, y) => { down = true; ox = x; oy = y; };
    const move  = (x, y) => {
      if (!down) return;
      this._dragY += (x - ox) * 0.007;
      this._dragX += (y - oy) * 0.005;
      ox = x; oy = y;
    };
    const end = () => { down = false; };
    el.addEventListener('mousedown', e => start(e.clientX, e.clientY));
    window.addEventListener('mousemove', e => move(e.clientX, e.clientY));
    window.addEventListener('mouseup', end);
    el.addEventListener('touchstart', e => {
      if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY);
      if (e.touches.length === 2) {
        down = false;
        pinch0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                            e.touches[0].clientY - e.touches[1].clientY);
      }
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('touchmove', e => {
      if (e.touches.length === 1) { move(e.touches[0].clientX, e.touches[0].clientY); return; }
      if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                             e.touches[0].clientY - e.touches[1].clientY);
        this._zoom = Math.max(0.3, Math.min(4, this._zoom * (d / (pinch0 || d))));
        pinch0 = d;
      }
    });
    window.addEventListener('touchend', end);
    el.addEventListener('wheel', e => {
      this._zoom = Math.max(0.3, Math.min(4, this._zoom * (1 - e.deltaY * 0.001)));
      e.preventDefault();
    }, { passive: false });
  }

  // ── Public API ────────────────────────────────────────────────
  captureDesign(analysis, params) {
    const m = params.mode;
    this._linesGroup.visible = m === 'timbre' || m === 'lorenz';
    this._points.visible     = m !== 'lorenz';
    if      (m === 'chladni')   this._buildChladni(analysis, params);
    else if (m === 'spectral')  this._buildSpectral(analysis, params);
    else if (m === 'timbre')    this._buildTimbre(analysis.frames || [], params);
    else if (m === 'attractor') this._buildAttractor(analysis, params);
    else if (m === 'lorenz')    this._buildLorenz(analysis, params);
  }

  clear() {
    for (const line of this._linesGroup.children) line.visible = false;
    this._linesGroup.visible = false;
    this._points.visible     = false;
    this.renderer.render(this.scene, this.camera);
  }

  tick(params) {
    this._rotY += params.rotSpeed * 0.003;
    this._rotX += params.rotSpeed * 0.0007;
    this.group.rotation.y = this._rotY + this._dragY;
    this.group.rotation.x = Math.sin(this._rotX) * 0.18 + this._dragX;
    this.camera.position.z = 4 / this._zoom;
    this.renderer.render(this.scene, this.camera);
  }

  getCanvas() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement;
  }

  exportSVG() {
    this.renderer.render(this.scene, this.camera);

    const canvas = this.renderer.domElement;
    const w = canvas.width;
    const h = canvas.height;

    // Build MVP matrix: projection × view × group-world-rotation
    this.group.updateMatrixWorld(true);
    const mvp = new THREE.Matrix4()
      .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      .multiply(this.group.matrixWorld);

    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
      `  <rect width="${w}" height="${h}" fill="#03040a"/>`,
    ];

    const vec = new THREE.Vector3();

    if (this._points.visible) {
      const geo   = this._points.geometry;
      const total = Math.min(geo.drawRange.count, geo.getAttribute('position').array.length / 3);
      const pos   = geo.getAttribute('position').array;
      const col   = geo.getAttribute('color').array;

      // Figma rasterises SVGs above ~3 MB. Cap at 15 k circles; scale radius up
      // to compensate for the lower density (area ∝ r², so scale by √stride).
      const MAX_SVG_PTS = 15000;
      const stride  = Math.max(1, Math.ceil(total / MAX_SVG_PTS));
      const fovCot  = this.camera.projectionMatrix.elements[5];
      const baseR   = (this._points.material.size * fovCot * h * 0.5) / this.camera.position.z;
      const r       = Math.max(0.5, baseR * Math.sqrt(stride)).toFixed(1);
      const op      = this._points.material.opacity.toFixed(2);

      // Helper: float 0-1 → two-digit hex byte
      const hex2 = v => Math.round(Math.max(0, Math.min(255, v * 255))).toString(16).padStart(2, '0');

      parts.push('  <g>');
      for (let i = 0; i < total; i += stride) {
        vec.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        vec.applyMatrix4(mvp);
        if (vec.z < -1 || vec.z > 1) continue; // outside near/far clip planes

        const sx  = ((vec.x + 1) * 0.5 * w).toFixed(1);
        const sy  = ((1 - vec.y) * 0.5 * h).toFixed(1);
        const hex = `#${hex2(col[i * 3])}${hex2(col[i * 3 + 1])}${hex2(col[i * 3 + 2])}`;
        parts.push(`    <circle cx="${sx}" cy="${sy}" r="${r}" fill="${hex}" opacity="${op}"/>`);
      }
      parts.push('  </g>');
    }

    if (this._linesGroup.visible) {
      for (const line of this._linesGroup.children) {
        if (!line.visible) continue;
        const geo   = line.geometry;
        const count = geo.drawRange.count;
        const pos   = geo.getAttribute('position').array;
        const stroke = '#' + line.material.color.getHexString();
        const op     = line.material.opacity.toFixed(2);
        const pts    = [];

        for (let i = 0; i < count; i++) {
          vec.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
          vec.applyMatrix4(mvp);
          if (vec.z > 1) continue;
          pts.push(`${((vec.x + 1) * 0.5 * w).toFixed(1)},${((1 - vec.y) * 0.5 * h).toFixed(1)}`);
        }
        if (pts.length > 1)
          parts.push(`  <polyline points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="1.2" opacity="${op}"/>`);
      }
    }

    parts.push('</svg>');
    return parts.join('\n');
  }

  // ── Spherical Chladni ─────────────────────────────────────────
  //   Classic Chladni patterns lifted onto a sphere surface.
  //   f(θ,φ) = Σ_k amp_k · [sin(m_k·θ)·cos(n_k·φ) + sin(n_k·θ)·cos(m_k·φ)]
  //   Sand collects where |f| < threshold — on a sphere this produces
  //   spherical-harmonic-like banding patterns, genuinely 3D and unique
  //   per recording because each FFT peak drives a different (m,n) pair.
  _buildChladni(a, p) {
    const react = p.reactivity;
    const fft   = a.fftSnapshot || new Float32Array(128);

    // Derive up to 6 mode pairs from the loudest FFT peaks
    const peaks = [];
    for (let i = 2; i < 80; i++) {
      if (fft[i] > 0.04 && fft[i] > fft[i - 1] && fft[i] > fft[i + 1]) {
        peaks.push({ k: i, e: fft[i] });
      }
    }
    peaks.sort((a, b) => b.e - a.e);
    // Fallback peaks derived from audio features so quiet recordings still vary
    while (peaks.length < 3) {
      const kBase = 5 + Math.round((a.dominantFreq * 47 + a.spectralCentroid * 31 + peaks.length * 23) % 68);
      peaks.push({ k: Math.max(2, kBase), e: 0.15 + a.spectralCentroid * 0.15 });
    }

    // Wider multipliers (14/11 vs 7/6) expand the integer range so different
    // recordings produce distinct (m,n) pairs. spectralSpread drives n independently
    // of m so tonal vs noisy audio looks different.
    const modes = peaks.slice(0, 6).map((pk, idx) => {
      const t = pk.k / 80;
      const m = Math.max(1, 2 + Math.round(t * 14 * react) + idx * 2);
      let n   = Math.max(1, 2 + Math.round((1 - t + a.spectralCentroid * 0.7 + a.spectralSpread * 0.5) * 11 * react) + idx);
      if (n === m) n = m + 1;
      if (n === m) n = m + 2;
      return { m, n, amp: pk.e };
    });

    // Spherical grid — tRes × pRes samples
    const tRes = Math.round((180 + p.complexity * 1.5) * (1 + a.high * react * 0.4));
    const pRes = tRes * 2;

    const threshold = 0.05 + a.volume * react * 0.08;
    const R = p.scale * (0.95 + a.bass * react * 0.15);

    const posArr = this._points.geometry.getAttribute('position').array;
    const colArr = this._points.geometry.getAttribute('color').array;
    let count = 0;
    const _c = new THREE.Color();
    const hueBase = (a.spectralCentroid * 0.6 + a.dominantFreq * 0.2) % 1;

    for (let i = 0; i < tRes && count < MAX_DENSITY - 1; i++) {
      const theta = (i / (tRes - 1)) * Math.PI;
      const sinT  = Math.sin(theta);
      const cosT  = Math.cos(theta);

      for (let j = 0; j < pRes && count < MAX_DENSITY - 1; j++) {
        const phi  = (j / (pRes - 1)) * Math.PI * 2;

        // Superposition of Chladni modes in spherical coordinates
        let f = 0;
        let dominantMode = 0, dominantAmp = 0;
        for (let mi = 0; mi < modes.length; mi++) {
          const { m, n, amp } = modes[mi];
          const fi = Math.sin(m * theta) * Math.cos(n * phi)
                   + Math.sin(n * theta) * Math.cos(m * phi);
          const contrib = fi * amp;
          f += contrib;
          if (Math.abs(contrib) > dominantAmp) {
            dominantAmp = Math.abs(contrib);
            dominantMode = mi;
          }
        }

        if (Math.abs(f) > threshold) continue;

        // Tiny jitter along sphere surface for organic sand texture
        // Deterministic jitter: same audio → same pixel positions
        const _fh = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
        const jT = (_fh(i * 2,     j * 3    ) - 0.5) * 0.010;
        const jP = (_fh(i * 3 + 1, j * 2 + 1) - 0.5) * 0.010;
        const th2 = theta + jT, ph2 = phi + jP;
        const sT2 = Math.sin(th2), cT2 = Math.cos(th2);

        posArr[count * 3    ] = sT2 * Math.cos(ph2) * R;
        posArr[count * 3 + 1] = sT2 * Math.sin(ph2) * R;
        posArr[count * 3 + 2] = cT2 * R;

        // Color: hue shifts azimuthally + by dominant contributing mode
        const modeShift = dominantMode / Math.max(1, modes.length);
        if (p.autoColor) {
          const hue = (hueBase + phi / (Math.PI * 2) * 0.4 + modeShift * 0.3) % 1;
          const lum = 0.48 + Math.abs(f) * 0.30;
          _c.setHSL(hue, 0.88, Math.min(0.88, lum * p.brightness));
        } else {
          const c1 = new THREE.Color(p.colorPrimary);
          const c2 = new THREE.Color(p.colorSecondary);
          _c.copy(c1).lerp(c2, phi / (Math.PI * 2)).multiplyScalar(p.brightness);
        }
        colArr[count * 3    ] = _c.r;
        colArr[count * 3 + 1] = _c.g;
        colArr[count * 3 + 2] = _c.b;
        count++;
      }
    }

    this._points.geometry.getAttribute('position').needsUpdate = true;
    this._points.geometry.getAttribute('color').needsUpdate    = true;
    this._points.geometry.setDrawRange(0, count);
    this._points.material.size    = 0.007 * p.scale * (1 + a.volume * 0.4);
    this._points.material.opacity = Math.min(0.95, 0.78 * p.brightness);
  }

  // ── Spectral helix / acoustic proximity ──────────────────────
  //   Each of 128 FFT bins maps to a deterministic seed on a log-frequency helix.
  //   Pitch → angle, octave → Z height.  Harmonics spiral into vertical columns;
  //   chords cluster in angular arcs.  Per-bin particle clouds (islands) encode
  //   local spectral texture: smooth (tonal) = tight globe, rough (noise/sibilance)
  //   = elongated streak along the helix tangent.
  _buildSpectral(a, p) {
    const fft   = a.fftSnapshot || new Float32Array(128);
    const react = p.reactivity;

    const TURNS   = Math.max(0.5, p.helixTurns || 2.0);
    const HELIX_R = 0.6 * p.scale;
    const HELIX_H = 1.8 * p.scale;
    const LOG_MAX = Math.log2(129);

    const fract = x => x - Math.floor(x);
    const h = (s, i, salt) => fract(Math.sin(s * salt + i * (salt * 2.459)) * 43758.5453) * 2 - 1;

    const posArr = this._points.geometry.getAttribute('position').array;
    const colArr = this._points.geometry.getAttribute('color').array;
    let count = 0;
    const _c     = new THREE.Color();
    const PER_BIN = Math.max(2, Math.floor(p.density / 128));

    for (let k = 0; k < 128; k++) {
      const energy = fft[k];
      if (energy < 0.018) continue;

      const t     = Math.log2(k + 1) / LOG_MAX;
      const angle = t * Math.PI * 2 * TURNS;

      const sx = Math.cos(angle) * HELIX_R;
      const sy = Math.sin(angle) * HELIX_R;
      const sz = (t - 0.5) * HELIX_H;

      const radialX =  Math.cos(angle);
      const radialY =  Math.sin(angle);
      const tangX   = -Math.sin(angle);
      const tangY   =  Math.cos(angle);

      const lo = Math.max(0, k - 4), hi = Math.min(127, k + 4);
      let mean = 0;
      for (let j = lo; j <= hi; j++) mean += fft[j];
      mean /= (hi - lo + 1);
      let variance = 0;
      for (let j = lo; j <= hi; j++) variance += (fft[j] - mean) ** 2;
      const texture  = Math.min(1, Math.sqrt(variance / (hi - lo + 1)) * 8);
      const elongate = 1 + texture * 5;

      const islandR = (0.05 + energy * 0.20) * p.scale;
      const nPts = Math.min(PER_BIN, Math.ceil(energy * react * PER_BIN));
      if (count + nPts > MAX_DENSITY) break;

      for (let i = 0; i < nPts; i++) {
        const d1 = h(k, i, 127.1);
        const d2 = h(k, i, 269.5);
        const d3 = h(k, i, 419.2);

        posArr[count * 3    ] = sx + radialX * d1 * islandR + tangX * d2 * islandR * elongate;
        posArr[count * 3 + 1] = sy + radialY * d1 * islandR + tangY * d2 * islandR * elongate;
        posArr[count * 3 + 2] = sz + d3 * islandR * 0.5;

        if (p.autoColor) {
          const hue = (t * 0.70 + 0.05 + a.spectralCentroid * 0.10) % 1;
          const sat = 1.0 - texture * 0.35;
          const lum = Math.min(0.88, 0.38 + energy * 0.52);
          _c.setHSL(hue, sat, lum);
        } else {
          const c1 = new THREE.Color(p.colorPrimary);
          const c2 = new THREE.Color(p.colorSecondary);
          _c.copy(c1).lerp(c2, t).multiplyScalar(p.brightness * (0.4 + energy));
        }
        colArr[count * 3    ] = _c.r;
        colArr[count * 3 + 1] = _c.g;
        colArr[count * 3 + 2] = _c.b;
        count++;
      }
    }

    this._points.geometry.getAttribute('position').needsUpdate = true;
    this._points.geometry.getAttribute('color').needsUpdate    = true;
    this._points.geometry.setDrawRange(0, count);
    this._points.material.size    = (0.008 + p.pointSize * 0.003) * p.scale * (1 + a.volume * 0.4);
    this._points.material.opacity = Math.min(0.95, 0.82 * p.brightness);
  }

  // ── 3D Timbre space (acoustic trajectory) ────────────────────
  //   Each recorded frame → point in 3D feature space.
  //   X = spectral centroid, Y = volume, Z = spectral spread.
  _buildTimbre(frames, p) {
    if (!frames || frames.length < 2) return;
    const N = frames.length;

    let minC = Infinity, maxC = -Infinity;
    let minV = Infinity, maxV = -Infinity;
    let minS = Infinity, maxS = -Infinity;
    for (const f of frames) {
      if (f.spectralCentroid < minC) minC = f.spectralCentroid;
      if (f.spectralCentroid > maxC) maxC = f.spectralCentroid;
      if (f.volume           < minV) minV = f.volume;
      if (f.volume           > maxV) maxV = f.volume;
      if (f.spectralSpread   < minS) minS = f.spectralSpread;
      if (f.spectralSpread   > maxS) maxS = f.spectralSpread;
    }
    const rC = Math.max(0.001, maxC - minC);
    const rV = Math.max(0.001, maxV - minV);
    const rS = Math.max(0.001, maxS - minS);
    const sc = p.scale * 2.0;

    const pts = frames.map(f => [
      ((f.spectralCentroid - minC) / rC - 0.5) * sc,
      ((f.volume           - minV) / rV - 0.5) * sc * 0.65,
      ((f.spectralSpread   - minS) / rS - 0.5) * sc,
    ]);

    const segs = Math.min(MAX_LINES, N - 1);
    const pool = this._linesGroup.children;

    for (let li = 0; li < MAX_LINES; li++) {
      const line = pool[li];
      if (li >= segs) { line.visible = false; continue; }
      line.visible = true;

      const iA = Math.floor((li / segs) * (N - 1));
      const iB = Math.min(N - 1, Math.ceil(((li + 1) / segs) * (N - 1)));
      const segLen = iB - iA + 1;
      const arr = line.geometry.getAttribute('position').array;
      for (let j = 0; j < segLen; j++) {
        const pt = pts[iA + j];
        arr[j * 3] = pt[0]; arr[j * 3 + 1] = pt[1]; arr[j * 3 + 2] = pt[2];
      }
      line.geometry.getAttribute('position').needsUpdate = true;
      line.geometry.setDrawRange(0, segLen);

      const tMid = (li + 0.5) / segs;
      const c = p.autoColor
        ? new THREE.Color().setHSL((0.65 - tMid * 0.45 + 1) % 1, 0.9, 0.5 + tMid * 0.25)
        : new THREE.Color(tMid < 0.5
            ? new THREE.Color(p.colorPrimary).lerp(new THREE.Color(p.colorSecondary), tMid * 2)
            : new THREE.Color(p.colorSecondary).lerp(new THREE.Color(p.colorAccent), (tMid - 0.5) * 2)
          ).multiplyScalar(p.brightness);
      line.material.color.set(c);
      line.material.opacity = Math.min(1, 0.35 + tMid * 0.55);
    }

    const posArr = this._points.geometry.getAttribute('position').array;
    const colArr = this._points.geometry.getAttribute('color').array;
    const _c = new THREE.Color();
    const nodeN = Math.min(N, MAX_DENSITY);

    for (let i = 0; i < nodeN; i++) {
      const f  = frames[i];
      const pt = pts[i];
      posArr[i * 3] = pt[0]; posArr[i * 3 + 1] = pt[1]; posArr[i * 3 + 2] = pt[2];

      if (p.autoColor) {
        const hue = (0.62 - f.spectralCentroid * 0.52 + 1) % 1;
        const lum = Math.min(0.92, 0.28 + f.volume * 0.72);
        _c.setHSL(hue, 0.95, lum);
      } else {
        const t = i / (N - 1);
        const c1 = new THREE.Color(p.colorPrimary);
        const c2 = new THREE.Color(p.colorSecondary);
        _c.copy(c1).lerp(c2, t).multiplyScalar(p.brightness * (0.4 + f.volume));
      }
      colArr[i * 3] = _c.r; colArr[i * 3 + 1] = _c.g; colArr[i * 3 + 2] = _c.b;
    }

    this._points.geometry.getAttribute('position').needsUpdate = true;
    this._points.geometry.getAttribute('color').needsUpdate    = true;
    this._points.geometry.setDrawRange(0, nodeN);
    this._points.material.size    = 0.045 * p.scale * (p.pointSize / 2);
    this._points.material.opacity = Math.min(0.95, 0.88 * p.brightness);
  }

  // ── Thomas attractor particle cloud ──────────────────────────
  //   ẋ = sin(y)−b·x, ẏ = sin(z)−b·y, ż = sin(x)−b·z
  //   b (damping) driven by bass: lower = more loops, more complexity.
  //   Speed-based brightness: slow regions dwell on the manifold = bright streaks.
  _buildAttractor(a, p) {
    const react = p.reactivity;
    // Thomas attractor is chaotic for b < 0.208; above that it collapses to a fixed point.
    // Bass energy lowers b toward 0.10 for denser, more complex loops.
    const b  = Math.max(0.10, 0.185 - a.bass * react * 0.07 - (a.spectralSpread || 0) * react * 0.02);
    const dt = 0.05;

    const nPoints     = Math.min(MAX_DENSITY, Math.floor(p.density));
    const nSeeds      = Math.max(1, Math.min(8, 2 + Math.round(a.spectralCentroid * react * 5)));
    const warmup      = 4000;
    const stepsPerSeed = Math.floor(nPoints / nSeeds);

    const posArr = this._points.geometry.getAttribute('position').array;
    const colArr = this._points.geometry.getAttribute('color').array;
    const _c     = new THREE.Color();
    const sc     = p.scale * 0.30;
    const baseHue = p.autoColor ? (0.72 - a.spectralCentroid * 0.18 + 1) % 1 : 0;

    const fract = x => x - Math.floor(x);
    const hash  = s => fract(Math.sin(s * 127.1) * 43758.5453);

    let count = 0;

    for (let seed = 0; seed < nSeeds && count < nPoints; seed++) {
      let x = (hash(seed * 3.1)  - 0.5) * 0.8;
      let y = (hash(seed * 7.3)  - 0.5) * 0.8;
      let z = (hash(seed * 13.7) - 0.5) * 0.8;

      for (let i = 0; i < warmup; i++) {
        const dx = Math.sin(y) - b * x;
        const dy = Math.sin(z) - b * y;
        const dz = Math.sin(x) - b * z;
        x += dx * dt; y += dy * dt; z += dz * dt;
      }

      const step = Math.min(stepsPerSeed, nPoints - count);
      for (let i = 0; i < step; i++) {
        const dx = Math.sin(y) - b * x;
        const dy = Math.sin(z) - b * y;
        const dz = Math.sin(x) - b * z;
        x += dx * dt; y += dy * dt; z += dz * dt;

        posArr[count * 3    ] = x * sc;
        posArr[count * 3 + 1] = y * sc;
        posArr[count * 3 + 2] = z * sc;

        const speed  = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // Slow regions dwell on the attractor manifold → brighter (density proxy).
        // Tuned so typical speed 0.35 → bright≈0.55, near-standstill → bright≈1.0.
        const bright = Math.min(1.0, 0.25 / (speed + 0.12));

        if (p.autoColor) {
          const hue = (baseHue + speed * 0.10) % 1;
          const sat = 0.80 - bright * 0.45;          // desaturate to white at bright spots
          const lum = Math.min(0.92, 0.30 + bright * 0.62) * p.brightness;
          _c.setHSL(hue, Math.max(0.1, sat), lum);
        } else {
          const c1 = new THREE.Color(p.colorPrimary);
          const c2 = new THREE.Color(p.colorSecondary);
          _c.copy(c1).lerp(c2, 1 - bright).multiplyScalar(p.brightness * (0.3 + bright * 0.7));
        }
        colArr[count * 3    ] = _c.r;
        colArr[count * 3 + 1] = _c.g;
        colArr[count * 3 + 2] = _c.b;
        count++;
      }
    }

    this._points.geometry.getAttribute('position').needsUpdate = true;
    this._points.geometry.getAttribute('color').needsUpdate    = true;
    this._points.geometry.setDrawRange(0, count);
    this._points.material.size    = 0.014 * p.scale * p.pointSize * 0.5;
    this._points.material.opacity = Math.min(0.95, 0.85 * p.brightness);
  }

  // ── Lorenz attractor — continuous line strips ─────────────────
  //   dx/dt = σ(y−x)  dy/dt = x(ρ−z)−y  dz/dt = xy−βz
  //   Audio drives σ (timbre), ρ (bass/power), β (treble).
  //   Trajectory rendered as 64 rainbow line strips wound around
  //   the butterfly manifold — each strip a different spectral hue.
  _buildLorenz(a, p) {
    const react = p.reactivity;

    // Lorenz parameters — always in the chaotic regime
    const sigma = 10 + a.spectralCentroid * react * 4.0;  // [10, 14]
    const rho   = 24 + a.bass             * react * 14.0; // [24, 38]
    const beta  = 2.0 + a.high            * react * 1.5;  // [2.0, 3.5]
    const dt    = 0.007;
    const PTS   = Math.min(MAX_PTS - 1, Math.round(800 + p.complexity * 3));

    // Warmup — settle onto the attractor
    let x = 1.0, y = 0.0, z = 20.0;
    for (let i = 0; i < 3000; i++) {
      const dx = sigma * (y - x);
      const dy = x * (rho - z) - y;
      const dz = x * y - beta * z;
      x += dx * dt; y += dy * dt; z += dz * dt;
    }

    const zCenter = rho - sigma;
    const sc      = p.scale * 0.028;
    const nLines  = MAX_LINES;
    const pool    = this._linesGroup.children;

    for (let li = 0; li < MAX_LINES; li++) {
      const line = pool[li];
      line.visible = true;
      const arr = line.geometry.getAttribute('position').array;

      for (let i = 0; i <= PTS; i++) {
        const dx = sigma * (y - x);
        const dy = x * (rho - z) - y;
        const dz = x * y - beta * z;
        x += dx * dt; y += dy * dt; z += dz * dt;
        arr[i * 3    ] = x * sc;
        arr[i * 3 + 1] = y * sc;
        arr[i * 3 + 2] = (z - zCenter) * sc;
      }

      line.geometry.getAttribute('position').needsUpdate = true;
      line.geometry.setDrawRange(0, PTS + 1);

      // Cycle full spectrum across the 64 line strips
      const tLine = li / nLines;
      const hue   = p.autoColor ? tLine : 0;
      const c = p.autoColor
        ? new THREE.Color().setHSL(hue, 0.92, Math.min(0.72, 0.42 + tLine * 0.3) * p.brightness)
        : new THREE.Color(p.colorPrimary).clone()
            .lerp(new THREE.Color(p.colorSecondary), tLine)
            .multiplyScalar(p.brightness);
      line.material.color.set(c);
      line.material.opacity = Math.min(0.9, 0.3 + tLine * 0.55);
    }
  }

}
 ─────────────────────────────────────────────────
function _ringColor(tR, a, p, energy) {
  if (p.autoColor) {
    const hue = (0.05 + tR * 0.7 + a.spectralCentroid * 0.2) % 1;
    const lum = Math.min(0.85, 0.45 + energy * 0.4);
    return new THREE.Color().setHSL(hue, 0.9, lum);
  }
  const c1 = new THREE.Color(p.colorPrimary);
  const c2 = new THREE.Color(p.colorSecondary);
  const c3 = new THREE.Color(p.colorAccent);
  const c  = tR < 0.5 ? c1.clone().lerp(c2, tR * 2) : c2.clone().lerp(c3, (tR - 0.5) * 2);
  return c.multiplyScalar(p.brightness * (0.6 + energy * 0.6));
}
