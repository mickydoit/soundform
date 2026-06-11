const MAX_LINES   = 64;
const MAX_PTS     = 1025;     // 1024 points + close loop
const MAX_DENSITY = 250000;   // Chladni particle budget

export class SoundRenderer {
  constructor(container) {
    this.container = container;
    this._rotY = 0; this._rotX = 0;
    this._dragX = 0; this._dragY = 0;
    this._zoom = 1;
    this._initThree();
    this._initPools();
    this._initDrag();
    this._initSDF();
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
    // Lines group — used by Radial mode
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

    // Particle system — used by Chladni mode
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
    this._points.visible     = m !== 'radial' && m !== 'fluid';
    this._sdfMesh.visible    = m === 'fluid';
    if      (m === 'chladni')  this._buildChladni(analysis, params);
    else if (m === 'radial')   this._buildRadial(analysis, params);
    else if (m === 'spectral') this._buildSpectral(analysis, params);
    else if (m === 'timbre')   this._buildTimbre(analysis.frames || [], params);
    else if (m === 'fluid')    this._setSdfUniforms(analysis, params);
  }

  clear() {
    for (const line of this._linesGroup.children) line.visible = false;
    this._linesGroup.visible = false;
    this._points.visible     = false;
    this._sdfMesh.visible    = false;
    this.renderer.render(this.scene, this.camera);
  }

  tick(params) {
    this._rotY += params.rotSpeed * 0.003;
    this._rotX += params.rotSpeed * 0.0007;
    this.group.rotation.y = this._rotY + this._dragY;
    this.group.rotation.x = Math.sin(this._rotX) * 0.18 + this._dragX;
    this.camera.position.z = 4 / this._zoom;
    if (params.mode === 'fluid' && this._sdfMesh.visible) {
      this._sdfEuler.set(this.group.rotation.x, this.group.rotation.y, 0, 'XYZ');
      this._sdfM4.makeRotationFromEuler(this._sdfEuler);
      this._sdfM3.setFromMatrix4(this._sdfM4);
    }
    this.renderer.render(this.scene, this.camera);
  }

