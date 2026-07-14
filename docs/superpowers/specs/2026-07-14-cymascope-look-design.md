# CymaScope Cymatics Look + Orientation Re-assert — Design

**Date:** 2026-07-14 · **Status:** Approved (conversation). Cymatics change user-authorized (second explicit grant this date); lock stands for the future.

## Goal
Cymatics designs read like CymaScope photographs: hairline interference striations, hard black voids, concentric bullseye core, doubled mode intricacy — presented dead top-down every time a design is created.

## Changes
1. **Orientation re-assert (js/main.js):** in `onResult`, when `params.flatView`, call `renderer.setOrientation(-Math.PI/2, 0)` — every Create presents a perfect plate regardless of prior drag/cache state. (Root cause of "still 3D": orientation set only at page load; drag has no way back.)
2. **Cymatics field (js/generators/cymatics.js):**
   - Fine striation carrier: `kFine = 40 + fp.pitchMedian·30`; point survival ×(0.55 + 0.45·cos²(kFine·r)).
   - Harder contrast: survival `pow(af, 1.4)`→`pow(af, 2.2)`, floor 0.08→0.03; guard N·30→N·60 (acceptance drops).
   - Bullseye core: extra mode `{ m: 0, kr: kBase·1.8, amp: 0.45, phase: 0 }` (radial rings).
   - Second harmonics: each note mode adds `{ m, kr×2, amp×0.5, same phase }` (no extra rnd calls).
   - Prosody envelope, wildness, relief, strand recipe unchanged. Deterministic per seed.

## Gate
Branch `cymascope-look`; user look-check on localhost vs reference images before merge (aesthetic change to the locked-favourite mode). Cache bump v=31→v=32 at ship. Contract tests must hold (≥ density/2 points despite sharper survival).
