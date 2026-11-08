import * as THREE from 'three';
import type { CarState, DriverEye, Vec2 } from '../types';

// ============================================================================
// Car body (greybox). Origin = ground centre, front toward local -Z (yaw 0 faces north).
// Geometry/materials are shared & cached: do NOT dispose them when removing a car.
// ============================================================================
const geoCache = new Map<string, THREE.BufferGeometry>();
const matCache = new Map<number, THREE.MeshLambertMaterial>();

function box(w: number, h: number, d: number): THREE.BufferGeometry {
  const k = `b${w},${h},${d}`;
  let g = geoCache.get(k);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    geoCache.set(k, g);
  }
  return g;
}
function wheelGeo(): THREE.BufferGeometry {
  let g = geoCache.get('wheel');
  if (!g) {
    g = new THREE.CylinderGeometry(0.32, 0.32, 0.22, 12);
    g.rotateZ(Math.PI / 2);
    geoCache.set('wheel', g);
  }
  return g;
}
function mat(color: number): THREE.MeshLambertMaterial {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    matCache.set(color, m);
  }
  return m;
}
function part(g: THREE.BufferGeometry, color: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(g, mat(color));
  m.position.set(x, y, z);
  return m;
}

export function createCarMesh(opts?: { color?: number }): THREE.Group {
  const color = opts?.color ?? 0x3a6ea5;
  const g = new THREE.Group();
  g.name = 'car';
  g.userData.sharedResources = true;
  // lower body 1.8 x 0.6 x 4.4 (y 0.25..0.85)
  g.add(part(box(1.8, 0.6, 4.4), color, 0, 0.55, 0));
  // glass greenhouse 1.6 x 0.5 x 2.2, centred slightly behind middle
  g.add(part(box(1.62, 0.5, 2.2), 0x1b2430, 0, 1.1, 0.2));
  // roof slab
  g.add(part(box(1.5, 0.06, 1.9), color, 0, 1.38, 0.2));
  // wheels
  for (const sx of [-0.88, 0.88]) {
    for (const sz of [-1.4, 1.4]) g.add(part(wheelGeo(), 0x15171a, sx, 0.32, sz));
  }
  // lights
  for (const sx of [-0.6, 0.6]) {
    g.add(part(box(0.35, 0.14, 0.05), 0xfff2c0, sx, 0.62, -2.21));
    g.add(part(box(0.35, 0.14, 0.05), 0xc02020, sx, 0.62, 2.21));
  }
  return g;
}

// ============================================================================
// Driver eye + cockpit
//
// DriverEye convention (matches CameraRig.followDriver): offsets from the CAR CENTRE in
// car-local axes. right>0 = toward the car's right side, so the driver sitting on the LEFT has
// right < 0. up = metres above ground. forward>0 = toward the car's front (heading).
// World eye = (x,z) + right*(cos yaw, -sin yaw) + forward*(-sin yaw, -cos yaw), y = up.
// The camera is assumed to look exactly along the car heading (no head turn).
// ============================================================================
export const DRIVER_EYE: DriverEye = { right: -0.35, up: 1.15, forward: 0.0 };

/** Camera-local cockpit geometry (camera looks along -Z, +X right, +Y up). Single source of truth. */
export const COCKPIT = {
  /** Left A-pillar: centre-line bottom/top points (camera-local metres) and cross-section. */
  leftPillar: { bottom: [-0.62, -0.3, -1.05], top: [-0.45, 0.28, -0.62], width: 0.3, thick: 0.1 },
  rightPillar: { bottom: [1.05, -0.3, -1.15], top: [0.9, 0.28, -0.75], width: 0.3, thick: 0.1 },
};

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

interface PillarDef {
  bottom: number[];
  top: number[];
  width: number;
  thick: number;
}
/** Orthonormal frame of a pillar box: width axis is horizontal and perpendicular to the sight line. */
function pillarFrame(p: PillarDef) {
  const B = p.bottom as V3;
  const T = p.top as V3;
  const zA = norm(sub(T, B));
  // point of the centre-line at eye level (y=0)
  const t0 = -B[1] / (T[1] - B[1]);
  const P0: V3 = [B[0] + (T[0] - B[0]) * t0, 0, B[2] + (T[2] - B[2]) * t0];
  const hp: V3 = norm([-P0[2], 0, P0[0]]); // horizontal perpendicular to sight line
  const k = dot(hp, zA);
  const xA = norm([hp[0] - k * zA[0], hp[1] - k * zA[1], hp[2] - k * zA[2]]);
  const yA = cross(zA, xA);
  return { B, T, zA, xA, yA };
}

