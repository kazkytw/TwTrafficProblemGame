import * as THREE from 'three';
import type { Obb, Vec2 } from '../types';
import { obbCorners } from '../world/colliders';

/** Debug overlay helper: ids map to line/sector objects drawn flat above the ground. No-ops when disabled. */
export class DebugDraw {
  private readonly scene: THREE.Scene;
  private readonly root = new THREE.Group();
  private readonly items = new Map<string, THREE.Object3D>();
  private enabled = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.root.name = 'DebugDraw';
    this.root.visible = false;
    scene.add(this.root);
  }

  /** Enable/disable all drawing. Disabling hides existing shapes; they reappear when re-enabled. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.root.visible = on;
  }

  /** Draw an OBB outline (replaces any shape with the same id). */
  drawObb(id: string, box: Obb, color: number | string): void {
    if (!this.enabled) return;
    const pts = obbCorners(box).map((p) => new THREE.Vector3(p.x, 0.08, p.z));
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color }),
    );
    this.put(id, line);
  }

  /** Draw a polyline on the ground. */
  drawPath(id: string, pts: Vec2[], color: number | string): void {
    if (!this.enabled) return;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, 0.1, p.z))),
      new THREE.LineBasicMaterial({ color }),
    );
    this.put(id, line);
  }

  /** Translucent sector centred on heading yawCentre (heading = (-sin, -cos)), +-halfAngle, radius length. */
  drawFan(id: string, origin: Vec2, yawCentre: number, halfAngle: number, length: number, color: number | string): void {
    if (!this.enabled) return;
    // CircleGeometry angle phi is measured in XY plane; after rotateX(-PI/2) world z = -y,
    // so heading angle phi = yaw + PI/2.
    const phi = yawCentre + Math.PI / 2;
    const geo = new THREE.CircleGeometry(length, 24, phi - halfAngle, halfAngle * 2);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    mesh.position.set(origin.x, 0.07, origin.z);
    this.put(id, mesh);
  }

  /** Remove one shape. */
  clear(id: string): void {
    const o = this.items.get(id);
    if (!o) return;
    this.root.remove(o);
    disposeObj(o);
    this.items.delete(id);
  }

  /** Remove all shapes. */
  clearAll(): void {
    for (const id of [...this.items.keys()]) this.clear(id);
  }

  private put(id: string, o: THREE.Object3D): void {
    this.clear(id);
    this.items.set(id, o);
    this.root.add(o);
  }
}

function disposeObj(o: THREE.Object3D): void {
  const m = o as THREE.Mesh;
  m.geometry?.dispose();
  const mat = m.material as THREE.Material | THREE.Material[] | undefined;
  if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
  else mat?.dispose();
}
