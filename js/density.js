// GPU density pipeline: additive gaussian splats into a float target,
// then log-density tonemap through a palette LUT. Global THREE (r134).

const SPLAT_VERT = `
attribute float attrv;
attribute float aWeight;
varying float vAttr;
varying float vW;
uniform float uSize;
uniform float uTime, uFreq, uAmp;
uniform vec3 uDir;
void main() {
  vec3 p = position;
  float s = uAmp * sin(uFreq * dot(p, uDir) + 6.28318530718 * uTime);
  p += (p / max(length(p), 1e-6)) * s;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize / max(0.1, -mv.z);
  vAttr = attrv;
  vW = aWeight;
}`;

const SPLAT_FRAG = `
precision highp float;
varying float vAttr;
varying float vW;
uniform float uWeight;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard;
  float w = exp(-r2 * 10.0) * uWeight * vW;
  gl_FragColor = vec4(w, w * vAttr, 0.0, 1.0);
}`;

const TONE_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDensity;
uniform sampler2D tLUT;
uniform float uExposure, uContrast, uPeak, uTransparent;
uniform vec3 uBackground;
uniform float uWater, uShine, uRipple, uCaustic, uPool;
uniform vec2 uTexel;

float toneAt(float d) {
  float t = log(1.0 + d * uExposure) / log(1.0 + max(uPeak, 1.0) * uExposure);
  return pow(clamp(t, 0.0, 1.0), uContrast);
}

// Height field reconstruction. attrv is splatted density-weighted into green,
// so g/r is the MEAN attribute of the points landing in a pixel — for the
// water style that attribute is the signed surface height remapped to 0..1.
//
// A SINGLE pixel is far too noisy to use. At production density only a
// handful of points land per pixel, so the per-pixel mean of a value spanning
// [-1,1] has enormous variance; feeding that straight into shading speckles
// the whole surface. Every height below is therefore pooled over a block,
// and pooled by summing g and r separately BEFORE dividing — averaging
// per-pixel ratios would let a nearly-empty pixel count as much as a full
// one, and would drag empty pixels in as false zeroes.
float hOf(float g, float r) {
  return r < 1e-4 ? 0.0 : (g / r - 0.5) * 2.0;
}

