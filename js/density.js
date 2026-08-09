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

// ── Liquid: analytic metaball blob, shaded as glossy water ──────────────
//
// Completely bypasses the splat/density pipeline. There is no point cloud —
// the shape is an isocontour of the smooth-union SDF below, evaluated per
// pixel. `smin`/`blobField` MUST stay in lockstep with js/blob.js, which
// evaluates the identical field on the CPU to produce the vector export; if
// they drift, the exported outline no longer matches what is on screen.
const BLOB_MAX = 16;
const BLOB_FRAG = `
precision highp float;
varying vec2 vUv;
uniform vec3 uCircles[${BLOB_MAX}];   // xy = centre, z = radius
uniform int uCount;
uniform float uSmooth, uAspect, uZoom;
uniform vec2 uPan;
uniform vec3 uInk, uGround;
uniform float uGloss, uDispersion, uFlat, uTransparentB;

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float blobField(vec2 p) {
  float d = length(p - uCircles[0].xy) - uCircles[0].z;
  for (int i = 1; i < ${BLOB_MAX}; i++) {
    if (i >= uCount) break;
    d = smin(d, length(p - uCircles[i].xy) - uCircles[i].z, uSmooth);
  }
  return d;
}

void main() {
  vec2 p = (vUv - 0.5 - uPan) * vec2(uAspect, 1.0) * 2.6 / uZoom;
  float d = blobField(p);

  // Screen-space derivative gives a resolution-independent edge width, so the
  // rim stays one pixel wide at any export size instead of scaling with it.
  float px = fwidth(d);
  float inside = 1.0 - smoothstep(-px, px, d);

  if (uFlat > 0.5) {
    // Flat state: exactly the silhouette the vector export emits, so what is
    // on screen and what lands in the SVG are the same shape.
    gl_FragColor = mix(vec4(mix(uGround, uInk, inside), 1.0),
                       vec4(uInk, inside), uTransparentB);
    return;
  }

  // Surface normal of the implicit shape, from the field gradient.
  vec2 e = vec2(px * 1.5, 0.0);
  vec2 grad = vec2(blobField(p + e.xy) - blobField(p - e.xy),
                   blobField(p + e.yx) - blobField(p - e.yx));
  vec2 nxy = normalize(grad + 1e-6);

  // A thin bright meniscus hugging the edge — the single strongest cue that
  // this is a liquid bead rather than a flat shape.
  float rim = exp(-pow(max(0.0, -d) / (uSmooth * 0.30), 1.5));
  // Depth into the shape: 0 at the outline, 1 well inside.
  float t = clamp(-d / (uSmooth * 1.6), 0.0, 1.0);
  // Height of the bead: full in the middle, falling to nothing at the edge.
  float dome = sqrt(max(0.0, 1.0 - pow(1.0 - t, 2.0)));
  // How tilted the surface is. Steep at the rim, flat in the middle. Every
  // normal-dependent term must be gated by this: deep inside, the field's
  // medial axis creases and the gradient direction flips there, so anything
  // driven by the normal paints a hard spike straight down the middle of the
  // blob. Weighting by depth instead of by slope is what put them there.
  float slope = 1.0 - t;

  // Iridescence. The ground here is a flat colour, so displacing a lookup
  // into it would refract nothing — there is no detail behind the bead to
  // bend. What actually reads as thin-film dispersion in the reference is
  // colour SPLITTING along the rim, so drive a hue sweep from the edge
  // normal's direction and confine it to the meniscus.
  float a = atan(nxy.y, nxy.x) * 2.0;
  vec3 iri = vec3(sin(a), sin(a + 2.094), sin(a + 4.188)) * 0.5 + 0.5;

  vec3 tint = uGround + (uInk - uGround) * (0.10 + 0.34 * dome);

  // slope SQUARED: the gradient of a distance field is singular at each
  // circle's centre, and a linear gate still leaks a dark chevron pointing at
  // every lobe centre. Squaring pushes all normal-driven shading onto the
  // rim, where a bead's shading actually lives.
  float edge = slope * slope;
  float spec = pow(clamp(dot(nxy, normalize(vec2(-0.55, 0.83))), 0.0, 1.0), 6.0) * edge;
  vec3 body = tint + (iri - 0.5) * rim * uDispersion * 0.55;
  vec3 col = body + vec3(1.0) * (rim * 0.85 + spec * 0.35) * uGloss;

  gl_FragColor = mix(vec4(mix(uGround, col, inside), 1.0),
                     vec4(col, inside), uTransparentB);
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
    // blob is set; `this.blob` null means every other mode behaves exactly as
    // before, down to the render path taken.
    this.blob = null;
    this.blobMat = new THREE.ShaderMaterial({
      vertexShader: TONE_VERT, fragmentShader: BLOB_FRAG,
      extensions: { derivatives: true },   // fwidth() is an extension in WebGL1
      // Flat typed arrays rather than THREE.Vector2/3: three.js binds a
      // length-3N array to a vec3[N] uniform identically, and it keeps this
      // constructor runnable under the minimal THREE stub the node tests use.
      uniforms: {
        uCircles: { value: new Float32Array(BLOB_MAX * 3) },
        uCount: { value: 0 },
        uSmooth: { value: 0.18 },
        uAspect: { value: 1 },
        uZoom: { value: 1 },
        uPan: { value: new Float32Array([0, 0]) },
        uInk: { value: new Float32Array([0.06, 0.07, 0.09]) },
        uGround: { value: new Float32Array([0.72, 0.76, 0.79]) },
        uGloss: { value: 1 }, uDispersion: { value: 1 },
        uFlat: { value: 0 }, uTransparentB: { value: 0 },
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
  setBlob(circles, smooth) {
    if (!circles || !circles.length) { this.blob = null; this._dirty = true; return; }
    const u = this.blobMat.uniforms;
    const n = Math.min(circles.length, BLOB_MAX);
    const arr = u.uCircles.value;
    arr.fill(0);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = circles[i].x; arr[i * 3 + 1] = circles[i].y; arr[i * 3 + 2] = circles[i].r;
    }
    u.uCount.value = n;
    u.uSmooth.value = Math.max(0.01, smooth || 0.18);
    this.blob = { circles: circles.slice(0, n), smooth: u.uSmooth.value };
    this._dirty = true;
  }

  setBlobStyle({ flat, gloss, dispersion, ink, ground } = {}) {
    const u = this.blobMat.uniforms;
    if (flat !== undefined) u.uFlat.value = flat ? 1 : 0;
    if (gloss !== undefined) u.uGloss.value = gloss;
    if (dispersion !== undefined) u.uDispersion.value = dispersion;
    if (ink) u.uInk.value.set(ink);
    if (ground) u.uGround.value.set(ground);
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
