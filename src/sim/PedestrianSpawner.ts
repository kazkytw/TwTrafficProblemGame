import * as THREE from 'three';
import type { CarState, DriveInput, Obb, Pedestrian, Vec2, World } from '../types';
import { obbCorners } from '../world/colliders';
import { CarController, defaultCarParams } from './CarController';
import { aPillarFan, A_PILLAR_LOCAL } from './CarMesh';
import { lanes } from '../world/lanes';

// ============================================================================
// Tunables
// ============================================================================
/**
 * Blind mode = "pillar lock + commit":
 *  1) lock   - every frame the walker heads for the point where the left A-pillar's centre sight line
 *              crosses the crosswalk, so he stays behind the pillar however the player drives
 *              (constant bearing, decreasing range: the classic A-pillar accident geometry).
 *  2) commit - in the last moment (close to the eye, or about to reach the crosswalk) he steps into the
 *              car's path, because the pillar sight line meets the crosswalk ~0.5-1 m left of the car body.
 */
export interface BlindSpawnParams {
  /** bumper distance along the left-turn path (see distanceToCrosswalk) at which the act calls spawnBlind */
  distance: number;
  /** normal walking speed (also used once blind mode ends) */
  walkSpeed: number;
  /** max forward speed while tracking the pillar (brisk walk) */
  maxWalkSpeed: number;
  /** max backward speed while tracking (a small hesitation step) */
  maxBackSpeed: number;
  /** time constant (s) of the pillar tracking: smaller = tighter lock, jerkier motion */
  lockLag: number;
  /**
   * Where inside the pillar sector the walker is held: 0 = centre line, 1 = inner edge (nearest the
   * car's path). Toward the inner edge the final step into the car is much shorter.
   */
  lockBias: number;
  /** speed slew limit (m/s^2) */
  accel: number;
  /** spawn gate: max heading error (rad) to the final (post-turn) heading; Infinity = spawn at `distance` whatever the heading */
  headingTol: number;
  /** lowest track position (m from the kerb end) the walker may stand on while hidden; 1.2 = on the zebra */
  minS: number;
  /** last-resort commit when the walker is closer than this to the driver's eye (m) */
  commitDistance: number;
  /** lag (m) behind the lock point that allows a just-in-time commit */
  lagCommit: number;
  /** max speed while stepping into the car's path */
  commitMaxSpeed: number;
  /**
   * Frames in which the walker is closer than this to the eye are NOT counted in blindRatio: the figure
   * (0.42 m wide) is wider than the 8 deg fan below ~3 m, so it cannot be hidden any more.
   */
  exposeDistance: number;
}
export const defaultBlindParams: BlindSpawnParams = {
  distance: 4,
  walkSpeed: 1.3,
  maxWalkSpeed: 3.5,
  maxBackSpeed: 1.5,
  lockLag: 0.15,
  lockBias: 0.4,
  accel: 8,
  headingTol: 0.25,
  minS: 1.2,
  commitDistance: 1.6,
  lagCommit: 0.6,
  commitMaxSpeed: 3,
  exposeDistance: 3,
};

const PED_RADIUS = 0.3;
const ENTRY_MARGIN = 0.15; // conflict point kept this far inside the OBB edges

// ============================================================================
// Math helpers
// ============================================================================
const wrapPi = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Straight pedestrian track from world.pedestrianPath() (first -> last point). s = arc length from south. */
interface Track {
  p0: Vec2;
  u: Vec2; // unit direction (south -> north)
  n: Vec2; // unit normal pointing to the intersection side
  len: number;
}
function makeTrack(world: World): Track {
  const path = world.pedestrianPath();
  const a = path[0];
  const b = path[path.length - 1];
  let ux = b.x - a.x;
  let uz = b.z - a.z;
  const len = Math.hypot(ux, uz) || 1;
  ux /= len;
  uz /= len;
  let nx = -uz;
  let nz = ux;
  if (nx * (0 - a.x) + nz * (0 - a.z) < 0) {
    nx = -nx;
    nz = -nz;
  }
  return { p0: { x: a.x, z: a.z }, u: { x: ux, z: uz }, n: { x: nx, z: nz }, len };
}
const trackPos = (t: Track, s: number): Vec2 => ({ x: t.p0.x + t.u.x * s, z: t.p0.z + t.u.z * s });
const signedDist = (t: Track, p: Vec2) => t.n.x * (p.x - t.p0.x) + t.n.z * (p.z - t.p0.z);

