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
    // Lines group — used by Radial and Timbre modes
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
    this._linesGroup.visible = m === 'radial' || m === 'timbre';
    this._points.visible     = m !== 'radial';
    if      (m === 'chladni')   this._buildChladni(analysis, params);
    else if (m === 'radial')    this._buildRadial(analysis, params);
    else if (m === 'spectral')  this._buildSpectral(analysis, params);
    else if (m === 'timbre')    this._buildTimbre(analysis.frames || [], params);
    else if (m === 'attractor') this._buildAttractor(analysis, params);
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

  // ── Spherical Chladni ─────────────────────────────────────────
  //   Classic Chladni patterns lifted onto a sphere surface.
  //   f(θ,φ) = Σ_k amp_k · [sin(m_k·θ)·cos(n_k·φ) + sin(n_k·θ)·cos(m_k·φ)]
  //   Sand collects where |f| < threshold — on a sphere this produces
  //   spherical-harmonic-like banding patterns, genuinely 3D and unique
  //   per recording because each FFT peak drives a different (m,n) pair.
  _buildChladni(a, p) {
    const react = p.reactivity;
    const fft   = a.fftSnapshot || new Float32Array(128);

    // Derive up to 4 mode pairs from the loudest FFT peaks
    const peaks = [];
    for (let i = 2; i < 80; i++) {
      if (fft[i] > 0.04 && fft[i] > fft[i - 1] && fft[i] > fft[i + 1]) {
        peaks.push({ k: i, e: fft[i] });
      }
    }
    peaks.sort((a, b) => b.e - a.e);
    while (peaks.length < 2) peaks.push({ k: 8 + peaks.length * 14, e: 0.25 });

    const modes = peaks.slice(0, 4).map(pk => {
      const t = pk.k / 80;
      const m = Math.max(1, 1 + Math.round(t * 7 * react));
      let n   = Math.max(1, 1 + Math.round((1 - t + a.spectralCentroid * 0.4) * 6 * react));
      if (n === m) n = m + 1;
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
        const jT = (Math.random() - 0.5) * 0.010;
        const jP = (Math.random() - 0.5) * 0.010;
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
    const b  = Math.max(0.09, 0.21 - a.bass * react * 0.10 - a.spectralSpread * react * 0.03);
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
        const bright = Math.min(1.0, 0.18 / (speed + 0.09));

        if (p.autoColor) {
          const hue = (baseHue + speed * 0.12) % 1;
          const sat = 0.85 - bright * 0.65;
          const lum = Math.min(0.92, 0.08 + bright * 0.82) * p.brightness;
          _c.setHSL(hue, Math.max(0, sat), lum);
        } else {
          const c1 = new THREE.Color(p.colorPrimary);
          const c2 = new THREE.Color(p.colorSecondary);
          _c.copy(c1).lerp(c2, 1 - bright).multiplyScalar(p.brightness * (0.15 + bright * 0.85));
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
    const sizeFactor = Math.max(0.003, 0.009 * p.scale / Math.sqrt(Math.max(1, count / 40000)));
    this._points.material.size    = sizeFactor * p.pointSize * 0.6;
    this._points.material.opacity = Math.min(0.92, 0.72 * p.brightness);
  }

  // ── 3D Radial / orbital shells ────────────────────────────────
  //   Each ring is tilted into a unique 3D orientation via Rodrigues rotation,
  //   so the stack fans into a complex orbital sculpture rather than flat discs.
  //   Multi-harmonic deformation creates complex lobed shapes.
  //   Bass rings dip, treble rings rise; neighbouring rings interleave in 3D.
  _buildRadial(a, p) {
    const react = p.reactivity;
    const fft   = a.fftSnapshot || new Float32Array(128);
    const rings  = Math.min(MAX_LINES, Math.round(p.layers));
    const pool   = this._linesGroup.children;
    const PTS    = 512;

    for (let ri = 0; ri < MAX_LINES; ri++) {
      const line = pool[ri];
      if (ri >= rings) { line.visible = false; continue; }
      line.visible = true;

      const tR = ri / Math.max(1, rings - 1);

      // Band energy for this ring
      const lo = Math.floor(tR * 120);
      const hi = Math.min(127, Math.floor(((ri + 1) / rings) * 120));
      let energy = 0;
      for (let k = lo; k <= hi; k++) energy += fft[k];
      energy /= Math.max(1, hi - lo + 1);

      const baseR = (0.25 + tR * 0.75) * p.scale * (0.85 + a.volume * react * 0.35);
      const phase = a.dominantFreq * Math.PI * 6 * (ri + 1) + tR * p.twist * Math.PI * 2;
      const lobes = 2 + Math.round(a.dominantFreq * react * 10) + ri;

      // 3D tilt: each ring's plane rotated by Rodrigues' formula
      // tiltAngle increases through the stack; tiltAxis rotates with the ring index
      const tiltAngle = tR * Math.PI * (0.85 + a.spectralCentroid * react * 0.55);
      const axisAngle = ri * (Math.PI / Math.max(1, rings)) * 2.4 + a.dominantFreq * Math.PI * react;
      const ax = Math.cos(axisAngle), ay = Math.sin(axisAngle);
      const ct = Math.cos(tiltAngle), st = Math.sin(tiltAngle);

      const arr = line.geometry.getAttribute('position').array;

      for (let i = 0; i <= PTS; i++) {
        const θ = (i / PTS) * Math.PI * 2;

        const binIdx = Math.min(127, lo + Math.floor((θ / (Math.PI * 2)) * Math.max(1, hi - lo)));
        const fftVal = fft[binIdx];

        // Multi-harmonic deformation for complex, non-circular shapes
        const mod1 = Math.sin(lobes * θ + phase)                     * energy * react * 0.32;
        const mod2 = Math.sin(lobes * 2 * θ + phase * 1.53)          * energy * a.spectralCentroid * react * 0.18;
        const mod3 = fftVal                                            * react * 0.20;
        const mod4 = Math.cos((lobes + 1) * θ + phase * 0.71)        * energy * a.high * react * 0.13;

        const r = Math.max(0.05, baseR + mod1 + mod2 + mod3 + mod4);

        // Local point in the ring's flat plane before 3D tilt
        const lx = Math.cos(θ) * r;
        const ly = Math.sin(θ) * r;
        // Z deformation: meaningfully large for real depth
        const lz = (Math.sin(lobes * θ * 0.5 + phase)          * energy * 0.50
                 +  Math.cos(lobes * θ      + phase * 1.2)      * energy * a.high * react * 0.22) * p.scale;

        // Rodrigues' rotation: (lx, ly, lz) rotated by tiltAngle around (ax, ay, 0)
        const dot = ax * lx + ay * ly;
        const cx  =  ay * lz;
        const cy  = -ax * lz;
        const cz  =  ax * ly - ay * lx;

        arr[i * 3    ] = lx * ct + cx * st + ax * dot * (1 - ct);
        arr[i * 3 + 1] = ly * ct + cy * st + ay * dot * (1 - ct);
        arr[i * 3 + 2] = lz * ct + cz * st;
      }

      line.geometry.getAttribute('position').needsUpdate = true;
      line.geometry.setDrawRange(0, PTS + 1);

      const c = _ringColor(tR, a, p, energy);
      line.material.color.set(c);
      line.material.opacity = Math.min(1, Math.max(0.25, 0.28 + energy * p.brightness * 0.95));
    }
  }
}

// ── Color helpers ─────────────────────────────────────────────────
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
