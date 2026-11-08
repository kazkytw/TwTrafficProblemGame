// ============================================================================
// Shared contracts. Every module codes against these. Do NOT change a signature
// without telling the Tech Lead.
//
// WORLD COORDINATES (Three.js, y up, units = metres, ground = XZ plane)
//   North = -Z, South = +Z, East = +X, West = -X. Intersection centre = origin.
//   Right-hand traffic (Taiwan). Driver sits on the LEFT side of the car.
//   Player car starts far south, heading NORTH (-Z) in the northbound lane
//   (inner lane x = +nsHalfWidth/4), then turns LEFT to exit WEST (-X) in the westbound
//   lane (z = -ewHalfWidth/2). The N-S road has 4 lanes (2 per direction), the E-W
//   road 2 (1 per direction); see src/world/lanes.ts. Oncoming straight traffic goes
//   SOUTH (+Z) in the outer southbound lane. A car waiting to turn left from the north
//   arm sits in the box and basically never moves (it blocks the 路心).
//   The pedestrian of the story uses the WEST arm crosswalk (the one the player
//   exits through), walking NORTH from the south sidewalk (= driver's left-front,
//   hidden by the LEFT A-pillar).
//   yaw: rotation about +Y in radians. Heading vector of a yaw is
//   (-sin(yaw), -cos(yaw)) in (x,z); yaw = 0 means facing north (-Z), yaw = +PI/2
//   means facing west (-X) (counter-clockwise seen from above = left turn).
// ============================================================================
import type * as THREE from 'three';

export interface Vec2 {
  x: number;
  z: number;
}

/** Oriented bounding box on the ground plane. hw = half width (local X), hl = half length (local forward). */
export interface Obb {
  cx: number;
  cz: number;
  hw: number;
  hl: number;
  yaw: number;
}

export interface IntersectionConfig {
  nsHalfWidth: number; // North-South road: half width (m). 4 lanes (2 per direction), e.g. 6.8
  ewHalfWidth: number; // East-West road: half width (m). 2 lanes (1 per direction), narrower, e.g. 3.2
  armLength: number; // how far each arm extends from the centre, e.g. 70
  crosswalkWidth: number; // e.g. 4
  crosswalkSetback: number; // distance of crosswalk's near edge from the intersection box edge (m). Baseline 1.0
  curbRadius: number;
  // facility toggles (act 3 cards)
  island: boolean; // card 1: pedestrian refuge island on the west crosswalk (median of the west arm, baseline crosswalk position)
  crosswalkRetreat: boolean; // card 2: crosswalk pushed back (setback += crosswalkRetreatExtra)
  crosswalkRetreatExtra: number; // e.g. 5
  guideLine: boolean; // card 3: left-turn guide line to the intersection centre
  education: boolean; // card 4: education (no geometry; shows hint text in act 4)
  islandBox: { cx: number; cz: number; hw: number; hl: number; yaw: number }; // island footprint
  /** the oncoming left-turn car waiting in the box (editor-placeable). yaw PI = facing south */
  waitingCar?: { x: number; z: number; yaw: number };
  /** hitbox: when the player's car overlaps it the pedestrian appears on the crosswalk, front-left of the car */
  /** editor free-camera speed (saved with the rest of the editor settings) */
  editorCamSpeed?: number;
  /** pedestrian walking speed (m/s): the player's pedestrian in act 1 and the pedestrian NPC */
  pedWalkSpeed?: number;
  /** Act 2 (blind): the walker is spawned once the bumper is this far (m, along the turn path) from the crosswalk. Smaller = later and closer to the car. */
  pedSpawnDistance?: number;
  /** Act 2 (blind): where the walker is held inside the A-pillar sector. 0 = centre line, 1 = inner edge (nearest the car's path). */
  pedLockBias?: number;
  /** Act 2: bearing (deg, left of the car's heading) at which the walker appears. Falls back to pedBearingDeg. */
  pedBlindBearingDeg?: number;
  /** bearing (deg, left of the car's heading) at which the trigger-spawned pedestrian appears */
  pedBearingDeg?: number;
  /** Act 4: the walker appears once the bumper is this far (m, along the turn path) from the crosswalk. */
  pedEarlySpawnDistance?: number;
}

export type CameraMode = 'pedestrian' | 'driver' | 'overview' | 'free';

export interface CameraPose {
  pos: THREE.Vector3;
  lookAt: THREE.Vector3;
  fov: number;
  roll: number; // radians
}

// ----------------------------------------------------------------------------
// World (src/world) -- built from IntersectionConfig, rebuildable at runtime
// ----------------------------------------------------------------------------
export interface World {
  group: THREE.Group; // everything static lives here
  config: IntersectionConfig;
  rebuild(cfg: Partial<IntersectionConfig>): void; // dispose old meshes, rebuild
  /** Static obstacles (island, curbs/buildings) as OBBs. Island has tag 'island'. */
  obstacles: { box: Obb; tag: 'island' | 'building' | 'curb' | 'median' }[];
  /** Is point on drivable road surface (arms + intersection box)? */
  onRoad(p: Vec2): boolean;
  /** Crosswalk of the west arm: centreline from south end to north end, plus width. */
  westCrosswalk(): { south: Vec2; north: Vec2; width: number };
  /** Reference left-turn path for debug / act 3 (list of points) with or without island. */
  leftTurnPath(kind: 'cutCorner' | 'viaCenter' | 'act1Hit'): Vec2[];
  /** Pedestrian path of the story (west crosswalk, south -> north). */
  pedestrianPath(): Vec2[];
  setSignal(state: 'green' | 'red'): void;
  dispose(): void;
}

