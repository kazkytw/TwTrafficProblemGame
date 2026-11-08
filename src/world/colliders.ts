import type { Obb, Vec2 } from '../types';

/**
 * Corners of an OBB, in order (front-left, front-right, back-right, back-left) as seen with
 * yaw convention: heading = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw).
 */
export function obbCorners(b: Obb): Vec2[] {
  const s = Math.sin(b.yaw);
  const c = Math.cos(b.yaw);
  const fx = -s, fz = -c; // forward
  const rx = c, rz = -s; // right
  const out: Vec2[] = [];
  for (const [a, f] of [[-1, 1], [1, 1], [1, -1], [-1, -1]] as const) {
    out.push({
      x: b.cx + rx * b.hw * a + fx * b.hl * f,
      z: b.cz + rz * b.hw * a + fz * b.hl * f,
    });
  }
  return out;
}

/** Separating-axis overlap test between two OBBs (touching counts as no overlap). */
export function obbOverlap(a: Obb, b: Obb): boolean {
  const ca = obbCorners(a);
  const cb = obbCorners(b);
  const axes: Vec2[] = [
    { x: Math.cos(a.yaw), z: -Math.sin(a.yaw) },
    { x: -Math.sin(a.yaw), z: -Math.cos(a.yaw) },
    { x: Math.cos(b.yaw), z: -Math.sin(b.yaw) },
    { x: -Math.sin(b.yaw), z: -Math.cos(b.yaw) },
  ];
  for (const ax of axes) {
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const p of ca) {
      const d = p.x * ax.x + p.z * ax.z;
      if (d < minA) minA = d;
      if (d > maxA) maxA = d;
    }
    for (const p of cb) {
      const d = p.x * ax.x + p.z * ax.z;
      if (d < minB) minB = d;
      if (d > maxB) maxB = d;
    }
    if (maxA <= minB || maxB <= minA) return false;
  }
  return true;
}

/** Is point p inside (or on the edge of) the OBB. */
export function pointInObb(p: Vec2, b: Obb): boolean {
  const dx = p.x - b.cx;
  const dz = p.z - b.cz;
  const s = Math.sin(b.yaw);
  const c = Math.cos(b.yaw);
  const lx = dx * c - dz * s; // along right
  const lf = -dx * s - dz * c; // along forward
  return Math.abs(lx) <= b.hw && Math.abs(lf) <= b.hl;
}

/** OBB for a car at (x,z) with yaw; hw half width, hl half length along heading. */
export function carObb(x: number, z: number, yaw: number, hw: number, hl: number): Obb {
  return { cx: x, cz: z, hw, hl, yaw };
}