/** Where a trigger-spawned pedestrian appears: on the crosswalk, at the given bearing left of the car's heading. */
export function aheadSpawn(world: World, car: { x: number; z: number; yaw: number }, bearingDeg = 25): { s: number; pos: Vec2; dist: number } {
  const tr = makeTrack(world);
  const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
  const lx = -Math.cos(car.yaw), lz = Math.sin(car.yaw);
  let bestS = Math.min(tr.len * 0.3, tr.len - 1.2), bestErr = Infinity;
  for (let s = 1.2; s <= tr.len - 1.2; s += 0.1) {
    const p = trackPos(tr, s);
    const dx = p.x - car.x, dz = p.z - car.z;
    const fwd = dx * fx + dz * fz, left = dx * lx + dz * lz;
    // invalid candidates (behind / right of the car) are only penalised, so the result never jumps
    const err = Math.abs(Math.atan2(left, fwd) - (bearingDeg * Math.PI) / 180) + (fwd < 1.5 || left < 0 ? 5 : 0);
    if (err < bestErr) { bestErr = err; bestS = s; }
  }
  const pos = trackPos(tr, bestS);
  return { s: bestS, pos, dist: Math.hypot(pos.x - car.x, pos.z - car.z) };
}

function carObbOf(st: CarState, hw = defaultCarParams.halfWidth, hl = defaultCarParams.halfLength): Obb {
  return { cx: st.x, cz: st.z, hw, hl, yaw: st.yaw };
}

/** Approach side of the track for the car (+1 = intersection side). */
const sideOf = (t: Track, st: CarState) => (signedDist(t, { x: st.x, z: st.z }) >= 0 ? 1 : -1);

/** min over OBB corners of sigma * signed distance to the track line (<= 0: OBB reached the line). */
function reach(t: Track, st: CarState, sigma: number): number {
  let m = Infinity;
  for (const c of obbCorners(carObbOf(st))) m = Math.min(m, sigma * signedDist(t, c));
  return m;
}