void main() {
  vec4 s = texture2D(tDensity, vUv);
  float t = toneAt(s.r);
  float attr = s.g / max(s.r, 1e-5);

  if (uWater < 0.5) {
    vec3 col = texture2D(tLUT, vec2(clamp(t * 0.88 + attr * 0.12, 0.0, 1.0), 0.5)).rgb;
    float cov = smoothstep(0.0, 0.08, t) * min(t * 1.4 + 0.25, 1.0);
    gl_FragColor = mix(vec4(mix(uBackground, col, cov), 1.0), vec4(col, cov), uTransparent);
    return;
  }

  // ---- water ----
  // Tap distance is held constant in UV above ~1000px so the surface reads the
  // same on screen and in a hi-res export; below that it floors to a texel.
  vec2 tap = max(uTexel * 1.5, vec2(0.0015)) * uPool;

  // One 5x5 grid, reused for every height estimate below. Sampling separate
  // neighbourhoods per term would cost 3-5x this for no extra information.
  float gA = 0.0, rA = 0.0;   // whole 5x5  — the surface height here
  float gI = 0.0, rI = 0.0;   // inner 3x3  — fine scale, for the Laplacian
  float gL = 0.0, rL = 0.0, gR = 0.0, rR = 0.0;
  float gD = 0.0, rD = 0.0, gU = 0.0, rU = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec4 sm = texture2D(tDensity, vUv + vec2(float(i), float(j)) * tap);
      gA += sm.g; rA += sm.r;
      if (i <= -1) { gL += sm.g; rL += sm.r; }
      if (i >=  1) { gR += sm.g; rR += sm.r; }
      if (j <= -1) { gD += sm.g; rD += sm.r; }
      if (j >=  1) { gU += sm.g; rU += sm.r; }
      if (i > -2 && i < 2 && j > -2 && j < 2) { gI += sm.g; rI += sm.r; }
    }
  }
  float hL = hOf(gL, rL), hR = hOf(gR, rR);
  float hD = hOf(gD, rD), hU = hOf(gU, rU);

  // DARK-FIELD MODEL. A cymascope dish is lit from around its rim, so the
  // camera sees light only where the surface is tilted enough to redirect a
  // beam into it — the steep WALLS between cells. Everything flat stays
  // black. That is why the reference photographs are mostly void with thin
  // bright curves through them, and it is why brightness here comes from
  // surface SLOPE and not from point density: a density-driven body term
  // fills the whole disc with mid-tone and destroys the voids.
  vec2 grad = vec2(hR - hL, hU - hD);
  float slope = length(grad) * uRipple * 9.0;

  // Walls: a narrow band at a particular slope. Because it selects an angle
  // rather than a direction, it lights every cell wall all the way around
  // instead of only the side facing a lamp — the closed bright loops in the
  // references. The width is the main lever on how much of the disc lights
  // up; too wide and the whole surface saturates into a bright blob.
  float band = exp(-pow((slope - 0.75) / 0.20, 2.0));

  // Broad relief underneath, so the form still reads where slopes are gentle.
  // Kept low deliberately: this term is the one that lifts the voids off
  // black, and the references live or die on how black their voids are.
  float relief = slope / (1.0 + slope);

  // Convergence: crests focus light. Difference of means at two scales
  // (outer halves vs inner 3x3) — a band-pass that behaves like a Laplacian
  // but inherits the pooling, where a raw second derivative would be almost
  // pure sampling noise. Sign matters: INNER above OUTER is a crest, and a
  // crest is the converging lens. Inverting this lights the troughs.
  float caustic = pow(max(0.0, (hOf(gI, rI) - (hL + hR + hD + hU) * 0.25)) * 8.0, 1.5);

  float lum = band * 1.0 * uShine
            + relief * 0.10
            + caustic * 0.8 * uCaustic;
  // Gamma deepens the voids without touching the peaks — the difference
  // between "lit surface" and the reference photographs' dark field.
  lum = pow(clamp(lum, 0.0, 1.0), 1.35);

  // Colour through the palette LUT by luminance, so flat water lands on the
  // ramp's dark end (a true void) and the walls on its bright end. This keeps
  // the palette picker meaningful instead of hardcoding a water colour.
  vec3 col = texture2D(tLUT, vec2(clamp(lum, 0.0, 1.0), 0.5)).rgb;

  // Coverage from PRESENCE, not brightness — deriving it from tone would
  // punch the dark troughs transparent. It must also come from POOLED
  // density: at production density many pixels inside the disc catch no point
  // at all, and a per-pixel test drops every one of them to the background,
  // peppering the surface with holes. A surface has no holes.
  float cov = smoothstep(0.0, 0.02, toneAt(rA / 25.0));
  gl_FragColor = mix(vec4(mix(uBackground, col, cov), 1.0), vec4(col, cov), uTransparent);
}`;

const TONE_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// ── Liquid: cymatic water ───────────────────────────────────────────────
//
// One analytic fullscreen pass. There is no point cloud and no circle SDF —
// the geometry is a modal standing-wave field, and the water is a thickness
// field that pools along its nodal lines.
//
// ⚠ psi() and waterAt() MIRROR js/cymafield.js exactly. The CPU copy drives
// the vector export; if the two drift, the exported outline stops matching
// the screen. Change them together.
const CYMA_FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uM, uN, uKr, uMa, uMix, uAmp, uFine, uChaos, uPhase;
uniform float uTimeC, uRipAmt, uRipT;
// Material time is DELIBERATELY separate from uTimeC. Geometry time moves
// the cymatic figure itself; material time moves only light on the water.
// Live Hold freezes the first and keeps the second, which is what lets a
// held design shimmer without its topology drifting.
uniform float uMatTime;
uniform float uAspect, uZoom, uGloss, uDispersion, uFlat, uTransparentB;
uniform vec2 uPan;
uniform vec3 uGround, uInk, uDeep;

const float PI = 3.14159265359;

float psi(vec2 p) {
  vec2 uv = p * 0.5 + 0.5;
  float sq = cos(uM * PI * uv.x) * cos(uN * PI * uv.y)
           - cos(uN * PI * uv.x) * cos(uM * PI * uv.y);

  float r = length(p);
  float th = atan(p.y, p.x);
  // Periodic in theta: cos(uMa*th) is only periodic for integer uMa, and a
  // non-integer order draws a hard seam along the atan branch cut. Blending
  // the two neighbouring integer orders keeps it both smooth and seamless.
  float m0 = floor(uMa), fm = uMa - m0;
  float ang = cos(m0 * th + uPhase) * (1.0 - fm) + cos((m0 + 1.0) * th + uPhase) * fm;
  float rad = cos(uKr * r - uMa * PI * 0.5 - PI * 0.25)
            / sqrt(1.0 + uKr * r * 0.6) * ang;

  float f = sq * (1.0 - uMix) + rad * uMix * 1.7;

  f += uFine * 0.30 * cos(uM * 2.7 * PI * uv.x + uTimeC * 0.21)
                    * cos(uN * 2.7 * PI * uv.y - uTimeC * 0.17);

  f += uChaos * 0.45 * (cos((uM + 1.7) * PI * uv.x) * cos((uN + 0.6) * PI * uv.y)
                      - cos((uN + 0.6) * PI * uv.x) * cos((uM + 1.7) * PI * uv.y));

  f += uRipAmt * sin(14.0 * r - uRipT * 9.0) * exp(-uRipT * 1.6) * exp(-r * 0.7);

  return f * (0.88 + 0.12 * sin(uTimeC * 0.9));
}

float nodalAt(vec2 p) {
  float f = abs(psi(p));
  float band = 0.05 + 0.34 * uAmp;
  float T = 1.0 - smoothstep(band * 0.30, band, f);
  return T * (1.0 - smoothstep(1.02, 1.30, length(p)));
}

float hash2(vec2 c) { return fract(sin(c.x * 127.1 + c.y * 311.7) * 43758.5453); }

// Idle pools: jittered centres with per-cell radii, so they never read as a
// repeated grid of circles — the exact failure of the old model.
float dropsAt(vec2 p) {
  float scale = 2.6;
  vec2 g = p * scale;
  vec2 i0 = floor(g);
  float best = 0.0;
  for (int dj = -1; dj <= 1; dj++) {
    for (int di = -1; di <= 1; di++) {
      vec2 c = i0 + vec2(float(di), float(dj));
      float h = hash2(c), h2 = hash2(c + vec2(37.1, -11.7));
      if (h > 0.62) {
        vec2 ctr = c + vec2(0.15 + 0.7 * h, 0.15 + 0.7 * h2);
        float rad = 0.16 + 0.30 * h2;
        // Rounded, slightly elongated puddles — per-drop rotation and aspect,
        // not angular harmonics, which turned every droplet into a starfish.
        float rot = h * 6.2831853;
        vec2 dv = g - ctr;
        vec2 q = vec2((dv.x * cos(rot) + dv.y * sin(rot)) / (0.66 + 0.7 * h2),
                      -dv.x * sin(rot) + dv.y * cos(rot));
        float a = atan(q.y, q.x);
        float rr = rad * (1.0 + 0.10 * sin(a * 2.0 + h * 21.0) + 0.05 * sin(a * 3.0 - h2 * 17.0));
        best = max(best, 1.0 - smoothstep(rr * 0.45, rr, length(q)));
      }
    }
  }
  return best * 0.7 * (1.0 - smoothstep(1.02, 1.30, length(p)));
}

float waterAt(vec2 p) {
  float gth = smoothstep(0.04, 0.34, uAmp);
  return clamp(nodalAt(p) * gth + dropsAt(p) * (1.0 - gth), 0.0, 1.0);
}

void main() {
  vec2 p = (vUv - 0.5 - uPan) * vec2(uAspect, 1.0) * 3.15 / uZoom;

  float T = waterAt(p);
  float px = 1.6 / (uZoom * 420.0);

  if (uFlat > 0.5) {
    float m = smoothstep(0.45, 0.55, T);
    gl_FragColor = mix(vec4(mix(uGround, uInk, m), 1.0), vec4(uInk, m), uTransparentB);
    return;
  }

  // Surface normal from the THICKNESS gradient. Thickness — not a signed
  // distance — is what a liquid surface actually is, so this is where the
  // refraction, specular and caustics all come from.
  vec2 e = vec2(px, 0.0);
  vec2 grad = vec2(waterAt(p + e.xy) - waterAt(p - e.xy),
                   waterAt(p + e.yx) - waterAt(p - e.yx));

  // Shimmer perturbs the LIGHTING normal only — never the thickness T. The
  // silhouette, the coverage mask and therefore the vector export stay
  // bit-identical while the surface is moving, so a held design cannot drift
  // its topology no matter how long it shimmers.
  vec2 shim = vec2(sin(p.x * 3.1 + uMatTime * 0.70) * cos(p.y * 2.6 - uMatTime * 0.50),
                   cos(p.x * 2.4 - uMatTime * 0.62) * sin(p.y * 3.3 + uMatTime * 0.81))
            * 0.055 * smoothstep(0.05, 0.5, T);
  vec3 N = normalize(vec3(-(grad.x * 26.0 + shim.x), 1.0, -(grad.y * 26.0 + shim.y)));

  // A faint structured backdrop. Refraction is invisible against a flat
  // colour — there has to be something behind the water for it to bend.
  vec2 ruv = vUv + N.xz * T * 0.055 * (1.0 + uDispersion * 0.4);
  float bandY = 0.5 + 0.5 * sin(ruv.y * 11.0 + ruv.x * 3.0);
  float vign = 1.0 - 0.35 * length(vUv - 0.5);
  vec3 back = uGround * (vign - 0.035 + 0.05 * bandY);
  vec3 backPlain = uGround * (1.0 - 0.35 * length(vUv - 0.5));

  // Caustics: converging surface focuses light. Second difference of
  // thickness, which the gradient taps have already paid for.
  float lap = waterAt(p + e.xy) + waterAt(p - e.xy)
            + waterAt(p + e.yx) + waterAt(p - e.yx) - 4.0 * T;
  float caustic = clamp(-lap * 9.0, 0.0, 1.0)
                * (0.82 + 0.18 * sin(uMatTime * 1.25 + p.x * 4.0 + p.y * 3.1));

  // Depth tint — thicker water is bluer and darker, which is most of what
  // makes it read as a real liquid layer rather than a decal.
  vec3 body = mix(back, uDeep, clamp(T * 0.55, 0.0, 1.0));
  body += caustic * 0.28 * uGloss;

  // Contact darkening: a soft shadow offset beneath thicker water.
  float shade = waterAt(p + vec2(px * 5.0, -px * 5.0));
  body *= 1.0 - 0.22 * clamp(shade - T, 0.0, 1.0) * 4.0;

  vec3 L = normalize(vec3(-0.45, 0.80, 0.40));
  vec3 V = vec3(0.0, 1.0, 0.0);
  vec3 H = normalize(L + V);
  float spec = pow(max(0.0, dot(N, H)), 34.0);
  float fres = pow(1.0 - max(0.0, dot(N, V)), 4.0);

  // Dispersion only where the surface actually bends hard.
  // Gated by thickness as well as curvature: a small droplet has a huge
  // gradient, so curvature alone ringed every one of them in rainbow —
  // the 'rainbow outline around every edge' the brief rules out.
  float curv = clamp(length(grad) * 9.0, 0.0, 1.0) * smoothstep(0.15, 0.6, T);
  float a = atan(grad.y, grad.x) * 2.0;
  vec3 iri = vec3(sin(a), sin(a + 2.094), sin(a + 4.188)) * 0.5 + 0.5;

  vec3 col = body
           + vec3(1.0) * spec * 0.85 * uGloss
           + vec3(1.0) * fres * 0.16 * uGloss
           + (iri - 0.5) * curv * fres * uDispersion * 0.34;

  float cov = smoothstep(0.02, 0.14, T);
  col = mix(backPlain, col, cov);
  gl_FragColor = mix(vec4(col, 1.0), vec4(col, cov), uTransparentB);
}`;