  getCanvas() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement;
  }

  // ── Chladni plate pattern ─────────────────────────────────────
  //   f(x,y) = sin(m·π·x)·cos(n·π·y) + sin(n·π·x)·cos(m·π·y)
  //   Sand collects where f ≈ 0 (the nodal lines)
  _buildChladni(a, p) {
    const react = p.reactivity;

    // Dominant frequency → Chladni mode numbers (pitch = pattern shape)
    // Low note: small m,n (1-3) → simple cross/diamond
    // High note: large m,n (5-9) → complex starburst
    let m = 1 + Math.round(a.dominantFreq * 7 * react);
    let n = 1 + Math.round(a.spectralCentroid * 5 * react);
    if (m === n) n = m + 1; // ensure m≠n for more interesting asymmetric forms

    // Grid resolution — treble adds fine detail
    const res       = Math.round(280 + p.complexity * 1.8 * (1 + a.high * react));
    // Nodal line width — volume controls how thick the "sand lines" are
    const threshold = 0.04 + a.volume * react * 0.09;
    // Scale
    const scale     = p.scale * (0.9 + a.bass * react * 0.3);

    const posArr = this._points.geometry.getAttribute('position').array;
    const colArr = this._points.geometry.getAttribute('color').array;
    let count = 0;

    const _c      = new THREE.Color();
    const hueBase = (a.spectralCentroid * 0.7 + a.dominantFreq * 0.3) % 1;

    for (let i = 0; i < res && count < MAX_DENSITY - 1; i++) {
      for (let j = 0; j < res && count < MAX_DENSITY - 1; j++) {
        const x = (i / (res - 1)) * 2 - 1;  // –1 to 1
        const y = (j / (res - 1)) * 2 - 1;

        // Circular plate boundary
        const r2 = x * x + y * y;
        if (r2 > 1) continue;

        // Chladni function
        const f = Math.sin(m * Math.PI * x) * Math.cos(n * Math.PI * y)
                + Math.sin(n * Math.PI * x) * Math.cos(m * Math.PI * y);

        if (Math.abs(f) > threshold) continue;

        // Tiny jitter for organic "sand" texture
        const jx = (Math.random() - 0.5) * 0.004;
        const jy = (Math.random() - 0.5) * 0.004;

        posArr[count * 3    ] = (x + jx) * scale;
        posArr[count * 3 + 1] = (y + jy) * scale;
        // Slight z from the function value — nodal lines sit at z=0,
        // surrounding material slightly above/below (3D membrane look)
        posArr[count * 3 + 2] = f * scale * 0.12;

        // Color shifts along the pattern
        const angle = Math.atan2(y, x); // –π to π
        const t     = (angle + Math.PI) / (Math.PI * 2); // 0–1
        if (p.autoColor) {
          const hue = (hueBase + t * 0.5 + Math.sqrt(r2) * 0.2) % 1;
          const lum = 0.55 + a.volume * 0.3;
          _c.setHSL(hue, 0.85, Math.min(0.85, lum));
        } else {
          const c1 = new THREE.Color(p.colorPrimary);
          const c2 = new THREE.Color(p.colorSecondary);
          _c.copy(c1).lerp(c2, t).multiplyScalar(p.brightness);
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
    this._points.material.size    = 0.008 * p.scale * (1 + a.volume * 0.5);
    this._points.material.opacity = Math.min(0.95, 0.75 * p.brightness);
  }

  // ── Fluid / SDF ray marching ─────────────────────────────────
  //   A fullscreen GLSL ray marcher driven entirely by audio uniforms.
  //   Bass swells the core; treble crinkles the surface; centroid and
  //   spread sculpt the satellite blob ring.  Same technique as the
  //   DSL tool in the screenshot — rewritten as portable GLSL.
  _initSDF() {
    const VERT = /* glsl */`
      varying vec2 vUv;
      void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }
    `;

    const FRAG = /* glsl */`
      varying vec2 vUv;
      uniform float uBass,uHigh,uVolume,uCentroid,uSpread,uReactivity,uScale,uBrightness,uAutoColor;
      uniform vec3  uColor1,uColor2;
      uniform mat3  uRot;
      uniform vec2  uRes;

      /* ── value noise ── */
      float h1(float n){return fract(sin(n)*43758.5453);}
      float vn(vec3 x){
        vec3 p=floor(x),f=fract(x);f=f*f*(3.-2.*f);
        float n=p.x+p.y*57.+113.*p.z;
        return mix(mix(mix(h1(n),h1(n+1.),f.x),mix(h1(n+57.),h1(n+58.),f.x),f.y),
                   mix(mix(h1(n+113.),h1(n+114.),f.x),mix(h1(n+170.),h1(n+171.),f.x),f.y),f.z)*2.-1.;
      }

      /* ── smooth union ── */
      float smin(float a,float b,float k){
        float h=clamp(.5+.5*(b-a)/k,0.,1.);return mix(b,a,h)-k*h*(1.-h);
      }

      /* ── SDF scene ──
           Core sphere swells with bass.
           4 satellite blobs arranged in a tilted ring driven by centroid & spread.
           Surface displaced by a noise field whose frequency & amplitude track treble.  */
      float map(vec3 p){
        float r=uReactivity,sc=uScale;
        float n=vn(p*(2.+uHigh*r*4.))*(0.05+uHigh*r*0.20);
        float d=length(p)-(0.48+uBass*r*0.30)*sc-n;
        float k=0.18+uBass*r*0.24;
        float rr=(0.42+uSpread*r*0.46)*sc;
        float bs=(0.13+uCentroid*r*0.15)*sc;
        float ct=cos(uCentroid*1.3+0.3),st=sin(uCentroid*1.3+0.3);
        d=smin(d,length(p-rr*vec3( 1.,0.,0.))-bs,k);
        d=smin(d,length(p-rr*vec3( 0., ct, st))-bs,k);
        d=smin(d,length(p-rr*vec3(-1.,0.,0.))-bs,k);
        d=smin(d,length(p-rr*vec3( 0.,-ct,-st))-bs,k);
        return d;
      }

      /* ── central-diff normal ── */
      vec3 nor(vec3 p){
        vec2 e=vec2(.002,0.);
        return normalize(vec3(map(p+e.xyy)-map(p-e.xyy),
                              map(p+e.yxy)-map(p-e.yxy),
                              map(p+e.yyx)-map(p-e.yyx)));
      }

      /* ── HSL helper ── */
      vec3 hsl(float h,float s,float l){
        vec3 rgb=clamp(abs(fract(h+vec3(0.,2./3.,1./3.))*6.-3.)-1.,0.,1.);
        return l+s*(rgb-.5)*(1.-abs(2.*l-1.));
      }

      void main(){
        vec2 uv=(vUv*2.-1.)*vec2(uRes.x/uRes.y,1.);

        /* camera at z=3.2, rotated by drag matrix */
        vec3 ro=uRot*vec3(0.,0.,3.2);
        vec3 ww=normalize(-ro);
        vec3 uu=normalize(cross(ww,uRot*vec3(0.,1.,0.)));
        vec3 vv=cross(uu,ww);
        vec3 rd=normalize(uv.x*uu+uv.y*vv+1.8*ww);

        /* ray march */
        float t=0.2; bool hit=false;
        for(int i=0;i<56;i++){
          float d=map(ro+rd*t);
          if(d<0.001){hit=true;break;}
          if(t>7.)break;
          t+=d*0.85;
        }
        if(!hit){gl_FragColor=vec4(0.);return;}

        vec3 pos=ro+rd*t;
        vec3 n=nor(pos);

        /* Phong shading — two lights + rim + sky AO */
        vec3 l1=normalize(vec3(.8,1.2,1.5));
        vec3 l2=normalize(vec3(-1.,-.3,-.8));
        float diff =max(0.,dot(n,l1));
        float diff2=max(0.,dot(n,l2))*.22;
        float spec =pow(max(0.,dot(reflect(-l1,n),-rd)),36.)*.55;
        float rim  =pow(1.-max(0.,dot(n,-rd)),3.)*.50;
        float ao   =.45+.55*dot(n,vec3(0.,1.,0.));

        vec3 col = uAutoColor>.5
          ? hsl(.05+uCentroid*.65,.78,.50)
          : mix(uColor1,uColor2,uCentroid);
        col*=uBrightness;

        vec3 res=col*((diff+diff2)*ao+.10)+spec+rim*col*.65;
        float alpha=smoothstep(6.,2.5,t);
        gl_FragColor=vec4(res*alpha,alpha);
      }
    `;

    this._sdfMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uBass:       { value: 0.3 }, uHigh:      { value: 0.2 },
        uVolume:     { value: 0.5 }, uCentroid:  { value: 0.4 },
        uSpread:     { value: 0.3 }, uReactivity:{ value: 0.7 },
        uScale:      { value: 1.0 }, uBrightness:{ value: 0.9 },
        uAutoColor:  { value: 1.0 },
        uColor1:     { value: new THREE.Color(0x00d4ff) },
        uColor2:     { value: new THREE.Color(0xb44dff) },
        uRot:        { value: new THREE.Matrix3() },
        uRes:        { value: new THREE.Vector2(
                         this.container.clientWidth  || window.innerWidth  - 272,
                         this.container.clientHeight || window.innerHeight ) },
      },
      transparent: true, depthTest: false, depthWrite: false,
    });

    this._sdfMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._sdfMat);
    this._sdfMesh.visible = false;
    this.scene.add(this._sdfMesh);  // direct to scene — NOT in this.group

    // Pre-allocated so tick() never allocates per frame
    this._sdfEuler = new THREE.Euler();
    this._sdfM4    = new THREE.Matrix4();
    this._sdfM3    = this._sdfMat.uniforms.uRot.value;  // shared reference

    window.addEventListener('resize', () => {
      this._sdfMat.uniforms.uRes.value.set(
        this.container.clientWidth, this.container.clientHeight);
    });
  }

  _setSdfUniforms(a, p) {
    const u = this._sdfMat.uniforms;
    u.uBass.value       = a.bass             || 0.3;
    u.uHigh.value       = a.high             || 0.2;
    u.uVolume.value     = a.volume           || 0.5;
    u.uCentroid.value   = a.spectralCentroid || 0.4;
    u.uSpread.value     = a.spectralSpread   || 0.3;
    u.uReactivity.value = p.reactivity;
    u.uScale.value      = p.scale;
    u.uBrightness.value = p.brightness;
    u.uAutoColor.value  = p.autoColor ? 1.0 : 0.0;
    u.uColor1.value.set(p.colorPrimary);
    u.uColor2.value.set(p.colorSecondary);
  }

  // ── Spectral helix / acoustic proximity ──────────────────────
  //   Each of 128 FFT bins maps to a deterministic seed on a log-frequency helix.
  //   Pitch → angle, octave → Z height.  Harmonics spiral into vertical columns;
  //   chords cluster in angular arcs.  Per-bin particle clouds (islands) encode
  //   local spectral texture: smooth (tonal) = tight globe, rough (noise/sibilance)
  //   = elongated streak along the helix tangent.  No Math.random() — all offsets
  //   from a GLSL-style hash so the same audio always yields the same geometry.
  _buildSpectral(a, p) {
    const fft   = a.fftSnapshot || new Float32Array(128);
    const react = p.reactivity;

    const TURNS   = Math.max(0.5, p.helixTurns || 2.0);
    const HELIX_R = 0.6 * p.scale;
    const HELIX_H = 1.8 * p.scale;
    const LOG_MAX = Math.log2(129);  // log2(128+1) — ensures k=0 maps to t=0

    // Deterministic hash: returns value in –1..1, no Math.random()
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

      // Log-frequency → helix parameter t (0 = DC, 1 = Nyquist)
      const t     = Math.log2(k + 1) / LOG_MAX;
      const angle = t * Math.PI * 2 * TURNS;

      // Seed on helix
      const sx = Math.cos(angle) * HELIX_R;
      const sy = Math.sin(angle) * HELIX_R;
      const sz = (t - 0.5) * HELIX_H;

      // Orthogonal basis at this seed:
      //   radial   = outward from helix axis
      //   tangential = along the helix circle
      const radialX =  Math.cos(angle);
      const radialY =  Math.sin(angle);
      const tangX   = -Math.sin(angle);
      const tangY   =  Math.cos(angle);

      // Local spectral texture: std-dev over ±4 neighbouring bins
      //   → 0 = tonal (pure tone, vowel formant) → tight sphere
      //   → 1 = noisy (sibilance, broadband) → elongated streak along tangent
      const lo = Math.max(0, k - 4), hi = Math.min(127, k + 4);
      let mean = 0;
      for (let j = lo; j <= hi; j++) mean += fft[j];
      mean /= (hi - lo + 1);
      let variance = 0;
      for (let j = lo; j <= hi; j++) variance += (fft[j] - mean) ** 2;
      const texture  = Math.min(1, Math.sqrt(variance / (hi - lo + 1)) * 8);
      const elongate = 1 + texture * 5;

      // Island radius scales with energy; larger spread = louder bin
      const islandR = (0.05 + energy * 0.20) * p.scale;

      const nPts = Math.min(PER_BIN, Math.ceil(energy * react * PER_BIN));
      if (count + nPts > MAX_DENSITY) break;

      for (let i = 0; i < nPts; i++) {
        // Three decorrelated pseudo-random axes (different prime seeds)
        const d1 = h(k, i, 127.1);   // radial spread
        const d2 = h(k, i, 269.5);   // tangential stretch (elongated for noisy bins)
        const d3 = h(k, i, 419.2);   // vertical jitter

        posArr[count * 3    ] = sx + radialX * d1 * islandR + tangX * d2 * islandR * elongate;
        posArr[count * 3 + 1] = sy + radialY * d1 * islandR + tangY * d2 * islandR * elongate;
        posArr[count * 3 + 2] = sz + d3 * islandR * 0.5;

        // Colour: bass = warm (red/orange), treble = cool (blue/violet)
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
  //   Each recorded frame becomes a point in 3D space:
  //     X = spectral centroid  (dark/bass ← → bright/treble)
  //     Y = volume             (quiet ↓  → loud ↑)
  //     Z = spectral spread    (tonal ← → noisy)
  //   Consecutive frames are connected by a time-gradient path so the
  //   recording draws a unique sculpture through acoustic feature space.
  //   Different words cluster in different regions; sentences trace paths.
  _buildTimbre(frames, p) {
    if (!frames || frames.length < 2) return;
    const N = frames.length;

    // Auto-range each axis so the trajectory fills the view
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

    // Normalised 3D position for each frame
    const pts = frames.map(f => [
      ((f.spectralCentroid - minC) / rC - 0.5) * sc,
      ((f.volume           - minV) / rV - 0.5) * sc * 0.65,
      ((f.spectralSpread   - minS) / rS - 0.5) * sc,
    ]);

    // ── Trajectory path: time-gradient line segments ─────────────
    // Divide the path into up to MAX_LINES segments; each gets its own
    // colour so the path shifts from start-colour → end-colour over time.
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

      // Colour: early = cool (blue/purple), late = warm (green/yellow)
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

    // ── Nodes: one point per frame, sized/coloured by acoustic state ─
    const posArr = this._points.geometry.getAttribute('position').array;
    const colArr = this._points.geometry.getAttribute('color').array;
    const _c = new THREE.Color();
    const nodeN = Math.min(N, MAX_DENSITY);

    for (let i = 0; i < nodeN; i++) {
      const f  = frames[i];
      const pt = pts[i];
      posArr[i * 3] = pt[0]; posArr[i * 3 + 1] = pt[1]; posArr[i * 3 + 2] = pt[2];

      if (p.autoColor) {
        // Spectral centroid → hue (dark=blue, bright=yellow-green)
        // Volume → lightness (loud = bright node)
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

  // ── Radial frequency visualizer ───────────────────────────────
  //   Each ring = one frequency octave band, modulated by its amplitude.
  //   The full 128-bin FFT snapshot creates unique angular fingerprints.
  _buildRadial(a, p) {
    const react = p.reactivity;
    const fft   = a.fftSnapshot || new Float32Array(128);
    const rings = Math.min(MAX_LINES, Math.round(p.layers));
    const pool  = this._linesGroup.children;
    const PTS   = 512;  // angular resolution per ring

    // Band energy for each ring (map frequency ranges to ring index)
    const bandEnergy = (ringIdx, total) => {
      const lo = Math.floor((ringIdx / total) * 128);
      const hi = Math.floor(((ringIdx + 1) / total) * 128);
      let s = 0;
      for (let k = lo; k < hi; k++) s += fft[k];
      return s / Math.max(1, hi - lo);
    };

    for (let ri = 0; ri < MAX_LINES; ri++) {
      const line = pool[ri];
      if (ri >= rings) { line.visible = false; continue; }
      line.visible = true;

      const tR    = ri / rings;
      const energy = bandEnergy(ri, rings);

      // Base radius grows outward; scale and volume stretch it
      const baseR  = (0.25 + tR * 0.8) * p.scale * (0.8 + a.volume * react * 0.4);
      // Phase: dominant frequency rotates the angular pattern per ring
      const phase  = a.dominantFreq * Math.PI * 6 * (ri + 1) + tR * p.twist * Math.PI * 2;
      // How many lobes: pitch determines angular frequency of the modulation
      const lobes  = 2 + Math.round(a.dominantFreq * react * 12) + ri;

      const arr = line.geometry.getAttribute('position').array;

      for (let i = 0; i <= PTS; i++) {
        const θ = (i / PTS) * Math.PI * 2;

        // Primary lobe modulation from the dominant pitch
        const mod1 = Math.sin(lobes * θ + phase) * energy * react * 0.25;
        // Secondary harmonic from spectral centroid (adds complexity/texture)
        const mod2 = Math.sin((lobes * 2) * θ + phase * 1.37) * energy * a.spectralCentroid * react * 0.1;
        // Per-frequency-bin modulation (the actual FFT fingerprint)
        const binIdx = Math.floor((θ / (Math.PI * 2)) * 128);
        const mod3 = fft[binIdx] * react * 0.15;

        const r = Math.max(0.05, baseR + mod1 + mod2 + mod3);

        arr[i * 3    ] = Math.cos(θ) * r;
        arr[i * 3 + 1] = Math.sin(θ) * r;
        // 3D: bass rings dip into Z, treble rings rise
        arr[i * 3 + 2] = Math.sin(lobes * θ * 0.5 + phase) * energy * 0.12 * p.scale * (tR - 0.5);
      }
      line.geometry.getAttribute('position').needsUpdate = true;
      line.geometry.setDrawRange(0, PTS + 1);

      // Colour: inner rings warm, outer rings cool; energy drives brightness
      const c = _ringColor(tR, a, p, energy);
      line.material.color.set(c);
      line.material.opacity = Math.min(1, Math.max(0.3, (0.4 + energy * p.brightness * 0.8)));
    }
  }
}

// ── Color helpers ─────────────────────────────────────────────────
function _ringColor(tR, a, p, energy) {
  if (p.autoColor) {
    // Inner rings: warm (orange/red); outer rings: cool (blue/purple)
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