/** Parameter interval [s0,s1] of the track line inside the OBB shrunk by margin; null if empty. */
function clipTrack(t: Track, st: CarState): [number, number] | null {
  const s = Math.sin(st.yaw);
  const c = Math.cos(st.yaw);
  const R = { x: c, z: -s };
  const H = { x: -s, z: -c };
  const dx = t.p0.x - st.x;
  const dz = t.p0.z - st.z;
  let lo = -Infinity;
  let hi = Infinity;
  const slabs: [number, number, number][] = [
    [dx * R.x + dz * R.z, t.u.x * R.x + t.u.z * R.z, defaultCarParams.halfWidth - ENTRY_MARGIN],
    [dx * H.x + dz * H.z, t.u.x * H.x + t.u.z * H.z, defaultCarParams.halfLength - ENTRY_MARGIN],
  ];
  for (const [a, b, lim] of slabs) {
    if (Math.abs(b) < 1e-9) {
      if (Math.abs(a) > lim) return null;
    } else {
      let l = (-lim - a) / b;
      let h = (lim - a) / b;
      if (l > h) [l, h] = [h, l];
      lo = Math.max(lo, l);
      hi = Math.min(hi, h);
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Angular error (rad) of a point as seen from the driver's eye relative to the A-pillar fan centre. */
function fanError(st: CarState, p: Vec2): { err: number; half: number; dist: number } {
  const fan = aPillarFan(st);
  const dx = p.x - fan.origin.x;
  const dz = p.z - fan.origin.z;
  const w = Math.atan2(-dx, -dz);
  return { err: wrapPi(w - fan.yawCentre), half: fan.halfAngle, dist: Math.hypot(dx, dz) };
}

// ============================================================================
// Blind-mode geometry
// ============================================================================
/**
 * Arc length s where the left A-pillar's centre sight line crosses the track line; null if it points away.
 * Mid-turn the pillar sweeps > 50 deg/s, so while the car is still far from its final heading (facing the
 * crosswalk) the ray is cast with that final heading: the walker waits where the pillar WILL be once the
 * car straightens, instead of chasing the sweep and then having to walk back.
 */
function aimPose(tr: Track, car: CarState): { pose: CarState; turning: boolean } {
  const sigma = sideOf(tr, car);
  const finalYaw = Math.atan2(sigma * tr.n.x, sigma * tr.n.z);
  const e = wrapPi(finalYaw - car.yaw);
  const w = clamp((Math.abs(e) - 0.15) / 0.25, 0, 1); // |e| < 9 deg: real yaw, > 23 deg: final yaw
  return { pose: { ...car, yaw: car.yaw + e * w }, turning: Math.abs(e) > 0.15 };
}

function pillarRayS(tr: Track, car: CarState, bias = 0, maxWalk = Infinity): number | null {
  const pose = aimPose(tr, car).pose;
  const fan = aPillarFan(pose);
  // holding bearing b while the car drives at v needs a walking speed of about v * tan(b): for a fast
  // car aim nearer the inner edge (smaller b), but keep ~3 deg inside the sector
  const centreRel = wrapPi(fan.yawCentre - pose.yaw);
  const bWalk = car.speed > 0.1 ? Math.atan((0.85 * maxWalk) / car.speed) : Infinity;
  const off = Math.min(Math.max(bias * fan.halfAngle, centreRel - bWalk), fan.halfAngle - 0.05);
  bias = off / fan.halfAngle;
  // bias > 0 moves the aim toward the pillar's INNER edge (nearer the car's path)
  const aim = fan.yawCentre - bias * fan.halfAngle;
  const dx = -Math.sin(aim);
  const dz = -Math.cos(aim);
  const den = tr.u.x * dz - tr.u.z * dx;
  if (Math.abs(den) < 1e-6) return null;
  const ox = fan.origin.x - tr.p0.x;
  const oz = fan.origin.z - tr.p0.z;
  const t = (ox * tr.u.z - oz * tr.u.x) / den; // distance along the sight line
  if (t <= 0) return null;
  return (ox * dz - oz * dx) / den;
}

/**
 * Extrapolate the car straight along its heading until its OBB covers the track: returns the target s
 * for the walker (just inside the car's left edge, where he comes from) and the distance to get there.
 */
function conflictAhead(tr: Track, carNow: CarState): { s: number; dist: number } | null {
  const car = aimPose(tr, carNow).pose; // mid-turn: extrapolate along the final heading
  const fx = -Math.sin(car.yaw);
  const fz = -Math.cos(car.yaw);
  for (let k = 0; k <= 150; k++) {
    const d = k * 0.1;
    const seg = clipTrack(tr, { ...car, x: car.x + fx * d, z: car.z + fz * d });
    if (seg) return { s: seg[0] + Math.min(0.4, (seg[1] - seg[0]) / 2), dist: d };
  }
  return null;
}

// ============================================================================
// Mesh
// ============================================================================
interface PedParts {
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  body: THREE.Group;
}

function createPedestrianMesh(): { root: THREE.Group; parts: PedParts } {
  const root = new THREE.Group();
  root.name = 'pedestrian';
  const body = new THREE.Group();
  root.add(body);
  const cloth = new THREE.MeshLambertMaterial({ color: 0xd9a441 });
  const pants = new THREE.MeshLambertMaterial({ color: 0x2f3f66 });
  const skin = new THREE.MeshLambertMaterial({ color: 0xe0b48f });
  const pack = new THREE.MeshLambertMaterial({ color: 0x3a2a1a });
  const mk = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    return o;
  };
  // torso 0.8..1.4, head 1.4..1.62
  body.add(mk(new THREE.BoxGeometry(0.42, 0.6, 0.24), cloth, 0, 1.1, 0));
  body.add(mk(new THREE.BoxGeometry(0.2, 0.22, 0.2), skin, 0, 1.51, 0));
  // darker backpack on the back (+Z local, since the figure faces -Z)
  body.add(mk(new THREE.BoxGeometry(0.34, 0.44, 0.18), pack, 0, 1.12, 0.2));
  for (const sx of [-0.2, 0.2]) body.add(mk(new THREE.BoxGeometry(0.09, 0.5, 0.09), cloth, sx * 1.1, 1.1, 0));
  const legs: THREE.Group[] = [];
  for (const sx of [-0.11, 0.11]) {
    const hip = new THREE.Group();
    hip.position.set(sx, 0.8, 0);
    hip.add(mk(new THREE.BoxGeometry(0.16, 0.8, 0.16), pants, 0, -0.4, 0));
    body.add(hip);
    legs.push(hip);
  }
  return { root, parts: { legL: legs[0], legR: legs[1], body } };
}

function disposeObject(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) mat.dispose();
  });
}

// ============================================================================
// PedestrianSpawner
// ============================================================================
interface BlindPlan {
  active: boolean;
  /** true once the walker has left the pillar lock and is stepping into the car's path */
  committed: boolean;
}

