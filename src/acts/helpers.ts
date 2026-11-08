import * as THREE from 'three';
import type { Vec2 } from '../types';

/** Flat ribbon along a ground polyline. Returns the mesh; caller removes/disposes via `disposeRibbon`. */
export function makeRibbon(pts: Vec2[], color: number, width = 0.5, y = 0.2, opacity = 0.9): THREE.Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    // left normal on ground
    const nx = -dz;
    const nz = dx;
    pos.push(p.x + (nx * width) / 2, y, p.z + (nz * width) / 2, p.x - (nx * width) / 2, y, p.z - (nz * width) / 2);
    if (i < pts.length - 1) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const m = new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 5;
  return mesh;
}

export function disposeObject(o: THREE.Object3D): void {
  o.removeFromParent();
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose?.();
  });
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
