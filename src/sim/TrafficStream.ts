import * as THREE from 'three';
import type { Obb } from '../types';
import { obbOverlap } from '../world/colliders';
import { createCarMesh } from './CarMesh';
import { lanes } from '../world/lanes';
import type { IntersectionConfig } from '../types';

/** One straight traffic lane. dir: +1 = southbound (+Z), -1 = northbound (-Z). */
export interface LaneParams {
  laneX: number;
  dir: 1 | -1;
  /** m/s */
  speed: number;
  /** seconds between spawns (base) */
  headway: number;
  /** extra random seconds added to each headway: [0, jitter) */
  jitter: number;
  enabled: boolean;
}

export interface TrafficParamsShape {
  spawnDist: number; // |z| where cars appear / disappear
  /**
   * Same direction as the player (northbound), right of the player's lane. Dense on purpose:
   * the oncoming left-turner waiting at the centre never finds a gap, so it basically never moves.
   */
  sameDir: LaneParams;
  /**
   * Oncoming straight traffic (southbound). Sparse enough that there are gaps, but frequent enough
   * that the player feels the pressure to turn early.
   */
  oncoming: LaneParams;
  /** the car waiting at the centre to turn left from the north arm (stuck: see sameDir) */
  waitingCarPos: { x: number; z: number; yaw: number };
  waitingCarEnabled: boolean;
  carHalfWidth: number;
  carHalfLength: number;
}

/** Live-tweakable defaults (editor may mutate; read every frame). Waiting car yaw PI = facing south. */
export const TrafficParams: TrafficParamsShape = {
  spawnDist: 80,
  // northbound outer lane; dense, so the oncoming left-turner never finds a gap
  sameDir: { laneX: 5.1, dir: -1, speed: 8, headway: 1.6, jitter: 0.5, enabled: true },
  // southbound outer (straight) lane; slower than before, with gaps
  oncoming: { laneX: -6, dir: 1, speed: 5.5, headway: 6, jitter: 4, enabled: true },
  // the oncoming left-turner waits in the southbound inner (left-turn) lane, inside the box
  waitingCarPos: { x: -1.7, z: -1.0, yaw: Math.PI },
  waitingCarEnabled: true,
  carHalfWidth: 0.9,
  carHalfLength: 2.2,
};

const COLORS = [0xc0392b, 0xe5e5e5, 0x2c3e50, 0xf1c40f, 0x27ae60, 0x7f8c8d, 0x8e44ad, 0xd35400, 0x1abc9c];

interface Veh {
  mesh: THREE.Group;
  z: number;
  lane: LaneParams;
}

export class TrafficStream {
  private scene: THREE.Scene;
  private cars: Veh[] = [];
  private waiting: THREE.Group | null = null;
  private running = false;
  private timers = new Map<LaneParams, number>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  private lanes(): LaneParams[] {
    return [TrafficParams.sameDir, TrafficParams.oncoming];
  }

  /** Starts (or restarts) the streams. Roads are pre-filled so there is no empty start. */
  start(opts?: Partial<TrafficParamsShape>): void {
    if (opts) Object.assign(TrafficParams, opts);
    this.clear();
    this.running = true;
    this.timers.clear();
    const total = (2 * TrafficParams.spawnDist) / Math.min(TrafficParams.sameDir.speed, TrafficParams.oncoming.speed);
    for (let t = 0; t < total; t += 0.1) this.step(0.1);
    const w = TrafficParams.waitingCarPos;
    if (TrafficParams.waitingCarEnabled) {
      const m = createCarMesh({ color: 0x4a4f5a });
      m.position.set(w.x, 0, w.z);
      m.rotation.y = w.yaw;
      this.scene.add(m);
      this.waiting = m;
    }
  }

  stop(): void {
    this.running = false;
  }

  update(dt: number): void {
    if (!this.running) return;
    this.step(Math.min(dt, 0.1));
  }

  private step(dt: number): void {
    const P = TrafficParams;
    for (const lane of this.lanes()) {
      if (!lane.enabled) continue;
      let timer = (this.timers.get(lane) ?? 0) - dt;
      while (timer <= 0) {
        const startZ = lane.dir === 1 ? -P.spawnDist : P.spawnDist;
        this.spawn(lane, startZ + lane.dir * -timer * lane.speed);
        timer += lane.headway + Math.random() * lane.jitter;
      }
      this.timers.set(lane, timer);
    }
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      c.z += c.lane.dir * c.lane.speed * dt;
      c.mesh.position.set(c.lane.laneX, 0, c.z);
      if (Math.abs(c.z) > P.spawnDist + 5) {
        this.scene.remove(c.mesh);
        this.cars.splice(i, 1);
      }
    }
  }

  private spawn(lane: LaneParams, z: number): void {
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const mesh = createCarMesh({ color });
    mesh.rotation.y = lane.dir === 1 ? Math.PI : 0; // PI = facing south
    mesh.position.set(lane.laneX, 0, z);
    this.scene.add(mesh);
    this.cars.push({ mesh, z, lane });
  }

  /** All dynamic obstacle boxes (stream cars + waiting car). */
  obbs(): Obb[] {
    const P = TrafficParams;
    const out: Obb[] = this.cars.map((c) => ({
      cx: c.lane.laneX,
      cz: c.z,
      hw: P.carHalfWidth,
      hl: P.carHalfLength,
      yaw: c.lane.dir === 1 ? Math.PI : 0,
    }));
    if (this.waiting) {
      const w = P.waitingCarPos;
      out.push({ cx: w.x, cz: w.z, hw: P.carHalfWidth, hl: P.carHalfLength, yaw: w.yaw });
    }
    return out;
  }

  hitTest(playerObb: Obb): boolean {
    for (const o of this.obbs()) if (obbOverlap(playerObb, o)) return true;
    return false;
  }

  private clear(): void {
    for (const c of this.cars) this.scene.remove(c.mesh);
    this.cars = [];
    if (this.waiting) this.scene.remove(this.waiting);
    this.waiting = null;
  }

  dispose(): void {
    this.running = false;
    this.clear();
  }
}

/** Put the traffic lanes and the waiting car where the world's lane layout says (call before start()). */
export function applyLaneLayout(c: IntersectionConfig): void {
  const { nsInner, nsOuter } = lanes(c);
  TrafficParams.sameDir.laneX = nsOuter;
  TrafficParams.oncoming.laneX = -nsOuter;
  TrafficParams.waitingCarPos.x = -nsInner;
  if (c.waitingCar) Object.assign(TrafficParams.waitingCarPos, c.waitingCar); // user-placed in the editor
}