export class PedestrianSpawner {
  pedestrian: Pedestrian | null = null;
  /** fraction of frames (while blind mode was active, until impact) the walker was inside the fan */
  get blindRatio(): number {
    return this.frames > 0 ? this.insideFrames / this.frames : this.plannedBlindRatio;
  }
  /** ratio predicted by the planner at spawn time (open-loop, assuming held input) */
  plannedBlindRatio = 0;
  /** true once hitTest() found an overlap (the walker then stops) */
  hit = false;
  params: BlindSpawnParams = { ...defaultBlindParams };

  private scene: THREE.Scene;
  private world: World;
  private track: Track;
  private s = 0;
  private v = 0;
  private walking = false;
  private plan: BlindPlan | null = null;
  private frames = 0;
  private insideFrames = 0;
  private phase = 0;
  private parts: PedParts | null = null;
  private prevYaw: number | null = null;
  private yawRate = 0;

  constructor(scene: THREE.Scene, world: World) {
    this.scene = scene;
    this.world = world;
    this.track = makeTrack(world);
    // editor overrides (public/intersection.json)
    if (world.config.pedLockBias !== undefined) this.params.lockBias = world.config.pedLockBias;
  }

  /**
   * Blind-mode spawn gate: true once the car has (nearly) finished turning AND the A-pillar sight line
   * lands on the crosswalk, i.e. the walker can appear exactly behind the pillar and stay there.
   * The act spawns when this is true (within `distance`), with a short-distance fallback.
   */
  hiddenSpawnReady(car: CarState): boolean {
    const tr = makeTrack(this.world);
    const sigma = sideOf(tr, car);
    const finalYaw = Math.atan2(sigma * tr.n.x, sigma * tr.n.z);
    if (Math.abs(wrapPi(finalYaw - car.yaw)) > this.params.headingTol) return false;
    const s = pillarRayS(tr, car, this.params.lockBias, this.params.maxWalkSpeed);
    return s !== null && s >= this.params.minS && s <= tr.len - 0.5;
  }

  /** Straight-line distance (m) from the car OBB's nearest corner to the crosswalk centreline (<=0: reached). */
  distanceToCrosswalkLine(car: CarState, world: World = this.world): number {
    const tr = makeTrack(world);
    return reach(tr, car, sideOf(tr, car));
  }

  /**
   * Distance (m) ALONG the reference left-turn path (nearest of cutCorner / viaCenter) from the car's
   * front bumper to the point where that path crosses the crosswalk centreline. Negative = already past.
   * This is what the act should compare with `distance` (default 8) to trigger spawnBlind().
   */
  distanceToCrosswalk(car: CarState, world: World = this.world): number {
    const tr = makeTrack(world);
    const sigma = 1; // paths run from the intersection side (+) toward the crosswalk
    let best: { lat: number; remain: number } | null = null;
    for (const kind of ['cutCorner', 'viaCenter'] as const) {
      const pts = world.leftTurnPath(kind);
      // arclength of every vertex and the crossing position
      const arc: number[] = [0];
      for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      let sCross: number | null = null;
      for (let i = 1; i < pts.length; i++) {
        const a = sigma * signedDist(tr, pts[i - 1]);
        const b = sigma * signedDist(tr, pts[i]);
        if (a > 0 && b <= 0) {
          sCross = arc[i - 1] + (arc[i] - arc[i - 1]) * (a / (a - b));
          break;
        }
      }
      if (sCross === null) continue;
      // nearest point on the polyline
      let nearLat = Infinity;
      let nearS = 0;
      for (let i = 1; i < pts.length; i++) {
        const ax = pts[i - 1].x, az = pts[i - 1].z;
        const bx = pts[i].x - ax, bz = pts[i].z - az;
        const l2 = bx * bx + bz * bz || 1;
        const t = clamp(((car.x - ax) * bx + (car.z - az) * bz) / l2, 0, 1);
        const lat = Math.hypot(car.x - (ax + bx * t), car.z - (az + bz * t));
        if (lat < nearLat) {
          nearLat = lat;
          nearS = arc[i - 1] + t * Math.sqrt(l2);
          if (i === 1 && t === 0) nearS = -lat; // before the path start: count the gap
        }
      }
      const remain = sCross - nearS - defaultCarParams.halfLength;
      if (!best || nearLat < best.lat) best = { lat: nearLat, remain };
    }
    return best ? best.remain : this.distanceToCrosswalkLine(car, world);
  }

