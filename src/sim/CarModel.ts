import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { A_PILLAR_LOCAL, DRIVER_EYE } from './CarMesh';

/**
 * The player's car: Kenney Car Kit "sedan" (CC0, public/models/sedan.glb).
 *
 * The first-person view sits INSIDE this body. Its glass is opaque in the source colour map, so a
 * shader discards the glass-coloured texels (see makeGlassTransparent). The left A-pillar blind
 * sector is MEASURED from the mesh by ray casting from the eye, then written into A_PILLAR_LOCAL
 * and DRIVER_EYE (the objects every other module already reads), so the pillar you see and the
 * sector the pedestrian spawner hides in can never disagree.
 *
 * Model space: faces +Z, driver (left) is +X. The wrapper group is rotated PI so that car yaw 0
 * faces north (-Z) like the rest of the game, and scaled to the game's car box (about 1.9 x 4.6 m).
 */
export const CAR_SCALE = new THREE.Vector3(1.25, 1.25, 1.8);

let template: THREE.Group | null = null;
let measuredRoot: THREE.Group | null = null;
let measuredBody: THREE.Mesh | null = null;
/** Last measured pillar bearings in degrees (for the editor). */
export const pillarInfo = { minDeg: 0, maxDeg: 0 };

const isGlass = (r: number, g: number, b: number) => b > 0.88 && g > 0.82 && r > 0.7;