export class DensityRenderer {
  constructor(container) {
    this.container = container;
    this.fallback = false;
    this._dirty = true;
    this._rotY = 0; this._rotX = -0.2; this._zoom = 1;
    this._params = { exposure: 30, contrast: 1.0, grain: 1.0, background: [0.012, 0.016, 0.04], scale: 1, autoRotate: 0.3,
                     water: 0, shine: 1.0, ripple: 1.0, caustic: 1.0 };
    this._playing = false;
    this._loopPeriod = 8;
    this._motion = null;
    this._lastTick = 0;
    this._frameSink = null;
    this._initGL();
    this._initDrag();
    this._loop();
  }

  _size() {
    return [this.container.clientWidth || 800, this.container.clientHeight || 600];
  }

  // Per-cloud splat material. Copies current uniform values (size, motion,
  // phase) so a crossfade's incoming cloud moves in step with the outgoing.
  _makeSplatMat() {
    const src = this.splatMat ? this.splatMat.uniforms : null;
    return new THREE.ShaderMaterial({
      vertexShader: SPLAT_VERT, fragmentShader: SPLAT_FRAG,
      uniforms: {
        uSize: { value: src ? src.uSize.value : 3.0 },
        uTime: { value: src ? src.uTime.value : 0 },
        uFreq: { value: src ? src.uFreq.value : 5 },
        uAmp:  { value: src ? src.uAmp.value : 0 },
        uDir:  { value: src ? src.uDir.value.clone() : new THREE.Vector3(0, 1, 0) },
        uWeight: { value: 1 },
      },
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });
  }

  _splatMats() {
    return this._fading ? [this.splatMat, this._fading.mat] : [this.splatMat];
  }

  // Shared all-ones aWeight buffer (grown lazily) so non-grow clouds render
  // exactly as before the attribute existed.
  _unitWeights(n) {
    if (!this._unit || this._unit.length < n) this._unit = new Float32Array(n).fill(1);
    return this._unit.subarray(0, n);
  }