  // ------------------------------------------------------------------ spawn
  spawnBlind(car: CarState, input: DriveInput, params?: Partial<BlindSpawnParams>): Pedestrian | null {
    void input; // the pillar lock reacts to the actual car every frame, no input prediction needed
    this.params = { ...this.params, ...(this.world.config.pedWalkSpeed ? { walkSpeed: this.world.config.pedWalkSpeed } : {}), ...params };
    this.clearPed();
    this.track = makeTrack(this.world);
    const tr = this.track;
    // start right on the pillar sight line (fallback: the usual front-left spawn)
    const sRay = pillarRayS(tr, car, this.params.lockBias, this.params.maxWalkSpeed);
    // beyond the south end -> wait at the kerb end of the crosswalk (clamped below)
    const s0 = sRay !== null ? sRay : aheadSpawn(this.world, car, this.world.config.pedBearingDeg ?? 25).s;
    this.plan = { active: true, committed: false };
    this.s = clamp(s0, this.params.minS, tr.len - 0.5);
    this.v = this.params.walkSpeed;
    this.walking = true;
    this.hit = false;
    this.frames = 0;
    this.insideFrames = 0;
    this.prevYaw = car.yaw;
    this.yawRate = 0;
    this.plannedBlindRatio = 0;
    this.makePed();
    this.syncPed();
    this.countFrame(car);
    return this.pedestrian;
  }

  /**
   * Trigger-based spawn: the pedestrian appears right now ON the crosswalk, front-left of the car
   * (about 25 deg to the left of its heading), and starts crossing. No timing estimate needed.
   */
  spawnAhead(car: CarState, world: World = this.world, bearingDeg?: number): Pedestrian {
    this.world = world;
    this.clearPed();
    this.track = makeTrack(world);
    const tr = this.track;
    const bestS = aheadSpawn(world, car, bearingDeg ?? world.config.pedBearingDeg ?? 25).s;
    this.plan = null;
    this.s = bestS;
    this.v = world.config.pedWalkSpeed ?? this.params.walkSpeed;
    this.walking = true;
    this.hit = false;
    this.frames = 0;
    this.insideFrames = 0;
    this.plannedBlindRatio = 0;
    this.prevYaw = car.yaw;
    this.makePed();
    this.syncPed();
    return this.pedestrian!;
  }

  /** Act 4: pedestrian already standing at the south end of the crosswalk, visible, waiting. Call walk() to go. */
  spawnEarly(car: CarState, world: World = this.world): Pedestrian {
    this.world = world;
    this.clearPed();
    this.track = makeTrack(world);
    this.plan = null;
    this.s = 1.2; // on the crosswalk, not on the pavement
    this.v = 0;
    this.walking = false;
    this.hit = false;
    this.frames = 0;
    this.insideFrames = 0;
    this.plannedBlindRatio = 0;
    this.makePed();
    this.syncPed();
    void car;
    return this.pedestrian!;
  }

  /** Start / resume plain walking (north) at speed (default walkSpeed). Cancels blind re-aiming. */
  walk(speed?: number): void {
    this.walking = true;
    this.v = speed ?? this.params.walkSpeed;
    if (this.plan) this.plan.active = false;
  }
  stopWalking(): void {
    this.walking = false;
    this.v = 0;
    if (this.plan) this.plan.active = false;
  }

  // ------------------------------------------------------------------ queries
  isInsideFan(car: CarState): boolean {
    if (!this.pedestrian) return false;
    const { err, half } = fanError(car, this.pedestrian.pos);
    return Math.abs(err) <= half;
  }

  /** Circle (ped) vs car OBB overlap. */
  hitTest(carObb: Obb): boolean {
    if (!this.pedestrian) return false;
    const p = this.pedestrian.pos;
    const dx = p.x - carObb.cx;
    const dz = p.z - carObb.cz;
    const s = Math.sin(carObb.yaw);
    const c = Math.cos(carObb.yaw);
    const lx = dx * c - dz * s;
    const lf = -dx * s - dz * c;
    const qx = clamp(lx, -carObb.hw, carObb.hw);
    const qf = clamp(lf, -carObb.hl, carObb.hl);
    const hit = Math.hypot(lx - qx, lf - qf) <= this.pedestrian.radius;
    if (hit) {
      this.hit = true;
      this.v = 0;
      this.walking = false;
      if (this.plan) this.plan.active = false;
      this.pedestrian.vel = { x: 0, z: 0 };
    }
    return hit;
  }

