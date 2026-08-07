# Cymatics water style — design

**Date:** 2026-08-07
**Status:** approved, ready for planning

## Problem

Cymatics renders as glowing particle density. The user wants it to read as
**water** — a lit, rippled liquid surface rather than a cloud of luminous
points.

Visual reference: [MIXTUR '23](https://www.behance.net/gallery/170731355/MIXTUR-23)
(Bakoom Studio, creative direction; Álvaro Studio, motion and 3D) — Chladni
patterns built from granulated particles, developed and animated in 3D. The
reference is not a graphic style but a *rendered material*: real grains, real
lighting, real depth. The user wants that treatment with water as the material
instead of pebbles.

## Delivery context

This drives the design more than the shader does.

- **Projection mapping onto a white wall, in a dark room.** Projectors are
  additive: they cannot make a surface darker than the room already is. On a
  lit wall every black region would project as nothing and read as the
  brightest thing in frame, inverting the tonal design — fatal for water,
  which reads through its darks. **The user confirmed the room will be dark**,
  so the wall goes dark and a full-depth water look is viable. No inverted or
  light-on-dark variant is needed.
- **Projection source is exported MP4s**, not a live feed. But MP4s are
  captured live from the canvas via `LiveRecorder`'s frame sink, so real-time
  frame cost still matters.
- **Promotional material** — high-res stills.
- **After Effects** edits and animates the exports. Handoff decision:
  **flat MP4 plus alpha stills.** AE does cuts, timing, grading and
  compositing over baked lighting. No separate render passes.

Alpha stills need no new code: `params.transparentBg` already flows through
`renderHiRes(scale, { transparent })` (main.js:820) to the `uTransparent`
uniform (density.js:570) for PNG and WebP.

## Architecture

Water is a **fourth cymatics style**, not a new mode or a second renderer.
`cymStyle: 'water'` joins `scope` / `sand` / `relief`.

Two files change:

| file | change |
|---|---|
| `js/generators/cymatics.js` | writes signed height into `attrv` for this style |
| `js/density.js` | water branch in `TONE_FRAG` |

Plus one `<option>` in `index.html` and a slider row.

Untouched: `worker.js`, `live.js`, `paint.js`, `recorder.js`, `exporter.js`,
`strands.js`, and every export path. Live mode, Paint, record and export work
by construction because nothing outside the shader and the attribute value
moves.

### Why this is small: the plumbing already exists

The signed field is already computed and already stored as geometry.
`js/generators/cymatics.js:97`:

```js
const f = field(r, th) / fMax;   // signed
...
y = f * relief + (rnd() + rnd() - 1) * spray * af0;   // line 106
```

The point's Y coordinate *is* the water surface height, correctly signed.

Separately, every point carries an `attrv` float that rides the whole
pipeline — splatted into green (`gl_FragColor = vec4(w, w * vAttr, 0.0, 1.0)`,
density.js:33) and read back in the tonemap as:

```glsl
float attr = s.g / max(s.r, 1e-5);   // density.js:48
```

That is a density-weighted mean — exactly the maths for reconstructing a
height field from a point cloud. It already exists and is currently spent on
unsigned amplitude.

## The height field

Today the generator writes the **unsigned** amplitude:

```js
attr[count] = a;        // relief: a = af0 = |f|
```

For water it writes the **signed** field remapped to unit range:

```js
attr[count] = f * 0.5 + 0.5;
```

Unit range rather than raw signed values, so the accumulated green channel
stays positive and the existing `t * 0.88 + attr * 0.12` LUT path cannot be
driven negative by a style that is not water.

The tonemap recovers signed height with `(s.g / max(s.r, 1e-5) - 0.5) * 2.0`.

Coverage is even: rejection sampling uses `|f|`, so crests and troughs are
sampled at equal probability and troughs contain no holes.

### Where water sits in the existing style branches

`cymatics.js` branches on style in three separate places, and water must be
grouped correctly in each or it will silently inherit `scope`/`sand`
behaviour. This is the most likely implementation error.

| site | current | water |
|---|---|---|
| `pOf` (cymatics.js:79) — sampling probability | ternary chain, `relief` is the fallback | **group with `relief`** — smooth full-surface coverage, not fringe-weighted or node-gathered |
| `pBoost` (cymatics.js:90) | `style === 'relief' ? 1 : min(6, …)` | **must be `1`**, as for `relief`; the boost exists to rescue the sparse scope/sand probability functions and would over-saturate a water surface |
| point loop (cymatics.js:100–110) | `sand` / `scope` / else-`relief` | **new `else if` branch** |

The new branch keeps relief's surface geometry and changes only the attribute:

```js
} else if (style === 'water') {
  y = f * relief + (rnd() + rnd() - 1) * spray * af0;
  a = f * 0.5 + 0.5;
}
```

`spray` is retained at first, giving the surface thickness rather than a
zero-width sheet. It is a tuning point: too much spray blurs the reconstructed
height field and softens the normals, so reducing it is the first lever to try
if the glints read mushy.

## The shader

A helper samples reconstructed height at an offset:

```glsl
float hAt(vec2 uv) {
  vec4 s = texture2D(tDensity, uv);
  return (s.g / max(s.r, 1e-5) - 0.5) * 2.0;
}
```

Five taps — four neighbours and the centre — produce both the normal and the
caustics, which is what keeps the cost down:

- **Normals** — central difference of the four neighbours, scaled by Ripple:
  `normalize(vec3(-dhdx * k, 1.0, -dhdy * k))`.
- **Caustics** — the Laplacian of the same five taps
  (`h(+x) + h(-x) + h(+y) + h(-y) - 4·h(centre)`), measuring where the surface
  converges light. Free given the normals, and the strongest water cue in the
  reference's register.
- **Specular glints** — Blinn-Phong against a fixed light direction with a
  high exponent; the crest sparkle.
- **Fresnel** — `pow(1 - dot(N, V), 5)`, brightening grazing tilts.
- **Refraction** — offsets the density lookup along the normal's XZ so the
  tonal pattern beneath appears displaced where the surface tilts; the
  "looking through water" cue.
- **Depth tint** — darkens and saturates the troughs.

The view is top-down flat by default (`flatView: true`, main.js:50), so the
view vector can be treated as constant rather than reconstructed per pixel.

### Controls

A `#row-water` block, shown only when this style is active, following the
existing `#row-cym-style` show/hide pattern (main.js:608):

| slider | drives |
|---|---|
| **Shine** | specular intensity and exponent |
| **Ripple** | normal strength, and refraction offset rides on it |
| **Caustics** | Laplacian term gain |

Refraction gets no separate control — YAGNI; it is physically tied to surface
tilt anyway.

## Alpha and coverage

The one real trap. The current line derives coverage from tonal *value*:

```glsl
float cov = smoothstep(0.0, 0.08, t) * min(t * 1.4 + 0.25, 1.0);   // density.js:50
```

For water that punches transparent holes through every dark trough, exporting
a surface full of gaps. **The water branch derives coverage from density
presence (`s.r`) instead**, so the disc stays solid and glints add luminance
on top without driving alpha.

## Palettes

Water is expected to work with the existing ramps. If none reads correctly as
liquid, one water ramp (deep blue-black → cyan → white glint) is added to
`js/palettes.js`. Deferred until the shader is on screen — not worth guessing.

## Testing and regression safety

**Water is an explicit choice only.** It is *not* added to `ARCH_STYLE`, the
archetype→style auto-map (cymatics.js:72). Auto-selection behaviour is
therefore byte-identical, and the cymatics GOLDEN snapshot checksums in
`test/snapshot.test.js` must still pass unchanged. That is the primary
regression guard: the new `attrv` value is reachable only under
`style === 'water'`.

New tests in `test/generators.test.js`:

- water `attrv` is centred near 0.5 with populated tails on both sides, where
  `relief`'s is one-sided — i.e. the signed field genuinely survives.
- water `attrv` stays within `[0, 1]`.
- the other three styles' `attrv` output is unchanged.

The GLSL is not node-testable and is judged on screen in the real app.

Cache-bust moves **50 → 51** across all versioned files, per project
convention that every `?v=NN` occurrence moves together. Files under
`js/generators/` are not versioned and need no bump.

## Out of scope

- **Vector export** (SVG / PDF / trace) keeps the existing tone-band
  treatment. Specular and refraction have no vector equivalent; water is a
  raster-only style. Accepted by the user.
- **Depth of field and glint bloom** — the post chain that would close most of
  the remaining distance to the reference's offline-3D feel, since MIXTUR
  leans on shallow DOF. Deferred until the base water has been seen, because
  it costs per-frame GPU time and the MP4 is captured live at 30fps.
- **Offline high-quality export renderer** — rejected. It cannot improve the
  MP4 (captured from the live canvas) and is the largest build for the
  narrowest reach.
- **Separate AE render passes** — rejected in favour of flat MP4 plus alpha
  stills.