  _initGL() {
    const [w, h] = this._size();
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 50);
    this.camera.position.z = 3.2;
    this.scene = new THREE.Scene();
    this.group = new THREE.Group();
    this.scene.add(this.group);

    // Capability probe: THREE r134 doesn't throw when a float render target is
    // unsupported — it just renders broken. Check the extensions ourselves
    // before attempting to create the target, keeping the try/catch as a
    // second net for anything the probe misses.
    const gl = this.renderer.getContext();
    const hasFloatSupport = this.renderer.capabilities.isWebGL2
      ? !!gl.getExtension('EXT_color_buffer_float')
      : !!(gl.getExtension('OES_texture_half_float') && gl.getExtension('EXT_color_buffer_half_float'));

    if (!hasFloatSupport) {
      this.fallback = true;
    } else {
      try {
        this.target = this._makeTarget(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio(), THREE.HalfFloatType);
        this.renderer.setRenderTarget(this.target);
        this.renderer.setRenderTarget(null);
      } catch (e) {
        this.fallback = true;
      }
    }

    this.splatMat = this._makeSplatMat();

    this.lutTex = new THREE.DataTexture(new Uint8Array(256 * 4).fill(255), 256, 1, THREE.RGBAFormat);
    this.lutTex.needsUpdate = true;