  // ------------------------------------------------------------------ update
  update(dt: number, car: CarState): void {
    if (!this.pedestrian || dt <= 0) return;
    // yaw-rate estimate (only the CarState is available here)
    if (this.prevYaw !== null) {
      const r = wrapPi(car.yaw - this.prevYaw) / dt;
      this.yawRate += (r - this.yawRate) * Math.min(1, dt * 10);
    }
    this.prevYaw = car.yaw;

    const plan = this.plan;
    if (plan && plan.active && !this.hit) {
      this.steerBlind(dt, car, plan);
      this.countFrame(car);
      // end of blind mode: car is past the crosswalk, or the walker reached the far end
      const sigma = sideOf(this.track, car);
      if (reach(this.track, car, sigma) < -1 || this.s >= this.track.len) {
        plan.active = false;
        this.v = this.params.walkSpeed;
      }
    }

    if (this.walking && !this.hit) {
      this.s += this.v * dt;
      if (this.plan?.active) this.s = Math.max(this.s, this.params.minS);
      const end = this.track.len + 2;
      if (this.s >= end) {
        this.s = end;
        this.walking = false;
        this.v = 0;
      }
    }
    this.syncPed();
    this.animate(dt);
  }

  /**
   * Blind mode speed control. Normally the pillar lock alone ends in a hit: holding a constant bearing
   * inside the pillar sector, the walker meets the car's LEFT FRONT FENDER (not the bumper) while
   * still hidden. Commit (step straight into the path) is only the fallback when he cannot keep up
   * with the lock point (fast car) or the car is already very close.
   */
  private steerBlind(dt: number, car: CarState, plan: BlindPlan): void {
    const P = this.params;
    const tr = this.track;
    const ped = trackPos(tr, this.s);
    const eye = aPillarFan(car).origin;
    const distEye = Math.hypot(ped.x - eye.x, ped.z - eye.z);
    const conflict = conflictAhead(tr, car);
    const ttc = conflict && car.speed > 0.3 ? conflict.dist / car.speed : Infinity;
    const sT = pillarRayS(tr, car, P.lockBias, P.maxWalkSpeed);
    // falling behind the lock point -> the fender will pass in front of him: commit just in time
    const lagging = sT !== null && sT - this.s > P.lagCommit;
    const stepTime = conflict ? Math.max(0, conflict.s - this.s) / P.commitMaxSpeed + P.commitMaxSpeed / P.accel / 2 : 0;
    if (!plan.committed && !aimPose(tr, car).turning && (distEye < P.commitDistance || (lagging && ttc < stepTime + 0.1))) plan.committed = true;

    let vWant: number;
    if (plan.committed) {
      if (conflict && Number.isFinite(ttc)) {
        const need = conflict.s - this.s;
        // arrive just as the bumper does; already in the path -> slow down and stay there
        vWant = need > 0 ? clamp(need / Math.max(ttc - 0.05, 0.12), P.walkSpeed * 0.6, P.commitMaxSpeed) : 0.2;
      } else {
        vWant = P.walkSpeed; // car stopped: just keep crossing
      }
    } else {
      if (sT === null) vWant = P.walkSpeed;
      else vWant = clamp((clamp(sT, P.minS, tr.len) - this.s) / P.lockLag, -P.maxBackSpeed, P.maxWalkSpeed);
    }
    const step = P.accel * dt;
    this.v += clamp(vWant - this.v, -step, step);
  }

  private countFrame(car: CarState): void {
    if (!this.pedestrian) return;
    const { err, half, dist } = fanError(car, this.pedestrian.pos);
    if (dist < this.params.exposeDistance) return;
    this.frames++;
    if (Math.abs(err) <= half) this.insideFrames++;
  }

  // ------------------------------------------------------------------ mesh plumbing
  private makePed(): void {
    const { root, parts } = createPedestrianMesh();
    this.scene.add(root);
    this.parts = parts;
    this.pedestrian = {
      pos: trackPos(this.track, this.s),
      vel: { x: 0, z: 0 },
      radius: PED_RADIUS,
      mesh: root,
    };
  }

  private syncPed(): void {
    const p = this.pedestrian;
    if (!p) return;
    p.pos = trackPos(this.track, this.s);
    const sp = this.walking && !this.hit ? this.v : 0;
    p.vel = { x: this.track.u.x * sp, z: this.track.u.z * sp };
    p.mesh.position.set(p.pos.x, 0, p.pos.z);
    p.mesh.rotation.y = Math.atan2(-this.track.u.x, -this.track.u.z);
  }

  private animate(dt: number): void {
    const p = this.pedestrian;
    if (!p || !this.parts) return;
    const sp = Math.hypot(p.vel.x, p.vel.z);
    if (sp > 0.05) {
      this.phase += dt * sp * 5.5;
      const sw = Math.sin(this.phase);
      this.parts.legL.rotation.x = sw * 0.6;
      this.parts.legR.rotation.x = -sw * 0.6;
      this.parts.body.position.y = Math.abs(sw) * 0.035;
      this.parts.body.rotation.z = sw * 0.03;
    } else {
      this.parts.legL.rotation.x = 0;
      this.parts.legR.rotation.x = 0;
      this.parts.body.position.y = 0;
      this.parts.body.rotation.z = 0;
    }
  }

