// Run: node --experimental-strip-types src/world/colliders.selftest.ts   (Node 22.6+)
// @ts-ignore -- .ts extension needed for node strip-types
import { carObb, obbCorners, obbOverlap, pointInObb } from './colliders.ts';

function assert(c: boolean, m: string): void {
  if (!c) throw new Error('FAIL: ' + m);
}

const a = carObb(0, 0, 0, 1, 2);
assert(obbOverlap(a, carObb(1.5, 0, 0, 1, 2)), 'side overlap');
assert(!obbOverlap(a, carObb(2.5, 0, 0, 1, 2)), 'side apart');
assert(obbOverlap(a, carObb(0, -3, 0, 1, 2)), 'front overlap');
assert(!obbOverlap(a, carObb(0, -4.5, 0, 1, 2)), 'front apart');
// yaw = PI/2 faces west: long axis along X
const w = carObb(0, 0, Math.PI / 2, 1, 2);
assert(pointInObb({ x: -1.9, z: 0 }, w), 'west nose inside');
assert(!pointInObb({ x: 0, z: -1.9 }, w), 'north not inside rotated');
const c = obbCorners(w);
assert(Math.abs(c[0].x + 2) < 1e-9, 'front-left corner x = -2 (west)');
// rotated diamond vs axis-aligned
assert(!obbOverlap(carObb(0, 0, Math.PI / 4, 1, 1), carObb(2.6, 0, 0, 1, 1)), 'diamond apart');
assert(obbOverlap(carObb(0, 0, Math.PI / 4, 1, 1), carObb(2.2, 0, 0, 1, 1)), 'diamond overlap');
console.log('colliders selftest OK');