function makeGlassTransparent(body: THREE.Mesh) {
  const m = (body.material as THREE.MeshStandardMaterial).clone();
  m.side = THREE.DoubleSide;
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       if (diffuseColor.b > 0.88 && diffuseColor.g > 0.82 && diffuseColor.r > 0.7) discard;`,
    );
  };
  body.material = m;
  return m;
}

/** Reads the colour-map texel under a ray hit, to ignore hits on glass. */
function makeTexelReader(mesh: THREE.Mesh) {
  const map = (mesh.material as THREE.MeshStandardMaterial).map;
  const img = map?.image as CanvasImageSource & { width: number; height: number } | undefined;
  if (!map || !img) return () => false;
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  const cx = cv.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(img, 0, 0);
  return (uv: THREE.Vector2) => {
    const x = Math.min(cv.width - 1, Math.max(0, Math.floor(uv.x * cv.width)));
    // glTF textures are not flipped: uv origin top-left in the image
    const y = Math.min(cv.height - 1, Math.max(0, Math.floor(uv.y * cv.height)));
    const d = cx.getImageData(x, y, 1, 1).data;
    return isGlass(d[0] / 255, d[1] / 255, d[2] / 255);
  };
}

/** Heights (m above ground) that must all be hidden: feet, waist, head of the pedestrian. */
const PED_HIDE_HEIGHTS = [0.1, 0.9, 1.65];
/** Typical horizontal eye-to-pedestrian distance (m) used to turn those heights into view angles. */
const PED_HIDE_DIST = 6;

/** Measure the bearing range (rad, left positive, rel. to heading) that fully hides a standing person behind the left A-pillar. */
function measureLeftPillar(root: THREE.Group, body: THREE.Mesh, eye: THREE.Vector3) {
  root.updateMatrixWorld(true);
  const glassHit = makeTexelReader(body);
  const ray = new THREE.Raycaster();
  ray.far = 4;
  const blocked: boolean[] = [];
  const step = 0.25; // degrees
  const max = 100;
  for (let a = 0; a <= max; a += step) {
    const th = (a * Math.PI) / 180;
    // The pillar is raked (it covers more to the right further down), so a ray at eye height alone
    // overstates what hides a standing person. A bearing counts as blocked only if the rays to his
    // feet, waist and head ALL hit the pillar, i.e. the whole body is hidden.
    let hit = true;
    for (const h of PED_HIDE_HEIGHTS) {
      // bearing left of forward; car-local forward = -Z, left = -X
      const dir = new THREE.Vector3(-Math.sin(th) * PED_HIDE_DIST, h - eye.y, -Math.cos(th) * PED_HIDE_DIST).normalize();
      ray.set(eye, dir);
      const hits = ray.intersectObject(body, false);
      if (!hits.some((x) => x.uv && !glassHit(x.uv))) {
        hit = false;
        break;
      }
    }
    blocked.push(hit);
  }
  // first blocked run after the windscreen = the A-pillar
  let i = 0;
  while (i < blocked.length && !blocked[i]) i++;
  // skip any very-near-straight-ahead artefact (< 3 deg) by requiring the run to start later
  while (i < blocked.length && (i * step < 3) && blocked[i]) i++;
  while (i < blocked.length && !blocked[i]) i++;
  const start = i;
  while (i < blocked.length && blocked[i]) i++;
  const end = i - 1;
  if (start >= blocked.length) return null;
  const min = (start * step * Math.PI) / 180;
  const maxA = (end * step * Math.PI) / 180;
  return { min, max: maxA };
}

/** Re-measure the left A-pillar from the current DRIVER_EYE and publish it to A_PILLAR_LOCAL. */
export function remeasurePillar(): void {
  if (!measuredRoot || !measuredBody) return;
  const eye = new THREE.Vector3(DRIVER_EYE.right, DRIVER_EYE.up, -DRIVER_EYE.forward);
  const m = measureLeftPillar(measuredRoot, measuredBody, eye);
  if (!m) return;
  A_PILLAR_LOCAL.centre = (m.min + m.max) / 2;
  A_PILLAR_LOCAL.halfAngle = (m.max - m.min) / 2;
  pillarInfo.minDeg = (m.min * 180) / Math.PI;
  pillarInfo.maxDeg = (m.max * 180) / Math.PI;
}

/** Default eye (car-local metres) used when nothing was saved from the editor. */
export const DEFAULT_EYE = { right: -0.32, up: 1.2, forward: 0.3, pitchDeg: 0, fov: 75 };

/**
 * Load once at startup. `savedEye` = values saved by the editor (public/driver-eye.json).
 * Resolves true when the model is in use, false on fallback to the greybox.
 */
export async function loadPlayerCar(savedEye?: Partial<typeof DEFAULT_EYE>, savedMirror?: Partial<typeof SIDE_MIRROR>): Promise<boolean> {
  if (savedMirror) Object.assign(SIDE_MIRROR, savedMirror);
  try {
    const gltf = await new GLTFLoader().loadAsync(import.meta.env.BASE_URL + 'models/sedan.glb');
    const inner = gltf.scene;
    let body: THREE.Mesh | null = null;
    inner.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name === 'body') body = o as THREE.Mesh;
    });
    if (!body) return false;
    makeGlassTransparent(body);
    // car-local frame: rotate the model to face -Z, scale to game size
    const root = new THREE.Group();
    inner.rotation.y = Math.PI;
    root.add(inner);
    root.scale.copy(CAR_SCALE);
    measuredRoot = root;
    measuredBody = body;
    Object.assign(DRIVER_EYE, DEFAULT_EYE, savedEye ?? {});
    remeasurePillar();
    console.info('[CarModel] left A-pillar', pillarInfo.minDeg.toFixed(1), '..', pillarInfo.maxDeg.toFixed(1), 'deg');
    template = root;
    return true;
  } catch (e) {
    console.warn('[CarModel] failed to load, using greybox cockpit', e);
    return false;
  }
}

/** Left door mirror position (car-local m): outside the door at the foot of the A-pillar, driver side = -X. */
export const SIDE_MIRROR = { x: -1.07, y: 1.03, z: -1.0, size: 1, show: true };
/** Mirrors of every car created so far, so the editor can move them live. */
const mirrors = new Set<WeakRef<THREE.Group>>();
function applyMirror(g: THREE.Group) {
  g.position.set(SIDE_MIRROR.x, SIDE_MIRROR.y, SIDE_MIRROR.z);
  g.scale.setScalar(SIDE_MIRROR.size);
  g.visible = SIDE_MIRROR.show;
}
/** Re-applies SIDE_MIRROR (position / size / visibility) to all existing cars. */
export function refreshMirrors(): void {
  for (const ref of mirrors) {
    const g = ref.deref();
    if (g) applyMirror(g);
    else mirrors.delete(ref);
  }
}

/** Door mirror (housing + arm + glass facing the driver). Pure scenery: it does not change the measured pillar sector. */
const mirrorShell = new THREE.MeshLambertMaterial({ color: 0x1d2127 });
const mirrorGlass = new THREE.MeshLambertMaterial({ color: 0x8fa3b3, side: THREE.DoubleSide });
const mirrorGeo = {
  housing: new THREE.BoxGeometry(0.08, 0.15, 0.24),
  face: new THREE.PlaneGeometry(0.2, 0.12),
  arm: new THREE.BoxGeometry(0.16, 0.035, 0.05),
};

function makeSideMirror(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'side-mirror-left';
  const shell = mirrorShell;
  g.add(new THREE.Mesh(mirrorGeo.housing, shell));
  const face = new THREE.Mesh(mirrorGeo.face, mirrorGlass); // faces the rear = toward the driver
  face.position.set(0, 0, 0.122);
  g.add(face);
  const arm = new THREE.Mesh(mirrorGeo.arm, shell);
  arm.position.set(0.11, -0.04, 0.02); // toward the door (+X)
  g.add(arm);
  applyMirror(g);
  mirrors.add(new WeakRef(g));
  return g;
}

/** A fresh copy of the loaded car (shares geometry + materials). Null when the model is not loaded. */
export function createPlayerCar(): THREE.Group | null {
  if (!template) return null;
  const wrap = new THREE.Group();
  wrap.name = 'player-car';
  const g = template.clone(true); // scaled body; mirrors live outside this group so they keep their real size
  g.name = 'player-car-body';
  wrap.add(g, makeSideMirror());
  return wrap;
}