  private clearPed(): void {
    if (this.pedestrian) {
      this.scene.remove(this.pedestrian.mesh);
      disposeObject(this.pedestrian.mesh);
    }
    this.pedestrian = null;
    this.parts = null;
    this.plan = null;
  }

  dispose(): void {
    this.clearPed();
  }
}

// ============================================================================
// Editor preview (shows where the walker appears for the current settings)
// ============================================================================
/** Car poses along a reference left-turn path, 0.1 m apart: 'cutCorner' (orange, act 2) or 'viaCenter' (red, act 4). */
function* pathPoses(world: World, kind: 'cutCorner' | 'viaCenter'): Generator<CarState> {
  const path = world.leftTurnPath(kind);
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k], b = path[k + 1];
    const ex = b.x - a.x, ez = b.z - a.z;
    const len = Math.hypot(ex, ez);
    if (len < 1e-6) continue;
    const yaw = Math.atan2(-ex, -ez);
    for (let t = 0; t < len; t += 0.1) yield { x: a.x + (ex * t) / len, z: a.z + (ez * t) / len, yaw, speed: 4, steer: 0 };
  }
}

export interface SpawnPreview {
  /** car pose at the moment of spawning (the pillar fan is taken from this actual pose) */
  car: CarState;
  eye: Vec2;
  ped: Vec2;
  /** bumper -> crosswalk distance along the turn path (m) */
  carDist: number;
  /** eye -> walker (m) */
  eyeDist: number;
  /** walker bearing left of the car's heading (deg) */
  bearingDeg: number;
  /** degrees the walker is OUTSIDE the pillar sector at spawn (0 = hidden behind it) */
  offDeg: number;
}

const bearingOf = (from: Vec2, yaw: number, to: Vec2): number => {
  const dx = to.x - from.x, dz = to.z - from.z;
  const fwd = dx * -Math.sin(yaw) + dz * -Math.cos(yaw);
  const left = dx * -Math.cos(yaw) + dz * Math.sin(yaw);
  return (Math.atan2(left, fwd) * 180) / Math.PI;
};

/** Act 2 bearing (deg left of the car's heading) at which the walker appears; defaults to the act-4 value. */
export const blindBearing = (world: World): number => world.config.pedBlindBearingDeg ?? world.config.pedBearingDeg ?? 25;

/** Act 2: same mechanism as act 4 - the walker appears at `pedBlindBearingDeg` once the bumper is within `pedSpawnDistance`. */
export function previewBlindSpawn(world: World): SpawnPreview | null {
  const sp = new PedestrianSpawner(new THREE.Scene(), world);
  const D = world.config.pedSpawnDistance ?? defaultBlindParams.distance;
  try {
    for (const car of pathPoses(world, 'cutCorner')) {
      const d = sp.distanceToCrosswalk(car);
      if (d > D) continue;
      const pos = aheadSpawn(world, car, blindBearing(world)).pos;
      const fan = aPillarFan(car);
      const eye = fan.origin;
      const bearing = bearingOf(eye, car.yaw, pos);
      const centreDeg = (A_PILLAR_LOCAL.centre * 180) / Math.PI; // pillar centre, left of the car's heading
      const offDeg = Math.max(0, Math.abs(bearing - centreDeg) - (fan.halfAngle * 180) / Math.PI);
      return { car, eye, ped: pos, carDist: d, eyeDist: Math.hypot(pos.x - eye.x, pos.z - eye.z), bearingDeg: bearing, offDeg };
    }
    return null;
  } finally {
    sp.dispose();
  }
}

/** Act 4: the walker appears at `pedBearingDeg` ahead-left once the bumper is within `pedEarlySpawnDistance`. */
export function previewEarlySpawn(world: World): { car: CarState; ped: Vec2; carDist: number; dist: number } | null {
  const sp = new PedestrianSpawner(new THREE.Scene(), world);
  const D = world.config.pedEarlySpawnDistance ?? defaultEarlySpawnDistance;
  try {
    for (const car of pathPoses(world, 'viaCenter')) {
      const d = sp.distanceToCrosswalk(car);
      if (d > D) continue;
      const a = aheadSpawn(world, car, world.config.pedBearingDeg ?? 25);
      return { car, ped: a.pos, carDist: d, dist: a.dist };
    }
    return null;
  } finally {
    sp.dispose();
  }
}