/** Bearing (rad, left of straight-ahead is +) range occluded at eye level by a pillar. */
function pillarBearings(p: PillarDef): { min: number; max: number } {
  const f = pillarFrame(p);
  let mn = Infinity;
  let mx = -Infinity;
  for (const ox of [-0.5, 0.5]) {
    for (const oy of [-0.5, 0.5]) {
      const c: V3 = [
        f.B[0] + f.xA[0] * ox * p.width + f.yA[0] * oy * p.thick,
        f.B[1] + f.xA[1] * ox * p.width + f.yA[1] * oy * p.thick,
        f.B[2] + f.xA[2] * ox * p.width + f.yA[2] * oy * p.thick,
      ];
      const t = -c[1] / f.zA[1]; // where this edge line crosses eye height y=0
      const px = c[0] + f.zA[0] * t;
      const pz = c[2] + f.zA[2] * t;
      const th = Math.atan2(-px, -pz); // left positive
      mn = Math.min(mn, th);
      mx = Math.max(mx, th);
    }
  }
  return { min: mn, max: mx };
}

const LEFT_BEARINGS = pillarBearings(COCKPIT.leftPillar);
/** Bearing of the left pillar centre and half-angle relative to car heading (rad), for debug/UI. */
export const A_PILLAR_LOCAL = {
  centre: (LEFT_BEARINGS.min + LEFT_BEARINGS.max) / 2,
  halfAngle: (LEFT_BEARINGS.max - LEFT_BEARINGS.min) / 2,
};

export function driverEyeWorld(car: CarState, eye: DriverEye = DRIVER_EYE): Vec2 {
  const s = Math.sin(car.yaw);
  const c = Math.cos(car.yaw);
  return {
    x: car.x + eye.right * c + eye.forward * -s,
    z: car.z + eye.right * -s + eye.forward * -c,
  };
}

/**
 * Horizontal sector (as seen from the driver's eye, at eye height) occluded by the LEFT A-pillar.
 * origin: world eye XZ. yawCentre: absolute world yaw of the sector centre (same convention as
 * CarState.yaw; a sight line at world yaw w goes in direction (-sin w, -cos w)). halfAngle in rad.
 * The pillar bearing is measured relative to the car heading (eye.right/forward only move the origin).
 */
export function aPillarFan(
  car: CarState,
  eye: DriverEye = DRIVER_EYE,
): { origin: Vec2; yawCentre: number; halfAngle: number } {
  return {
    origin: driverEyeWorld(car, eye),
    yawCentre: car.yaw + A_PILLAR_LOCAL.centre,
    halfAngle: A_PILLAR_LOCAL.halfAngle,
  };
}

function pillarMesh(p: PillarDef, color: number): THREE.Mesh {
  const f = pillarFrame(p);
  const len = Math.hypot(f.T[0] - f.B[0], f.T[1] - f.B[1], f.T[2] - f.B[2]);
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(p.width, p.thick, len),
    new THREE.MeshBasicMaterial({ color }),
  );
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...f.xA),
    new THREE.Vector3(...f.yA),
    new THREE.Vector3(...f.zA),
  );
  m.quaternion.setFromRotationMatrix(basis);
  m.position.set((f.B[0] + f.T[0]) / 2, (f.B[1] + f.T[1]) / 2, (f.B[2] + f.T[2]) / 2);
  return m;
}

/**
 * First-person interior frame. Attach to the camera (camera.add(cockpit)); camera-local space.
 * Eye is at the origin. Nearest geometry is ~0.4 m away: keep camera.near <= 0.1.
 */
export function createCockpit(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'cockpit';
  const dark = 0x1d2127;
  const mid = 0x2b3038;
  const add = (w: number, h: number, d: number, color: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }));
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  // dashboard (top surface ~0.36 m below the eye) + cowl
  add(2.2, 0.3, 0.75, mid, 0.35, -0.55, -0.95);
  add(2.2, 0.06, 0.2, dark, 0.35, -0.38, -1.25);
  // instrument hood
  add(0.5, 0.12, 0.3, dark, 0, -0.36, -0.75);
  // steering wheel (ring) in front of driver, tilted toward the eye
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.018, 6, 20), new THREE.MeshBasicMaterial({ color: 0x0e0f11 }));
  wheel.position.set(0, -0.45, -0.55);
  wheel.rotation.x = -1.1;
  g.add(wheel);
  // roof header strip + rear-view mirror
  // A-pillars
  g.add(pillarMesh(COCKPIT.leftPillar, dark));
  g.add(pillarMesh(COCKPIT.rightPillar, dark));
  // side window frames: door beltline + upper rail (left and right)
  add(0.08, 0.16, 1.5, dark, -0.78, -0.36, -0.05);
  add(0.08, 0.16, 1.5, dark, 1.2, -0.36, -0.05);
  add(0.06, 0.06, 1.2, dark, -0.62, 0.36, -0.1);
  add(0.06, 0.06, 1.2, dark, 1.05, 0.36, -0.1);
  // B-pillar stubs behind the driver (only visible when looking back/sideways)
  add(0.1, 0.8, 0.25, dark, -0.78, 0.0, 0.55);
  add(0.1, 0.8, 0.25, dark, 1.2, 0.0, 0.55);
  g.traverse((o) => {
    o.renderOrder = 10;
  });
  return g;
}