    this.toneScene = new THREE.Scene();
    this.toneCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.toneMat = new THREE.ShaderMaterial({
      vertexShader: TONE_VERT, fragmentShader: TONE_FRAG,
      uniforms: {
        tDensity: { value: this.target ? this.target.texture : null },
        tLUT: { value: this.lutTex },
        uExposure: { value: 30 }, uContrast: { value: 1.0 }, uPeak: { value: 60 },
        uTransparent: { value: 0 },
        uBackground: { value: new THREE.Vector3(0.012, 0.016, 0.04) },
        uWater: { value: 0 }, uShine: { value: 1.0 }, uRipple: { value: 1.0 },
        // Plain Float32Array, not THREE.Vector2: three.js binds length-2
        // arrays via uniform2fv just the same, and it keeps this constructor
        // runnable under the minimal THREE stub the node tests use.
        uCaustic: { value: 1.0 }, uPool: { value: 1.0 },
        uTexel: { value: new Float32Array([1 / 1024, 1 / 1024]) },
      },
    });
    this.toneScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.toneMat));

    // Liquid mode's own fullscreen pass. Built once and left idle until a
    // field state is set; `this.blob` null means every other mode behaves
    // exactly as before, down to the render path taken.
    this.blob = null;
    this.blobMat = new THREE.ShaderMaterial({
      vertexShader: TONE_VERT, fragmentShader: CYMA_FRAG,
      // Flat typed arrays rather than THREE.Vector3: three.js binds them
      // identically, and it keeps this constructor runnable under the minimal
      // THREE stub the node tests use.
      uniforms: {
        uM: { value: 3 }, uN: { value: 2 }, uKr: { value: 7 }, uMa: { value: 3 },
        uMix: { value: 0.5 }, uAmp: { value: 0 }, uFine: { value: 0 },
        uChaos: { value: 0 }, uPhase: { value: 0 },
        uTimeC: { value: 0 }, uRipAmt: { value: 0 }, uRipT: { value: 9 },
        uMatTime: { value: 0 },
        uAspect: { value: 1 }, uZoom: { value: 1 },
        uPan: { value: new Float32Array([0, 0]) },
        uGloss: { value: 1 }, uDispersion: { value: 1 },
        uFlat: { value: 0 }, uTransparentB: { value: 0 },
        uGround: { value: new Float32Array([0.72, 0.76, 0.80]) },
        uInk: { value: new Float32Array([0.10, 0.13, 0.17]) },
        uDeep: { value: new Float32Array([0.52, 0.62, 0.72]) },
      },
    });
    this.blobScene = new THREE.Scene();
    this.blobScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blobMat));

    window.addEventListener('resize', () => this._onResize());
  }

  _makeTarget(w, h, type) {
    return new THREE.WebGLRenderTarget(Math.floor(w), Math.floor(h), {
      type, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false,
    });
  }

  _onResize() {
    const [w, h] = this._size();
    this._setAspect(w / h);
    this.camera.updateProjectionMatrix();
    this._applyViewOffset();
    this.renderer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    if (this.target) this.target.setSize(Math.floor(w * pr), Math.floor(h * pr));
    this._dirty = true;
  }

  // Shift the projection so the design centres in the region NOT covered by
  // floating chrome (right control panel / bottom sheet). Pure camera offset —
  // no distortion, canvas stays full-bleed for the glass blur.
  setViewInset(right = 0, bottom = 0) {
    this._insetR = right;
    this._insetB = bottom;
    this._applyViewOffset();
    this._dirty = true;
  }

  _setAspect(aspect) {
    if (this.camera.isOrthographicCamera) {
      const s = 1.325; // matches perspective framing: 3.2·tan(22.5°)
      this.camera.left = -s * aspect; this.camera.right = s * aspect;
      this.camera.top = s; this.camera.bottom = -s;
    } else {
      this.camera.aspect = aspect;
    }
  }

  // Flat (orthographic) vs depth (perspective) projection. Additive: 'depth'
  // rebuilds the exact constructor camera, so perspective output is unchanged.
  setProjection(mode) {
    const [w, h] = this._size();
    if (mode === 'flat') {
      const s = 1.325, aspect = w / h;
      this.camera = new THREE.OrthographicCamera(-s * aspect, s * aspect, s, -s, 0.01, 50);
    } else {
      this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 50);
    }
    this.camera.position.z = 3.2;
    this._projection = mode;
    this._applyViewOffset();
    this._dirty = true;
  }

  setOrientation(rx, ry) { this._rotX = rx; this._rotY = ry; this._dirty = true; }

  _applyViewOffset() {
    const [w, h] = this._size();
    const r = this._insetR || 0, b = this._insetB || 0;
    if (r > 0 || b > 0) {
      // With a view offset, aspect must match the VIRTUAL canvas or the
      // sub-view is squeezed.
      this._setAspect((w + r) / (h + b));
      this.camera.setViewOffset(w + r, h + b, r, b, w, h);
    } else {
      if (this.camera.view) this.camera.clearViewOffset();
      this._setAspect(w / h);
    }
    // A bottom inset magnifies vertically by (h+b)/h; pull the camera back to
    // compensate, plus a touch extra so the design sits comfortably above the
    // sheet rather than clipping its edges.
    this._insetZoomOut = b > 0 ? ((h + b) / h) * 1.12 : 1;
    this.camera.updateProjectionMatrix();
  }

  // Liquid mode. Passing null returns the renderer to the point-cloud path.
  //
  // The whole field state lives in uniforms and is re-evaluated per pixel per
  // frame, so morphing costs nothing: updating these is a handful of floats,
  // not a regeneration. That is what lets live input flow continuously
  // instead of crossfading between unrelated designs.
  // `anim` is the render state, not a style:
  //   'full'     — live and responding: geometry and material both advance
  //   'material' — live HOLD: geometry frozen, only light on the water moves
  //   'none'     — submitted recording: nothing advances, zero draw calls
  setField(state, anim = 'full') {
    if (!state) { this.blob = null; this._dirty = true; return; }
    const u = this.blobMat.uniforms;
    u.uM.value = state.m; u.uN.value = state.n;
    u.uKr.value = state.kr; u.uMa.value = state.ma;
    u.uMix.value = state.mix; u.uAmp.value = state.amp;
    u.uFine.value = state.fine; u.uChaos.value = state.chaos;
    u.uPhase.value = state.phase;
    u.uTimeC.value = state.t;
    u.uRipAmt.value = state.ripAmt; u.uRipT.value = state.ripT;
    this.blob = state;
    this.blobAnim = anim;
    this._dirty = true;
  }

  setBlobStyle({ flat, gloss, dispersion, ink, ground, deep } = {}) {
    const u = this.blobMat.uniforms;
    if (flat !== undefined) u.uFlat.value = flat ? 1 : 0;
    if (gloss !== undefined) u.uGloss.value = gloss;
    if (dispersion !== undefined) u.uDispersion.value = dispersion;
    if (ink) u.uInk.value.set(ink);
    if (ground) u.uGround.value.set(ground);
    if (deep) u.uDeep.value.set(deep);
    this._dirty = true;
  }

  setCloud(positions, attr) {
    this.blob = null;   // a point cloud and a blob are mutually exclusive
    this._disposeFading();
    this._setWaterPool(positions.length / 3);
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); }
    this._paintPos = null; this._paintAttr = null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('attrv', new THREE.BufferAttribute(attr, 1));
    geo.setAttribute('aWeight', new THREE.BufferAttribute(this._unitWeights(positions.length / 3), 1));
    if (this.fallback) {
      const mat = new THREE.PointsMaterial({ size: 0.008, color: 0xbbaaff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
      this.points = new THREE.Points(geo, mat);
    } else {
      this.points = new THREE.Points(geo, this.splatMat);
    }
    this.points.frustumCulled = false;
    this.group.add(this.points);
    // Peak estimate: average points per pixel in the covered region, ×concentration
    const n = positions.length / 3;
    const [w, h] = this._size();
    this.toneMat.uniforms.uPeak.value = Math.max(8, (n / (w * h)) * 550);
    this._dirty = true;
    this.splatMat.uniforms.uWeight.value = 1;
  }

  // Reveal only the first `frac` of the current cloud. The generator emits
  // points in trajectory order, so a fraction is a representative sample of
  // the whole attractor rather than a lopped-off region. Costs nothing — it is
  // a draw-range change, no upload — which is why loudness drives this instead
  // of the Density slider (that one sets GENERATION density and would force a
  // ~150ms regeneration per volume change).
  setVisibleFraction(frac) {
    if (!this.points || this._paintPos) return;   // paint mode owns its own range
    const total = this.points.geometry.getAttribute('position').count;
    const n = Math.min(total, Math.max(1, Math.round(total * Math.max(0, Math.min(1, frac)))));
    this.points.geometry.setDrawRange(0, n);
    const [w, h] = this._size();
    this.toneMat.uniforms.uPeak.value = Math.max(8, (n / (w * h)) * 550);
    this._visibleFraction = frac;
    this._dirty = true;
  }

  // ── Paint mode: one preallocated buffer painted incrementally ──
  // beginPaint allocates; writePaintPoints copies chunks in (streaming brush
  // appends AND remainder splices); setPaintCount reveals via drawRange.
  beginPaint(maxPoints) {
    this._disposeFading();
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); }
    this._paintPos = new Float32Array(maxPoints * 3);
    this._paintAttr = new Float32Array(maxPoints);
    const geo = new THREE.BufferGeometry();
    const posA = new THREE.BufferAttribute(this._paintPos, 3);
    const attrA = new THREE.BufferAttribute(this._paintAttr, 1);
    posA.setUsage(THREE.DynamicDrawUsage);
    attrA.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posA);
    geo.setAttribute('attrv', attrA);
    geo.setAttribute('aWeight', new THREE.BufferAttribute(this._unitWeights(maxPoints), 1));
    geo.setDrawRange(0, 0);
    if (this.fallback) {
      const mat = new THREE.PointsMaterial({ size: 0.008, color: 0xbbaaff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
      this.points = new THREE.Points(geo, mat);
    } else {
      this.points = new THREE.Points(geo, this.splatMat);
    }
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this._paintDirty = null;
    this._dirty = true;
    this.splatMat.uniforms.uWeight.value = 1;
  }

  writePaintPoints(offset, positions, attr) {
    if (!this._paintPos) return;
    this._paintPos.set(positions, offset * 3);
    this._paintAttr.set(attr, offset);
    const end = offset + attr.length;
    this._paintDirty = this._paintDirty
      ? { min: Math.min(this._paintDirty.min, offset), max: Math.max(this._paintDirty.max, end) }
      : { min: offset, max: end };
    const geo = this.points.geometry;
    const posA = geo.getAttribute('position');
    const attrA = geo.getAttribute('attrv');
    posA.updateRange = { offset: this._paintDirty.min * 3, count: (this._paintDirty.max - this._paintDirty.min) * 3 };
    attrA.updateRange = { offset: this._paintDirty.min, count: this._paintDirty.max - this._paintDirty.min };
    posA.needsUpdate = true;
    attrA.needsUpdate = true;
    this._dirty = true;
  }

  setPaintCount(n) {
    if (!this.points) return;
    this.points.geometry.setDrawRange(0, n);
    const [w, h] = this._size();
    this.toneMat.uniforms.uPeak.value = Math.max(8, (n / (w * h)) * 550);
    this._paintDirty = null; // consumed by the upcoming render
    this._dirty = true;
  }

  // Painted region as standalone copies (freeze/capture).
  getPaintSlice(n) {
    return {
      positions: this._paintPos ? this._paintPos.slice(0, n * 3) : new Float32Array(0),
      attr: this._paintAttr ? this._paintAttr.slice(0, n) : new Float32Array(0),
    };
  }

  setPalette(lutBytes) {
    this.lutTex.image.data.set(lutBytes);
    this.lutTex.needsUpdate = true;
    this._dirty = true;
  }

  // Water's height field is a MEAN over the points landing in each pooling
  // block, so its noise falls as 1/sqrt(points per pixel). Live mode runs at
  // 250k against the capture path's 1.5M — 6x sparser, which is exactly the
  // graininess seen there — so the pooling radius scales as sqrt(density
  // ratio) to hold noise roughly constant. Derived from the cloud the
  // renderer is actually holding rather than plumbed through main.js, so the
  // live, capture and paint paths all get it without knowing about it.
  _setWaterPool(count) {
    const REF = 1500000;
    const k = Math.sqrt(REF / Math.max(1, count));
    this._waterPool = Math.min(2.6, Math.max(1, k));
    this.toneMat.uniforms.uPool.value = this._waterPool;
    this._applySplatSize();
    this._dirty = true;
  }

  // Splats are SUB-PIXEL by default (gl_PointSize = 3.0 / 3.2 ~= 0.94px), so
  // each point writes about one texel. The glow styles are built for that —
  // they are summing sparse energy. Water is not: it reconstructs a
  // CONTINUOUS surface, and a surface cannot be rebuilt from texels that are
  // mostly empty. Widening the pooling does not fix it either, because every
  // tap still reads a single texel — spreading taps apart just samples a
  // sparser lattice. The points themselves have to cover area, so water
  // enlarges the splat, and enlarges it further as the cloud gets sparser.
  _applySplatSize() {
    const water = this._params.water > 0.5 ? 2.0 * (this._waterPool || 1) : 1;
    for (const m of this._splatMats()) {
      m.uniforms.uSize.value = 3.0 * this._params.grain * water;
    }
  }

  setParams(p) {
    Object.assign(this._params, p);
    this.toneMat.uniforms.uExposure.value = this._params.exposure;
    this.toneMat.uniforms.uContrast.value = this._params.contrast;
    const bg = this._params.background;
    this.toneMat.uniforms.uBackground.value.set(bg[0], bg[1], bg[2]);
    this._applySplatSize();
    this.group.scale.setScalar(this._params.scale);
    // Water keys survive live.js's partial per-frame setParams (which sends
    // only exposure/scale/grain/autoRotate) because Object.assign merges.
    this.toneMat.uniforms.uWater.value = this._params.water;
    this.toneMat.uniforms.uShine.value = this._params.shine;
    this.toneMat.uniforms.uRipple.value = this._params.ripple;
    this.toneMat.uniforms.uCaustic.value = this._params.caustic;
    this._dirty = true;
  }

  clear() {
    this._disposeFading();
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); this.points = null; }
    this._paintPos = null; this._paintAttr = null;
    // Liquid draws from this.blob, not from this.points — leaving it set here
    // means Clear empties the cloud and the blob stays on screen regardless.
    this.blob = null;
    this._dirty = true;
  }

  // ── Motion (seamless loop) — displacement mirrors js/motion.js ──
  setMotion(mp) {
    this._motion = mp;
    for (const m of this._splatMats()) {
      m.uniforms.uDir.value.set(mp.dir[0], mp.dir[1], mp.dir[2]);
      m.uniforms.uFreq.value = mp.freq;
      if (m.uniforms.uAmp.value > 0) m.uniforms.uAmp.value = mp.amp;
    }
    this._dirty = true;
  }
  activateMotion() {
    if (this._motion) {
      for (const m of this._splatMats()) m.uniforms.uAmp.value = this._motion.amp;
    }
    this._dirty = true;
  }
  setPlaying(on) {
    this._playing = !!on;
    if (on) this.activateMotion();
    this._dirty = true;
  }
  setLoopPeriod(sec) { this._loopPeriod = Math.max(1, sec); }
  setFrameSink(cb) { this._frameSink = cb; }
  get canvas() { return this.renderer.domElement; }
  setLoopPhase(t) {
    const v = t - Math.floor(t);
    for (const m of this._splatMats()) m.uniforms.uTime.value = v;
    this._dirty = true;
  }
  getLoopPhase() { return this.splatMat.uniforms.uTime.value; }
  getActiveMotion() { return this.splatMat.uniforms.uAmp.value > 0 ? this._motion : null; }

  // Live drive: direct wave amplitude/frequency, bypassing motionParams.
  setWave(amp, freq) {
    for (const m of this._splatMats()) {
      m.uniforms.uAmp.value = amp;
      m.uniforms.uFreq.value = freq;
    }
    this._dirty = true;
  }

  // Dissolve the current cloud into a new one over dur seconds.
  crossfadeTo(positions, attr, dur = 1.0) {
    if (!this.points || this.fallback) { this.setCloud(positions, attr); return; }
    this._disposeFading();                       // a still-running fade completes instantly
    this._paintPos = null; this._paintAttr = null;  // a crossfaded cloud is not a paint buffer
    this._fading = { points: this.points, mat: this.points.material, t: 0, dur };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('attrv', new THREE.BufferAttribute(attr, 1));
    geo.setAttribute('aWeight', new THREE.BufferAttribute(this._unitWeights(positions.length / 3), 1));
    const mat = this._makeSplatMat();
    mat.uniforms.uWeight.value = 0;
    this.splatMat = mat;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    // The new cloud must open at the SAME visible fraction as the one it is
    // replacing — otherwise the draw range defaults to the full buffer (a
    // volume jump the instant the fade starts) and uPeak is estimated from
    // the full count while the outgoing cloud's peak was estimated from its
    // visible count, so the fade lerps between two differently-scaled
    // estimates (_loop's fade branch overwrites uPeak every frame between
    // them) and _disposeFading then snaps to the mismatched value — together
    // a brightness ripple every crossfade whenever visibleFraction < 1.
    const total = positions.length / 3;
    const frac = Math.max(0, Math.min(1, this._visibleFraction ?? 1));
    const n = Math.min(total, Math.max(1, Math.round(total * frac)));
    geo.setDrawRange(0, n);
    this._peakFrom = this.toneMat.uniforms.uPeak.value;
    const [w, h] = this._size();
    this._peakTo = Math.max(8, (n / (w * h)) * 550);
    this._dirty = true;
  }

  _disposeFading() {
    if (!this._fading) return;
    this.group.remove(this._fading.points);
    this._fading.points.geometry.dispose();
    this._fading.mat.dispose();
    this._fading = null;
    if (this.points) this.points.material.uniforms.uWeight.value = 1;
    if (this._peakTo !== undefined) this.toneMat.uniforms.uPeak.value = this._peakTo;
  }

  requestRender() { this._dirty = true; }

  getMVP() {
    // Exports must be centred: compute the matrix with the chrome view-offset
    // cleared, then restore it for on-screen rendering.
    const hadOffset = !!(this.camera.view && this.camera.view.enabled);
    if (hadOffset) {
      this.camera.clearViewOffset();
      const [vw, vh] = this._size();
      this._setAspect(vw / vh);
      this.camera.updateProjectionMatrix();
    }
    this.group.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const mvp = new THREE.Matrix4()
      .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      .multiply(this.group.matrixWorld);
    if (hadOffset) this._applyViewOffset();
    return mvp;
  }

  _renderFrame(target = null) {
    // Liquid: one analytic fullscreen pass, no splat accumulation and no
    // tonemap. Sits ahead of everything else so the point-cloud path below is
    // reached only when there is genuinely a cloud to draw.
    if (this.blob) {
      const [w, h] = this._size();
      const u = this.blobMat.uniforms;
      u.uAspect.value = w / h;
      u.uZoom.value = this._zoom / (this._insetZoomOut || 1);
      // Centre the figure in the region NOT covered by the floating chrome,
      // the same job _applyViewOffset does for the point-cloud camera. This
      // pass bypasses that camera entirely, so it has to shift its own UVs or
      // the design sits centred behind the control panel.
      const pan = u.uPan.value;
      pan[0] = -((this._insetR || 0) / 2) / w;
      pan[1] = ((this._insetB || 0) / 2) / h;
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.blobScene, this.toneCam);
      this.renderer.setRenderTarget(null);
      return;
    }
    if (this.camera.isOrthographicCamera) {
      // Ortho scale comes from the frustum, not distance: map zoom to camera.zoom.
      this.camera.zoom = this._zoom / (this._insetZoomOut || 1);
      this.camera.updateProjectionMatrix();
      this.camera.position.z = 3.2;
    } else {
      this.camera.position.z = (3.2 / this._zoom) * (this._insetZoomOut || 1);
    }
    this.group.rotation.set(this._rotX, this._rotY, 0);
    if (this.fallback || !this.points) {
      this.renderer.setClearColor(new THREE.Color(...this._params.background), 1);
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      return;
    }
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    // Set here, not at resize: renderHiRes swaps this.target before calling
    // us, so this is the one site that is correct for both paths.
    const tw = this.target.width || 1024, th = this.target.height || 1024;
    const texel = this.toneMat.uniforms.uTexel.value;
    texel[0] = 1 / tw; texel[1] = 1 / th;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.toneScene, this.toneCam);
    this.renderer.setRenderTarget(null);
  }

  _loop() {
    requestAnimationFrame(() => this._loop());
    // Liquid animates continuously — a standing wave that stopped moving
    // would read as a still image. The renderer owns this clock so the water
    // keeps breathing (and a transient keeps decaying) even when no audio is
    // arriving, which is what makes the idle state look like resting liquid
    // rather than a frozen frame.
    if (this.blob && this.blobAnim !== 'none') {
      const nowB = performance.now() / 1000;
      const dtB = Math.min(0.1, this._blobTick ? nowB - this._blobTick : 0.016);
      this._blobTick = nowB;
      const u = this.blobMat.uniforms;

      // Material time always runs while animating: this is the shimmer, and
      // it is the only thing that moves during Hold.
      this._matTime = (this._matTime || 0) + dtB;
      u.uMatTime.value = this._matTime;

      if (this.blobAnim === 'full') {
        // Geometry time: breathing and the fine-detail drift. Frozen in Hold
        // so a held figure cannot change shape on its own.
        this.blob.t += dtB;
        this.blob.phase += dtB * 0.15;
        u.uTimeC.value = this.blob.t;
        u.uPhase.value = this.blob.phase;
      }
      // A transient keeps settling even in Hold — "the pattern relaxes
      // gradually rather than vanishing instantly" — but it only ever decays.
      this.blob.ripT += dtB;
      this.blob.ripAmt *= Math.exp(-dtB * 1.2);
      u.uRipT.value = this.blob.ripT;
      u.uRipAmt.value = this.blob.ripAmt;
      this._dirty = true;
    } else {
      // 'none' deliberately falls through here: no advance, no dirty flag, so
      // a submitted recording costs zero draw calls and is genuinely static.
      this._blobTick = 0;
    }
    if (this._params.autoRotate > 0 && this.points) {
      this._rotY += this._params.autoRotate * 0.004;
      this._dirty = true;
    }
    if (this._playing) {
      const now = performance.now() / 1000;
      const dt = Math.min(0.1, this._lastTick ? now - this._lastTick : 0);
      this._lastTick = now;
      this.setLoopPhase(this.splatMat.uniforms.uTime.value + dt / this._loopPeriod);
    } else {
      this._lastTick = 0;
    }
    if (this._fading) {
      const nowF = performance.now() / 1000;
      const dtF = Math.min(0.1, this._fadeTick ? nowF - this._fadeTick : 0.016);
      this._fadeTick = nowF;
      this._fading.t += dtF;
      const k = Math.min(1, this._fading.t / this._fading.dur);
      this._fading.mat.uniforms.uWeight.value = 1 - k;
      this.splatMat.uniforms.uWeight.value = k;
      this.toneMat.uniforms.uPeak.value = this._peakFrom + (this._peakTo - this._peakFrom) * k;
      this._dirty = true;
      if (k >= 1) this._disposeFading();
    } else {
      this._fadeTick = 0;
    }
    if (!this._dirty) return; // render-on-demand: idle = zero draw calls
    this._dirty = false;
    this._renderFrame();
    // Post-render hook (live video recording): the WebGL buffer is only
    // valid in the same task as the draw, so capture must happen here.
    if (this._frameSink) this._frameSink(performance.now());
  }

  // Hi-res export: render both passes into an offscreen RGBA8 target and read back.
  renderHiRes(scaleFactor = 3, { transparent = false } = {}) {
    this.exportNote = null;
    const [w, h] = this._size();
    const maxTex = this.renderer.capabilities.maxTextureSize || 8192;
    let W = Math.floor(w * scaleFactor), H = Math.floor(h * scaleFactor);
    if (Math.max(W, H) > maxTex) {
      const clamp = maxTex / Math.max(w, h);
      W = Math.floor(w * clamp); H = Math.floor(h * clamp);
      this.exportNote = `Requested size exceeds this GPU (max ${maxTex}px) — exported at ${Math.max(W, H)}px`;
    }
    // Exports are centred: drop the chrome view-offset for the export render.
    const hadOffset = !!(this.camera.view && this.camera.view.enabled);
    const savedInsetZoom = this._insetZoomOut;
    if (hadOffset) {
      this.camera.clearViewOffset();
      this._setAspect(w / h);
      this.camera.updateProjectionMatrix();
      this._insetZoomOut = 1;
    }
    let bigDensity = null, bigOut = null;
    for (;;) {
      try {
        bigDensity = this.fallback ? null : this._makeTarget(W, H, THREE.HalfFloatType);
        bigOut = this._makeTarget(W, H, THREE.UnsignedByteType);
        break;
      } catch (e) {
        if (bigDensity) { bigDensity.dispose(); bigDensity = null; }
        if (Math.max(W, H) <= 2000) throw e;
        W = Math.floor(W / 2); H = Math.floor(H / 2);
        this.exportNote = `High-res allocation failed — exported at ${Math.max(W, H)}px`;
      }
    }
    if (transparent && !this.fallback) this.toneMat.uniforms.uTransparent.value = 1;
    if (transparent && this.blob) this.blobMat.uniforms.uTransparentB.value = 1;
    const effScale = W / Math.max(1, w);
    const savedTarget = this.target;
    if (bigDensity) {
      this.target = bigDensity;
      this.toneMat.uniforms.tDensity.value = bigDensity.texture;
      // splat count per pixel drops with area → compensate peak
      const savedPeak = this.toneMat.uniforms.uPeak.value;
      this.toneMat.uniforms.uPeak.value = savedPeak / (effScale * effScale);
      const savedSize = this.splatMat.uniforms.uSize.value;
      for (const m of this._splatMats()) m.uniforms.uSize.value = savedSize * effScale;
      this._renderFrame(bigOut);
      this.toneMat.uniforms.uPeak.value = savedPeak;
      for (const m of this._splatMats()) m.uniforms.uSize.value = savedSize;
    } else {
      this._renderFrame(bigOut);
    }
    this.toneMat.uniforms.uTransparent.value = 0;
    this.blobMat.uniforms.uTransparentB.value = 0;
    const pixels = new Uint8Array(W * H * 4);
    this.renderer.readRenderTargetPixels(bigOut, 0, 0, W, H, pixels);
    this.target = savedTarget;
    if (this.target) this.toneMat.uniforms.tDensity.value = this.target.texture;
    if (bigDensity) bigDensity.dispose();
    bigOut.dispose();
    if (hadOffset) { this._insetZoomOut = savedInsetZoom; this._applyViewOffset(); }
    // Flip Y into a 2D canvas
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      img.data.set(pixels.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    }
    ctx.putImageData(img, 0, 0);
    this._dirty = true;
    return canvas;
  }

  _initDrag() {
    const el = this.renderer.domElement;
    let down = false, ox = 0, oy = 0, pinch0 = 0;
    const start = (x, y) => { down = true; ox = x; oy = y; };
    const move = (x, y) => {
      if (!down) return;
      this._rotY += (x - ox) * 0.007;
      this._rotX += (y - oy) * 0.005;
      ox = x; oy = y;
      this._dirty = true;
    };
    el.addEventListener('mousedown', e => start(e.clientX, e.clientY));
    window.addEventListener('mousemove', e => move(e.clientX, e.clientY));
    window.addEventListener('mouseup', () => { down = false; });
    el.addEventListener('touchstart', e => {
      if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY);
      if (e.touches.length === 2) {
        down = false;
        pinch0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      }
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('touchmove', e => {
      if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY);
      if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        this._zoom = Math.max(0.3, Math.min(4, this._zoom * (d / (pinch0 || d))));
        pinch0 = d;
        this._dirty = true;
      }
    });
    window.addEventListener('touchend', () => { down = false; });
    el.addEventListener('wheel', e => {
      this._zoom = Math.max(0.3, Math.min(4, this._zoom * (1 - e.deltaY * 0.001)));
      this._dirty = true;
      e.preventDefault();
    }, { passive: false });
  }

  dispose() { this.renderer.dispose(); }
}