/** Act 4 spawn distance (m, bumper -> crosswalk along the turn path) when the editor has not set one. */
export const defaultEarlySpawnDistance = 6;

// ============================================================================
// Headless verification
// ============================================================================
interface ScriptedTrial {
  vApproach: number;
  zTurn: number; // car starts turning when z <= zTurn (larger = earlier / cut corner)
  d: number; // spawn distance
  vTurn: number;
}

/** Scripted left-turn driver: approach, turn (A), finish turn heading west, hold speed. */
function driverInput(c: CarState, tr: ScriptedTrial, turning: { v: boolean; done: boolean }): DriveInput {
  const target = Math.PI / 2;
  const inp: DriveInput = { w: false, a: false, s: false, d: false };
  if (!turning.v && c.z <= tr.zTurn) turning.v = true;
  const vWant = turning.v || c.z <= tr.zTurn + 10 ? tr.vTurn : tr.vApproach;
  inp.w = c.speed < vWant;
  inp.s = c.speed > vWant + 0.5;
  if (turning.v) {
    const e = target - c.yaw;
    if (!turning.done && e < 0.12) turning.done = true;
    if (!turning.done) inp.a = true;
    else {
      if (e > 0.06) inp.a = true;
      else if (e < -0.06) inp.d = true;
    }
  }
  return inp;
}

/**
 * Headless auto-test of the A-pillar scenario for varied left turns.
 * passRate: share of trials where the walker was >= 90% inside the fan (frames from spawn until impact
 * or until the car passed the crosswalk) AND a collision happened. avgBlindRatio: mean of the ratio.
 * hitRate: share of trials with a collision.
 */
export function simulateAutoTest(
  world: World,
  trials: number,
): { passRate: number; avgBlindRatio: number; hitRate: number } {
  const rows = runAutoTrials(world, trials);
  const n = rows.length;
  return {
    passRate: rows.filter((r) => r.hit && r.ratio >= 0.9).length / n,
    avgBlindRatio: rows.reduce((a, r) => a + r.ratio, 0) / n,
    hitRate: rows.filter((r) => r.hit).length / n,
  };
}

/** Per-trial detail of simulateAutoTest (for the dev panel / debugging). */
export function runAutoTrials(
  world: World,
  trials: number,
): { vApproach: number; vTurn: number; zTurn: number; d: number; ratio: number; hit: boolean }[] {
  const rows: { vApproach: number; vTurn: number; zTurn: number; d: number; ratio: number; hit: boolean }[] = [];
  const scene = new THREE.Scene();
  const sp = new PedestrianSpawner(scene, world);
  const vAppr = [6, 7, 8, 9];
  const zTurns = [6, 4, 2.2, 1, -0.5];
  const ds = [7, 8, 9];
  const vTurns = [2.2, 3, 4, 5.5];
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const n = Math.max(1, trials);
  for (let k = 0; k < n; k++) {
    const tr: ScriptedTrial = {
      vApproach: vAppr[k % vAppr.length] + (rnd() - 0.5) * 0.6,
      zTurn: zTurns[Math.floor(k / vAppr.length) % zTurns.length] + (rnd() - 0.5) * 1.0,
      d: ds[Math.floor(k / (vAppr.length * zTurns.length)) % ds.length],
      vTurn: vTurns[Math.floor(k / (vAppr.length * zTurns.length * ds.length)) % vTurns.length],
    };
    const cc = new CarController(defaultCarParams);
    cc.reset(lanes(world.config).nsInner, 45, 0, tr.vApproach);
    const turning = { v: false, done: false };
    let spawned = false;
    let hit = false;
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 40; i++) {
      const inp = driverInput(cc.state, tr, turning);
      if (!spawned && sp.distanceToCrosswalk(cc.state) <= tr.d) {
        spawned = true;
        sp.spawnBlind(cc.state, inp, { distance: tr.d });
        if (!sp.pedestrian) break;
      }
      cc.update(dt, inp);
      if (spawned) {
        sp.update(dt, cc.state);
        if (sp.hitTest(cc.obb())) {
          hit = true;
          break;
        }
        if (sp.distanceToCrosswalkLine(cc.state) < -8) break;
      }
    }
    const ratio = spawned && sp.pedestrian ? sp.blindRatio : 0;
    rows.push({ vApproach: tr.vApproach, vTurn: tr.vTurn, zTurn: tr.zTurn, d: tr.d, ratio, hit });
    sp.dispose();
  }
  return rows;
}
