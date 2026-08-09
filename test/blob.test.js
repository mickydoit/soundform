import test from 'node:test';
import assert from 'node:assert/strict';
import { smin, fieldAt, makeBlobField, blobBounds, marchingSquares,
         simplifyRing, closedCatmullRom, ringToPath, blobOutline } from '../js/blob.js';
// blob.js is now pure contouring machinery: Liquid's field changed from a
// circle SDF to a cymatic thickness field, but marching squares, ring
// simplification and periodic-bezier fitting are field-agnostic and are still
// what produces the vector export. These tests cover that machinery.

test('smin: reduces to min at k=0, and is never above it', () => {
  assert.equal(smin(3, 5, 0), 3);
  for (const [a, b] of [[1, 2], [-3, 4], [0.5, 0.5], [-2, -7]]) {
    const s = smin(a, b, 0.5);
    assert.ok(s <= Math.min(a, b) + 1e-12, `smin(${a},${b}) = ${s} exceeded min`);
  }
});

test('smin: blending pulls the surface OUTWARD between two circles', () => {
  // The point midway between two separated circles is outside both, but the
  // smooth union should bridge it — that bridge IS the tapered neck.
  const circles = [{ x: -0.3, y: 0, r: 0.22 }, { x: 0.3, y: 0, r: 0.22 }];
  const hard = Math.min(
    Math.hypot(0.3, 0) - 0.22, Math.hypot(-0.3, 0) - 0.22);
  const soft = fieldAt(circles, 0.25, 0, 0);
  assert.ok(hard > 0, 'midpoint should be outside the raw circles');
  assert.ok(soft < hard, `smooth union must pull inward at the neck (${soft} vs ${hard})`);
});

test('field: negative inside a circle, positive well outside', () => {
  const f = makeBlobField([{ x: 0, y: 0, r: 0.5 }], 0.1);
  assert.ok(f(0, 0) < 0);
  assert.ok(f(0.9, 0.9) > 0);
});

test('blobBounds pads by the blend radius', () => {
  // The smooth union pushes the surface outward past the raw circles, so
  // bounds that only cover the circles clip the contour and it stitches open.
  const b = blobBounds([{ x: 0, y: 0, r: 0.4 }], 0.2, 0.05);
  assert.ok(b.x0 <= -0.4 - 0.2, `left bound ${b.x0} does not clear the blend`);
  assert.ok(b.x1 >= 0.4 + 0.2);
});

test('marchingSquares: a single circle yields one closed ring at the right radius', () => {
  const circles = [{ x: 0, y: 0, r: 0.5 }];
  const loops = marchingSquares(makeBlobField(circles, 0.15), blobBounds(circles, 0.15), 200);
  assert.equal(loops.length, 1, `expected one ring, got ${loops.length}`);
  const ring = loops[0];
  assert.ok(ring.length > 50, 'ring too coarse');
  // Closed: last point returns to the first.
  const d = Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]);
  assert.ok(d < 0.02, `ring not closed (gap ${d})`);
  for (const [x, y] of ring) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), 'non-finite contour vertex');
    assert.ok(Math.abs(Math.hypot(x, y) - 0.5) < 0.02, `vertex off the circle: r=${Math.hypot(x, y)}`);
  }
});

test('marchingSquares: two far-apart circles give TWO rings, one merged blob gives ONE', () => {
  const apart = [{ x: -0.8, y: 0, r: 0.2 }, { x: 0.8, y: 0, r: 0.2 }];
  assert.equal(marchingSquares(makeBlobField(apart, 0.05), blobBounds(apart, 0.05), 220).length, 2);

  const near = [{ x: -0.2, y: 0, r: 0.25 }, { x: 0.2, y: 0, r: 0.25 }];
  assert.equal(marchingSquares(makeBlobField(near, 0.2), blobBounds(near, 0.2), 220).length, 1);
});

test('simplifyRing: keeps the ring closed and cuts point count', () => {
  const circles = [{ x: 0, y: 0, r: 0.5 }];
  const ring = marchingSquares(makeBlobField(circles, 0.15), blobBounds(circles, 0.15), 200)[0];
  const s = simplifyRing(ring, 0.004);
  assert.ok(s.length < ring.length, 'no reduction');
  assert.ok(s.length > 8, `over-simplified to ${s.length} points`);
  // Every kept vertex still sits on the circle — i.e. it simplified rather
  // than collapsing, which is what the open-chain RDP does to a ring.
  for (const [x, y] of s) assert.ok(Math.abs(Math.hypot(x, y) - 0.5) < 0.03);
});

test('closedCatmullRom: periodic — emits one segment per point and returns to the start', () => {
  const pts = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const segs = closedCatmullRom(pts);
  assert.equal(segs.length, pts.length, 'a closed ring needs a segment closing it');
  assert.deepEqual(segs[segs.length - 1].end, pts[0], 'last segment must land on the first point');
});

test('ringToPath: emits a closed SVG path with no NaN', () => {
  const d = ringToPath([[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.ok(d.startsWith('M'), 'path must start with a moveto');
  assert.ok(d.endsWith('Z'), 'path must be closed');
  assert.ok(!/NaN|Infinity/.test(d), `path contains non-finite values: ${d}`);
});

test('blobOutline: projects into pixel space inside the frame', () => {
  const circles = [{ x: -0.35, y: 0.1, r: 0.28 }, { x: 0.3, y: -0.2, r: 0.22 }, { x: 0.1, y: 0.35, r: 0.18 }];
  const { rings } = blobOutline(circles, { smooth: 0.18, width: 1600, height: 1200 });
  assert.ok(rings.length >= 1, 'no outline produced');
  for (const ring of rings) {
    for (const [x, y] of ring) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
      assert.ok(x >= 0 && x <= 1600 && y >= 0 && y <= 1200, `vertex outside frame: ${x},${y}`);
    }
  }
});
