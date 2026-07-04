# Soundform Glass UI Restyle — Design Spec

**Date:** 2026-07-04
**Status:** Approved in conversation (visionOS glass direction, all four scope upgrades selected)
**Constraint:** visual-only. No functionality changes: every element id, class hook, `data-fmt` attribute, and all JS files stay untouched except where noted (emoji glyphs → inline SVG inside existing buttons; one wrapper div around export buttons).

## 1. Goals

Restyle the app chrome (top bar, controls panel, export buttons, status bar, VU meter) to a visionOS-style frosted-glass Apple design language. Canvas artwork becomes full-bleed with chrome floating above it.

## 2. Non-goals

- Any change to generators, renderer, audio, exporter logic, or main.js bindings.
- Light mode. Responsive/mobile-specific layout work beyond what the floating panels give for free.
- New controls or removed controls.

## 3. Foundation tokens (CSS variables in `style.css`)

- Font: `-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif`; value readouts `ui-monospace` with `font-variant-numeric: tabular-nums`.
- Text: primary `rgba(255,255,255,.92)`, secondary `rgba(235,235,245,.6)`; section labels 11px uppercase, letter-spacing .08em, secondary colour.
- Accent: pastel lavender `#b8a7e0` (active states, focus rings, slider thumb tint) — never saturated blue.
- Glass recipe: `background: rgba(28,28,32,.55); backdrop-filter: blur(40px) saturate(1.8); -webkit-backdrop-filter: …; border: 1px solid rgba(255,255,255,.12);` radius 24px panels / 12px fields / 999px pills. Hairline separators `rgba(255,255,255,.08)`.
- Fallback: `@supports not (backdrop-filter: blur(1px))` → solid `rgba(28,28,32,.94)`.

## 4. Layout

- `#app` becomes a full-bleed canvas stage: `#canvas-wrap`/`#renderer-container` fill the window; all chrome is absolutely positioned above it.
- **Top-left glass strip:** Soundform wordmark + record controls (`#btn-mic`, `#lbl-file`, `#btn-stop`, `#btn-submit`, `#btn-clear`) as 36px circular glass buttons with inline-SVG line icons (mic, folder, stop, check, trash) replacing emoji. `aria-label`s added.
- **Top-right export pill:** existing five `.btn-export` buttons wrapped in `.export-pill` glass container, rendered as one segmented pill with hairline dividers. Ids/classes/data-fmt unchanged.
- **Right floating panel:** `#controls-panel` floats inset 16px (top/right/bottom), ~300px wide, internal scroll with thin overlay scrollbar, sections separated by hairlines. Mode buttons restyled as a segmented control (active = brighter glass + primary text). Sliders: 3px translucent track, 18px white round thumb (accent tint on active), no JS-driven fill. Palette `<select>`: glass field + custom SVG chevron. Colour inputs: 24px circular swatches. Footer 11px secondary.
- **Bottom-left status pill:** `#status-bar` as small glass pill, 12px secondary text.
- **VU meter:** slim glass capsule, accent fill.

## 5. Motion

0.2s ease transitions (hover/press/segment changes), panel fade-slide-in on load, thumb scale while dragging. All CSS; wrapped in `@media (prefers-reduced-motion: no-preference)`.

## 6. Implementation surface

- `style.css`: full rewrite (tokens + glass system + component styles).
- `index.html`: emoji → inline SVG inside existing buttons; add `.export-pill` wrapper div; add `?v=19` to the stylesheet link. No id/class removals, no script changes.
- Renderer sizing: canvas becomes full-width; existing resize handler in `density.js` already handles it (no JS edit).

## 7. Verification

- `npm test` stays 35/35 (no JS touched).
- Grep-parity check: every id/class main.js queries still present in index.html.
- Browser check by user: all buttons work (record → stop → create → clear; all five exports; mode switching; every slider/select/colour input), glass renders over the live artwork, fallback sanity via devtools if desired.