// ----------------------------------------------------------------------------
// Sim (src/sim)
// ----------------------------------------------------------------------------
export interface CarState {
  x: number;
  z: number;
  yaw: number;
  speed: number; // m/s, >= 0
  steer: number; // -1..1 smoothed (+ = left)
}

export interface DriveInput {
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
}

export interface CarParams {
  maxSpeed: number;
  accel: number;
  brake: number;
  drag: number;
  wheelBase: number;
  maxSteerRate: number; // rad of yaw-rate per second at full steer (speed-scaled)
  halfWidth: number; // OBB
  halfLength: number;
}

export interface Pedestrian {
  pos: Vec2;
  vel: Vec2;
  radius: number;
  mesh: THREE.Object3D;
}

export type CollisionKind = 'none' | 'oncoming' | 'median' | 'island' | 'islandWest' | 'wrongSide' | 'wrongWay' | 'offroad' | 'pedestrian';

// ----------------------------------------------------------------------------
// UI (src/ui)
// ----------------------------------------------------------------------------
export type SubtitleKind = 'narration' | 'pedestrian' | 'driver' | 'anchor';

export interface UI {
  /** Black screen, big centred white text. Resolves after it was shown for `holdMs` and faded out. */
  narration(text: string, holdMs?: number): Promise<void>;
  /** Bottom small subtitle with a role label. Resolves after hold. kind: pedestrian | driver | anchor */
  say(kind: Exclude<SubtitleKind, 'narration'>, text: string, holdMs?: number): Promise<void>;
  /** Big centred card (news headline / final fact). Fade in/out. */
  card(text: string, holdMs?: number): Promise<void>;
  /** News broadcast screen: headline banner + anchor subtitle at the bottom (one screen, no second step). */
  news(headline: string, anchorText: string, holdMs?: number): Promise<void>;
  /** Persistent hint, e.g. "按住 W 前進". Returns a disposer. */
  hint(text: string): () => void;
  fadeToBlack(ms?: number): Promise<void>;
  fadeFromBlack(ms?: number): Promise<void>;
  setBlack(on: boolean): void; // instant
  /** Rewind effect overlay (scanlines + tint + label) for ms. Resolves at end. */
  rewindOverlay(ms: number): Promise<void>;
  /** Act 3 cards. onPick(i) is called when card i is clicked first time. */
  showCards(cards: { title: string; desc: string; note: string }[], onPick: (i: number) => void): void;
  showPlayButton(onClick: () => void): void;
  hideCards(): void;
  /** Click-to-continue / title screen helper */
  waitForClick(label: string): Promise<void>;
  clearAll(): void;
}

export interface AudioFx {
  /** Must be called from a user gesture once. */
  unlock(): void;
  engineStart(opts?: { volume?: number }): void; // looped synthetic engine; rpm updated via setEngine
  setEngine(speed01: number): void;
  engineStop(): void;
  impact(): void; // loud crash, peaks high
  cutOff(): void; // everything abruptly silent
  rewind(ms: number): void;
  beep(): void; // news jingle placeholder
  bump(): void; // low speed bump (island)
  horn(): void;
  setMasterVolume(v: number): void;
}

// ----------------------------------------------------------------------------
// Input / Camera / Game context
// ----------------------------------------------------------------------------
export interface InputState {
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
  /** true while any of WASD pressed */
  any: boolean;
  /** key code -> pressed */
  down(code: string): boolean;
}

export interface CameraRig {
  camera: THREE.PerspectiveCamera;
  mode: CameraMode;
  setMode(mode: CameraMode): void;
  /** Instantly set pose. */
  set(pose: Partial<CameraPose>): void;
  /** Tween to pose over ms (ease in-out). */
  tweenTo(pose: Partial<CameraPose>, ms: number): Promise<void>;
  /** Play pose keyframes (used for crash fling). t in ms. */
  playKeyframes(frames: { t: number; pose: Partial<CameraPose> }[]): Promise<void>;
  /** Driver eye pose attached to a car state; call each frame in driver mode. */
  followDriver(car: CarState, eye: DriverEye): void;
  /** Pedestrian eye pose. */
  followPedestrian(pos: Vec2, yaw: number, pitch?: number): void;
  readonly eyeHeight: { pedestrian: number; driver: number };
}

export interface DriverEye {
  /** eye offset from car centre, in car-local space (x right, y up, z forward negative back?) -> use: right, up, forward */
  right: number;
  up: number;
  forward: number;
  /** camera pitch in degrees (+ = look up). default 0 */
  pitchDeg?: number;
  /** vertical field of view in degrees. default 75 */
  fov?: number;
}

export interface GameContext {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  rig: CameraRig;
  input: InputState;
  ui: UI;
  audio: AudioFx;
  world: World;
  /** Registers a per-frame updater; returns a remover. Updaters run before render. */
  onUpdate(fn: (dt: number) => void): () => void;
  /** Resolves after ms of game time. */
  wait(ms: number): Promise<void>;
  /** Resolves when predicate becomes true (checked every frame). */
  until(pred: () => boolean): Promise<void>;
  debug: { enabled: boolean };
  debugDraw?: import('./dev/DebugDraw').DebugDraw;
}

export interface Act {
  id: 'act1' | 'act2' | 'act3' | 'act4' | 'act5';
  /** Runs the whole act as an async script. Resolves when the act is finished and the game should go on. */
  run(ctx: GameContext, shared: SharedState): Promise<void>;
}

/** State carried between acts. */
export interface SharedState {
  cards: { island: boolean; crosswalkRetreat: boolean; guideLine: boolean; education: boolean };
}
