import * as THREE from 'three';
import type { IntersectionConfig, Obb, Vec2, World } from '../types';
import defaultConfig from '../config/intersection.json';
import { lanes } from './lanes';
import { drawBottom, drawTop } from './pedLed';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const SIDEWALK_H = 0.15;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Effective west-crosswalk setback (baseline, or baseline + extra when retreated). */
function westSetback(c: IntersectionConfig): number {
  return c.crosswalkSetback + (c.crosswalkRetreat ? c.crosswalkRetreatExtra : 0);
}

/**
 * Refuge islands on all four arms, at the baseline (un-retreated) crosswalk position. The editable
 * islandBox is the WEST one; the east one mirrors it, north/south are derived (long axis along the road).
 */
function allIslands(c: IntersectionConfig): { cx: number; cz: number; hw: number; hl: number; yaw: number }[] {
  const w = c.islandBox;
  const d = Math.abs(w.cx) - c.nsHalfWidth; // west island centre distance from the N-S road edge
  const dz = c.ewHalfWidth + Math.max(0.5, d);
  return [
    w,
    { ...w, cx: -w.cx, cz: -w.cz },
    { cx: 0, cz: dz, hw: w.hw, hl: w.hl, yaw: 0 },
    { cx: 0, cz: -dz, hw: w.hw, hl: w.hl, yaw: 0 },
  ];
}

function quadBezier(p0: Vec2, c: Vec2, p2: Vec2, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
    out.push({ x: a * p0.x + b * c.x + d * p2.x, z: a * p0.z + b * c.z + d * p2.z });
  }
  return out;
}

/**
 * Create the static greybox world (road cross, sidewalks, markings, crosswalks, lights, buildings,
 * optional refuge island and left-turn guide line). Coordinates: see src/types.ts.
 */
export function createWorld(cfg?: Partial<IntersectionConfig>): World {
  const group = new THREE.Group();
  group.name = 'World';
  let signal: 'green' | 'red' = 'green';
  let lamps: { ns: boolean; green: THREE.MeshStandardMaterial; red: THREE.MeshStandardMaterial }[] = [];
  let mats = new Map<string, THREE.Material>();
  let texes: THREE.Texture[] = [];
  /** LED pedestrian heads: one shared top / bottom canvas per signal group (ns = goes with N-S traffic). */
  type Panel = { g: CanvasRenderingContext2D; tex: THREE.CanvasTexture; mat: THREE.MeshBasicMaterial };
  let pedPanels: { ns: boolean; top: Panel; bottom: Panel }[] = [];
  const pedClock = new Map<boolean, { walk: boolean; frame: number; ticks: number }>([
    [true, { walk: false, frame: 0, ticks: 0 }],
    [false, { walk: false, frame: 0, ticks: 0 }],
  ]);
  const PED_N = 128;

  const obstacles: World['obstacles'] = [];

  function mat(color: number): THREE.MeshLambertMaterial {
    const k = 'l' + color;
    let m = mats.get(k);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color });
      mats.set(k, m);
    }
    return m as THREE.MeshLambertMaterial;
  }

  function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, yaw = 0): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
    m.position.set(x, y, z);
    m.rotation.y = yaw;
    group.add(m);
    return m;
  }

  /** Flat painted line of width w following a polyline of world (x, z) points, lying at height y. */
  function ribbon(pts: THREE.Vector2[], w: number, y: number, color: number): void {
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const t = new THREE.Vector2().subVectors(b, a).normalize();
      const nx = -t.y * (w / 2), nz = t.x * (w / 2);
      pos.push(pts[i].x + nx, y, pts[i].y + nz, pts[i].x - nx, y, pts[i].y - nz);
      if (i > 0) {
        const k = 2 * i;
        idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat(color));
    m.material.side = THREE.DoubleSide;
    group.add(m);
  }

  /**
   * Slab with a semicircular nose on the end facing the junction centre and a square tail on the end
   * facing the median. Long axis along local Z, rotated by yaw like box().
   */
  function capsule(hw: number, hl: number, h: number, y0: number, color: number, x: number, z: number, yaw: number): void {
    const r = hw;
    const k = Math.max(0, hl - r);
    // which local-Z end points to the junction centre?
    const toward = Math.sin(yaw) * -x + Math.cos(yaw) * -z >= 0 ? -1 : 1; // shape y maps to world -z after rotateX
    const sh = new THREE.Shape();
    sh.moveTo(r, -hl * toward);
    sh.lineTo(r, k * toward);
    sh.absarc(0, k * toward, r, 0, Math.PI * toward, toward < 0);
    sh.lineTo(-r, -hl * toward);
    sh.closePath();
    const geo = new THREE.ExtrudeGeometry(sh, { depth: h, bevelEnabled: false, curveSegments: 16 });
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat(color));
    m.position.set(x, y0, z);
    m.rotation.y = yaw;
    group.add(m);
  }

  function disposeAll(): void {
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const m of mats.values()) m.dispose();
    for (const l of lamps) { l.green.dispose(); l.red.dispose(); }
    for (const t of texes) t.dispose();
    texes = [];
    for (const p of pedPanels) for (const q of [p.top, p.bottom]) { q.tex.dispose(); q.mat.dispose(); }
    pedPanels = [];
    mats = new Map();
    while (group.children.length) group.remove(group.children[0]);
    lamps = [];
    obstacles.length = 0;
  }

  /** Advance the walker animation by dt seconds and repaint the LED panels. */
  function updatePeds(dt: number): void {
    for (const [ns, st] of pedClock) {
      const walk = ns ? signal === 'green' : signal === 'red';
      if (walk && !st.walk) { st.frame = 0; st.ticks = 0; }
      st.walk = walk;
      if (walk && dt > 0 && ++st.ticks >= 2) { st.ticks = 0; st.frame++; } // step every 0.5 s
    }
    for (const p of pedPanels) {
      const st = pedClock.get(p.ns)!;
      drawTop(p.top.g, PED_N, st.walk);
      drawBottom(p.bottom.g, PED_N, st.walk, st.frame);
      p.top.tex.needsUpdate = true;
      p.bottom.tex.needsUpdate = true;
    }
  }

  function pedPanel(): Panel {
    const cv = document.createElement('canvas');
    cv.width = cv.height = PED_N;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { g: cv.getContext('2d')!, tex, mat: new THREE.MeshBasicMaterial({ map: tex }) };
  }

  function pedPanelsFor(ns: boolean): { top: Panel; bottom: Panel } {
    let p = pedPanels.find((q) => q.ns === ns);
    if (!p) {
      p = { ns, top: pedPanel(), bottom: pedPanel() };
      pedPanels.push(p);
    }
    return p;
  }

  function applySignal(): void {
    updatePeds(0);
    for (const l of lamps) {
      const g = l.ns ? signal === 'green' : signal === 'red'; // E-W is opposite of N-S
      l.green.emissiveIntensity = g ? 2.2 : 0;
      l.green.color.setHex(g ? 0x22ff66 : 0x0a2a14);
      l.red.emissiveIntensity = g ? 0 : 2.2;
      l.red.color.setHex(g ? 0x2a0a0a : 0xff2222);
    }
  }

  /**
   * A vehicle signal head at (x, y, z) facing `facing`, added to the lamp list.
   * Horizontal (Taiwan style): green | yellow | red from the viewer's left to right.
   */
  function lightHead(x: number, y: number, z: number, facing: number, ns: boolean): void {
    const head = new THREE.Group();
    head.position.set(x, y, z);
    head.rotation.y = facing; // local +Z -> (sin f, cos f); a viewer in front sees local +X on their right
    const lr = 0.18;
    head.add(new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.5, 0.35), mat(0x222428)));
    const lamp = (m: THREE.Material, lx: number) => {
      const l = new THREE.Mesh(new THREE.CylinderGeometry(lr, lr, 0.1, 20), m);
      l.rotation.x = Math.PI / 2; // axis along Z
      l.position.set(lx, 0, 0.19);
      head.add(l);
    };
    const glow = (hex: number) => new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 0 });
    const green = glow(0x22ff66), red = glow(0xff2222);
    lamp(green, -0.42);
    lamp(mat(0x3a2a08), 0); // unlit yellow
    lamp(red, 0.42);
    lamps.push({ ns, green, red });
    group.add(head);
  }

  /**
   * Vehicle signal on a median nose (Taiwan style): one pole on the median with a horizontal mast arm
   * reaching out to BOTH sides. (ax, az) = unit direction toward the approaching lanes; that head faces
   * `facing`. The other end hangs over the departing lanes with its head turned around, for the traffic
   * approaching from across the junction.
   */
  function vehicleSignal(x: number, z: number, facing: number, ns: boolean, ax: number, az: number, armLen: number): void {
    const H = 6.0;
    box(0.28, H, 0.28, x, H / 2, z, 0x555a60);
    // heads sit ON the arm (in line with it, arm entering the head's inner end), not hanging below it
    const ay = H - 0.3;
    const span = 2 * (armLen - 0.55); // arm stops just inside each head
    box(Math.abs(ax) * span + 0.16, 0.16, Math.abs(az) * span + 0.16, x, ay, z, 0x555a60);
    lightHead(x + ax * armLen, ay, z + az * armLen, facing, ns);
    lightHead(x - ax * armLen, ay, z - az * armLen, facing + Math.PI, ns);
  }

  /** Canvas-drawn texture (cached per build in `mats` via the returned material's key). */
  function canvasMat(key: string, size: number, draw: (g: CanvasRenderingContext2D, n: number) => void, transparent = false): THREE.MeshLambertMaterial {
    const k = 'c:' + key;
    let m = mats.get(k) as THREE.MeshLambertMaterial | undefined;
    if (!m) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      draw(cv.getContext('2d')!, size);
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      texes.push(t);
      m = new THREE.MeshLambertMaterial({ map: t, transparent, alphaTest: transparent ? 0.5 : 0 });
      mats.set(k, m);
    }
    return m;
  }

  /** Black / yellow diagonal hazard stripes. */
  function stripeMat(): THREE.MeshLambertMaterial {
    return canvasMat('stripe', 128, (g, n) => {
      g.fillStyle = '#f2c21b';
      g.fillRect(0, 0, n, n);
      g.fillStyle = '#151515';
      for (let i = -n; i < 2 * n; i += n / 2) {
        g.beginPath();
        g.moveTo(i, 0); g.lineTo(i + n / 4, 0); g.lineTo(i + n / 4 - n, n); g.lineTo(i - n, n);
        g.closePath();
        g.fill();
      }
    });
  }

  /**
   * "Keep right" assembly on an island end (Taiwan style): striped curb block with reflector studs, a
   * black / yellow striped post, an orange-dot delineator diamond and a blue round sign with a white
   * down-right arrow. Built at (x, z) on top of a surface at height y0, facing `facing`.
   */
  function keepRightSign(x: number, z: number, y0: number, facing: number, baseW: number): void {
    const g = new THREE.Group();
    g.position.set(x, y0, z);
    g.rotation.y = facing; // local +Z = toward the oncoming driver; local +X = their right
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, px: number, py: number, pz: number) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(px, py, pz);
      g.add(mesh);
      return mesh;
    };
    // striped curb block + reflector studs (red outer, amber inner)
    const bh = 0.4;
    const blk = new THREE.BoxGeometry(baseW, bh, 0.55);
    const uv = blk.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * baseW * 1.2, uv.getY(i) * bh * 1.2);
    add(blk, stripeMat(), 0, bh / 2, 0);
    const studs = [-0.4, -0.15, 0.15, 0.4];
    for (const sx of studs) {
      const col = Math.abs(sx) > 0.3 ? 0xd8261c : 0xf0a020;
      add(new THREE.CylinderGeometry(0.035, 0.035, 0.14, 8), mat(0x333333), sx * baseW, bh + 0.07, 0.1);
      let lens = mats.get('glow' + col);
      if (!lens) {
        lens = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.6 });
        mats.set('glow' + col, lens);
      }
      add(new THREE.SphereGeometry(0.06, 10, 8), lens, sx * baseW, bh + 0.16, 0.1);
    }
    // striped post
    const ph = 2.3;
    const post = new THREE.CylinderGeometry(0.06, 0.06, ph, 12);
    const puv = post.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < puv.count; i++) puv.setXY(i, puv.getX(i) * 1.0, puv.getY(i) * ph * 2.5);
    add(post, stripeMat(), 0, bh + ph / 2, 0);
    // delineator diamond: black plate with 3x3 orange dots
    const dia = canvasMat('diamond', 128, (c, n) => {
      c.fillStyle = '#111';
      c.fillRect(0, 0, n, n);
      c.fillStyle = '#ff9a1a';
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        c.beginPath();
        c.arc(n * (0.2 + 0.3 * i), n * (0.2 + 0.3 * j), n * 0.11, 0, Math.PI * 2);
        c.fill();
      }
    });
    const d = add(new THREE.PlaneGeometry(0.5, 0.5), dia, 0, bh + 1.35, 0.07);
    d.rotation.z = Math.PI / 4;
    // blue round "keep right" sign (white arrow pointing down-right), grey back
    const sign = canvasMat('keepRight', 256, (c, n) => {
      c.clearRect(0, 0, n, n);
      c.fillStyle = '#ffffff';
      c.beginPath(); c.arc(n / 2, n / 2, n * 0.49, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#1f5fc8';
      c.beginPath(); c.arc(n / 2, n / 2, n * 0.46, 0, Math.PI * 2); c.fill();
      c.save();
      c.translate(n / 2, n / 2);
      c.rotate(Math.PI / 4); // arrow along +x rotated to point down-right
      c.fillStyle = '#ffffff';
      c.fillRect(-n * 0.3, -n * 0.05, n * 0.42, n * 0.1);
      c.beginPath();
      c.moveTo(n * 0.3, 0); c.lineTo(n * 0.08, -n * 0.17); c.lineTo(n * 0.08, n * 0.17);
      c.closePath(); c.fill();
      c.restore();
    }, true);
    add(new THREE.PlaneGeometry(0.8, 0.8), sign, 0, bh + 2.05, 0.08);
    const back = add(new THREE.CircleGeometry(0.39, 24), mat(0x8a8d90), 0, bh + 2.05, 0.075);
    back.rotation.y = Math.PI;
    group.add(g);
  }

  /**
   * Painted scooter symbol inside a 機車停等區 waiting box (no text).
   * p = distance back along the arm (dx, dz), q = lateral offset to the driver's right.
   */
  function motoBoxMarking(p0: number, p1: number, q0: number, q1: number, dx: number, dz: number): void {
    const wq = q1 - q0, wp = p1 - p0, PX = 100; // px per metre
    const key = `mbox:${wq.toFixed(2)}x${wp.toFixed(2)}`;
    let m = mats.get(key) as THREE.MeshLambertMaterial | undefined;
    if (!m) {
      const cv = document.createElement('canvas');
      cv.width = Math.round(wq * PX);
      cv.height = Math.round(wp * PX);
      const g = cv.getContext('2d')!;
      const W = cv.width, H = cv.height;
      g.clearRect(0, 0, W, H);
      g.strokeStyle = '#f2f2f2';
      {
        // scooter in side view, upright for the approaching driver (wheels toward them), facing left;
        // stretched a little along the direction of travel like painted road symbols
        const s = Math.min(W * 0.6, H * 0.55);
        g.save();
        g.translate(W * 0.5, H * 0.5);
        g.scale(1, 1.25);
        g.lineWidth = s * 0.06;
        g.lineCap = g.lineJoin = 'round';
        const wr = s * 0.13;
        const L = (pts: number[][]) => {
          g.beginPath();
          g.moveTo(pts[0][0] * s, pts[0][1] * s);
          for (const [x, y] of pts.slice(1)) g.lineTo(x * s, y * s);
          g.stroke();
        };
        g.beginPath(); g.arc(-0.34 * s, 0.2 * s, wr, 0, Math.PI * 2); g.stroke(); // front wheel
        g.beginPath(); g.arc(0.34 * s, 0.2 * s, wr, 0, Math.PI * 2); g.stroke(); // rear wheel
        L([[-0.34, 0.2], [-0.24, -0.24]]); // fork / steering column
        L([[-0.33, -0.26], [-0.15, -0.26]]); // handlebar
        L([[-0.27, -0.12], [-0.2, 0.1], [0.12, 0.1]]); // leg shield + floorboard
        L([[0.12, 0.1], [0.08, -0.06], [0.42, -0.06], [0.47, 0.08], [0.34, 0.2]]); // seat + rear body
        g.restore();
      }
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      texes.push(tex);
      m = new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.4, depthWrite: false });
      mats.set(key, m);
    }
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wq, wp), m);
    const pc = (p0 + p1) / 2, qc = (q0 + q1) / 2;
    mesh.position.set(dx * pc + dz * qc, 0.013, dz * pc - dx * qc);
    // plane +X -> driver's right, plane +Y -> toward the junction (-b)
    mesh.rotation.set(-Math.PI / 2, Math.atan2(dx, dz), 0, 'YXZ');
    group.add(mesh);
  }

  /** Pedestrian signal on the sidewalk at one end of a crosswalk. */
  function pedSignal(x: number, z: number, facing: number, ns: boolean): void {
    box(0.15, 3.0, 0.15, x, 1.5, z, 0x555a60);
    // two stacked LED panels: red man on top, green walker below
    const head = new THREE.Group();
    head.position.set(x, 2.55, z);
    head.rotation.y = facing;
    head.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.0, 0.3), mat(0x1c1d20)));
    const pp = pedPanelsFor(ns);
    for (const [panel, y] of [[pp.top, 0.245], [pp.bottom, -0.245]] as const) {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), panel.mat);
      face.position.set(0, y, 0.152);
      head.add(face);
    }
    group.add(head);
  }

  function build(c: IntersectionConfig): void {
    const NS = c.nsHalfWidth; // N-S road half width (4 lanes)
    const EW = c.ewHalfWidth; // E-W road half width (2 lanes, narrow)
    const L = c.armLength;
    const W = c.crosswalkWidth;
    const sbW = westSetback(c);
    const sbOther = sbW; // retreat applies to all four crosswalks

    // ---- ground + asphalt ----
    const G = 600; // half size of the floor; roads + paving run all the way to its edge
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2 * G, 2 * G), mat(0xa9a69e)); // paved, no grass
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    group.add(ground);
    box(2 * G, 0.04, 2 * G, 0, -0.02, 0, 0x3a3d42); // asphalt over the whole floor (curb corners included); sidewalks sit on top

    // ---- sidewalks (one paved slab per quadrant, from the curb out to the floor edge, under the buildings) + curb obstacles ----
    // P(u, v): u runs along X, v along Z (first-quadrant coordinates, mirrored per quadrant)
    const r = Math.max(0.01, c.curbRadius);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const P = (u: number, v: number) => new THREE.Vector2(sx * u, -sz * v);
        const sh = new THREE.Shape();
        const a0 = P(NS, G); sh.moveTo(a0.x, a0.y);
        let q = P(NS, EW + r); sh.lineTo(q.x, q.y);
        const cp = P(NS, EW), ep = P(NS + r, EW);
        sh.quadraticCurveTo(cp.x, cp.y, ep.x, ep.y);
        q = P(G, EW); sh.lineTo(q.x, q.y);
        q = P(G, G); sh.lineTo(q.x, q.y);
        sh.closePath();
        const geo = new THREE.ExtrudeGeometry(sh, { depth: SIDEWALK_H, bevelEnabled: false, curveSegments: 8 });
        geo.rotateX(-Math.PI / 2); // (x,y,d) -> (x, d, -y)
        const m = new THREE.Mesh(geo, mat(0xb9b6ad));
        group.add(m);
        // coarse curb OBBs along the two road edges
        const lenV = (L - (EW + r)) / 2; // along the N-S road edge (x = NS)
        const lenU = (L - (NS + r)) / 2; // along the E-W road edge (z = EW)
        obstacles.push({ tag: 'curb', box: { cx: sx * NS, cz: sz * (EW + r + lenV), hw: 0.15, hl: lenV, yaw: 0 } });
        obstacles.push({ tag: 'curb', box: { cx: sx * (NS + r + lenU), cz: sz * EW, hw: lenU, hl: 0.15, yaw: 0 } });
        // lane edge line 0.4 m inside the curb, continuous around the rounded corner
        const o = 0.4;
        const edge: THREE.Vector2[] = [];
        const W2 = (u: number, v: number) => new THREE.Vector2(sx * u, sz * v);
        edge.push(W2(NS - o, G));
        const N = 16;
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          const p0 = [NS - o, EW + r], p1 = [NS - o, EW - o], p2 = [NS + r, EW - o];
          const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
          edge.push(W2(a * p0[0] + b * p1[0] + d * p2[0], a * p0[1] + b * p1[1] + d * p2[1]));
        }
        edge.push(W2(G, EW - o));
        ribbon(edge, 0.12, 0.011, 0xf2f2f2);
      }
    }

    // ---- lane markings ----
    const yellow = 0xe8c21a, white = 0xf2f2f2;
    const startNS = EW + Math.max(sbW, sbOther) + W + 3; // along Z, beyond the N-S arms' stop lines
    const startEW = NS + Math.max(sbW, sbOther) + W + 3; // along X, beyond the E-W arms' stop lines
    const lenNS = G - startNS, midNS = startNS + lenNS / 2;
    const lenEW = G - startEW, midEW = startEW + lenEW / 2;
    // raised central medians on both roads; they start beyond the crosswalks/stop lines, never on them
    const MH = 0.18;
    const medNS = 0.5, medEW = 0.4;
    const STOP_BACK = 1.0; // stop line sits this far behind where the median / lane lines start
    const STOP_W = 0.6; // stop line width (rules: 30 - 60 cm)
    const MBOX = 4.5; // 機車停等區 depth behind the stop line (rule 174-2: 2.5 - 6 m)
    for (const s of [-1, 1]) {
      box(medNS * 2, MH, lenNS, 0, MH / 2, s * midNS, 0x9a9a96);
      box(medNS * 2 - 0.2, 0.02, lenNS - 0.2, 0, MH + 0.01, s * midNS, 0x5f8f4a); // planted top
      box(lenEW, MH, medEW * 2, s * midEW, MH / 2, 0, 0x9a9a96);
      box(lenEW - 0.2, 0.02, medEW * 2 - 0.2, s * midEW, MH + 0.01, 0, 0x5f8f4a);
      obstacles.push({ tag: 'median', box: { cx: 0, cz: s * midNS, hw: medNS, hl: lenNS / 2, yaw: 0 } });
      obstacles.push({ tag: 'median', box: { cx: s * midEW, cz: 0, hw: lenEW / 2, hl: medEW, yaw: 0 } });
    }
    for (const sg of [-1, 1]) {
      box(0.12, 0.02, lenNS, sg * (medNS + 0.1), 0.01, midNS, yellow);
      box(0.12, 0.02, lenNS, sg * (medNS + 0.1), 0.01, -midNS, yellow);
      box(lenEW, 0.02, 0.12, midEW, 0.011, sg * (medEW + 0.1), yellow);
      box(lenEW, 0.02, 0.12, -midEW, 0.011, sg * (medEW + 0.1), yellow);
    }
    // N-S lane dividers (white dashed, between the two lanes of each direction)
    for (const sgn of [-1, 1]) {
      for (let z = startNS + STOP_BACK + MBOX + 0.2; z < G - 2; z += 4) { // dashes begin behind the waiting box
        box(0.12, 0.02, 2.2, sgn * (NS / 2), 0.01, z + 1.1, white);
        box(0.12, 0.02, 2.2, sgn * (NS / 2), 0.01, -(z + 1.1), white);
      }
    }
    // lane edge lines: drawn per quadrant with the sidewalks (continuous around each curb corner)

    // ---- crosswalks + stop lines ----
    // N-S arms: crosswalk spans the wide road (width 2*NS); E-W arms: spans the narrow road (2*EW).
    const arms: { dx: number; dz: number; sb: number }[] = [
      { dx: 0, dz: 1, sb: sbOther }, // south
      { dx: 0, dz: -1, sb: sbOther }, // north
      { dx: 1, dz: 0, sb: sbOther }, // east
      { dx: -1, dz: 0, sb: sbW }, // west
    ];
    for (const { dx, dz, sb } of arms) {
      if (dx === 0) {
        const cwC = EW + sb + W / 2; // crosswalk centreline z distance
        for (let t = -NS + 0.75; t < NS - 0.4; t += 1.0) box(0.5, 0.02, W, t, 0.012, dz * cwC, white);
        // stop line across the incoming half (south arm: northbound x in [0,NS]; north arm: southbound x in [-NS,0])
        // set back so it meets the start of the median + lane edge lines
        // spans only the lanes (yellow median line -> white edge line), 1 m behind the median nose
        const i0 = medNS + 0.16, i1 = NS - 0.46;
        box(i1 - i0, 0.02, STOP_W, (dz * (i0 + i1)) / 2, 0.012, dz * (startNS + STOP_BACK), white);
      } else {
        const cwC = NS + sb + W / 2; // crosswalk centreline x distance
        for (let t = -EW + 0.75; t < EW - 0.4; t += 1.0) box(W, 0.02, 0.5, dx * cwC, 0.012, t, white);
        // east arm: westbound lane z in [-EW,0]; west arm: eastbound lane z in [0,EW]
        const j0 = medEW + 0.16, j1 = EW - 0.46;
        box(STOP_W, 0.02, j1 - j0, dx * (startEW + STOP_BACK), 0.012, (-dx * (j0 + j1)) / 2, white);
      }
      // ---- 機車停等區 (motorcycle waiting box), rule 174-2: white rectangle right behind the stop line,
      // front / rear lines 20 cm, side lines 10-15 cm, 2.5-6 m deep, scooter symbol and / or white text inside;
      // sides may share the adjacent solid line (here: the right side shares the lane edge line).
      // Frame: b = (dx, dz) points back along the arm, r = driver's right.
      const rx = dz, rz = -dx;
      const q0 = dx === 0 ? medNS + 0.16 : medEW + 0.16; // lateral span (median side -> edge line)
      const q1 = dx === 0 ? NS - 0.46 : EW - 0.46;
      const s0 = (dx === 0 ? startNS : startEW) + STOP_BACK + STOP_W / 2; // rear edge of the stop line
      const rect = (p0: number, p1: number, qa: number, qb: number) => {
        const pc = (p0 + p1) / 2, qc = (qa + qb) / 2;
        const lp = Math.abs(p1 - p0), lq = Math.abs(qb - qa);
        box(dx === 0 ? lq : lp, 0.02, dx === 0 ? lp : lq, dx * pc + rx * qc, 0.012, dz * pc + rz * qc, white);
      };
      rect(s0 + MBOX - 0.4, s0 + MBOX, q0, q1); // rear line = where cars stop (thick, reads as their stop line)
      rect(s0, s0 + MBOX, q0, q0 + 0.15); // median-side line
      motoBoxMarking(s0 + 0.15, s0 + MBOX - 0.25, q0 + 0.2, q1 - 0.05, dx, dz);
    }

    // ---- vehicle signals: on each arm's median nose, facing the approaching traffic ----
    const noseNS = startNS + 0.5, noseEW = startEW + 0.5; // just inside the median's crosswalk-side end
    vehicleSignal(0, noseNS, 0, true, 1, 0, NS * 0.6); // south arm: faces south (+Z) for northbound, arm over x>0
    vehicleSignal(0, -noseNS, Math.PI, true, -1, 0, NS * 0.6); // north arm: southbound lanes x<0
    vehicleSignal(noseEW, 0, Math.PI / 2, false, 0, -1, EW * 0.6); // east arm: westbound lanes z<0
    vehicleSignal(-noseEW, 0, -Math.PI / 2, false, 0, 1, EW * 0.6); // west arm: eastbound lanes z>0

    // ---- pedestrian signals: on the sidewalk at both ends of every crosswalk, facing across ----
    // walkers on the N-S arms' crosswalks cross N-S traffic => they go with E-W (ns=false), and vice versa
    for (const { dx, dz, sb } of arms) {
      if (dx === 0) {
        // beside the crosswalk (on its far-from-junction side), near the curb: clear of the walking line
        const z = dz * (EW + sb + W + 0.6);
        pedSignal(NS + 0.5, z, -Math.PI / 2, false);
        pedSignal(-(NS + 0.5), z, Math.PI / 2, false);
      } else {
        const x = dx * (NS + sb + W + 0.6);
        pedSignal(x, EW + 0.5, Math.PI, true);
        pedSignal(x, -(EW + 0.5), 0, true);
      }
    }
    applySignal();

    // ---- buildings: continuous Taiwanese street-front rows with 騎樓 (arcades), chamfered corner blocks ----
    // Building line sits OPEN_W behind the curb. The ground floor is recessed ARC_D (the arcade, clear height
    // ARC_H; Taipei rules: >= 3.33 m high, >= 2.5 m clear between columns, column face 0.15 m behind the line).
    // Upper floors come out to the building line. Corner lots are cut on a 45 degree chamfer (截角).
    const rnd = mulberry32(1337);
    const OPEN_W = 2.0, ARC_D = 4.0, ARC_H = 3.6, FH = 3.2, DEPTH = 14, CHAMF = 5;
    const y0 = SIDEWALK_H;
    const CITY = 150; // build out to where the fog fully hides things
    const ALLEY_W = 8; // side street (街 / 巷) width
    const SIDE_SET = 1.2; // narrow walkway between a side street and its buildings
    const SIDE_DEPTH = 12; // lot depth of the plain rows on side streets
    // side streets in every quadrant: centrelines at these distances from the junction centre
    const streetsU = [54, 104]; // constant u: parallel to the N-S road, T into the E-W road
    const streetsV = [48, 98]; // constant v: parallel to the E-W road, T into the N-S road
    const firstCityChild = group.children.length; // everything from here to the island gets merged
    const facade = [0xc9c2b3, 0xb8b0a2, 0xd9d4c7, 0x9a958c, 0xc7a98f, 0xa7a9a5, 0xe0dccf, 0xb59a84, 0xd1bfa8, 0x8f9aa0];
    const signCols = [0xd93a3a, 0x1f6fd0, 0xf0b429, 0x2e9e4f, 0xe36bae, 0xf27d1b, 0xffffff];
    const shopCols = [0x34404a, 0x4a5560, 0x8d9096, 0x2c3238];
    const pick = (arr: number[]) => arr[Math.floor(rnd() * arr.length)];
    const bu = NS + OPEN_W, bv = EW + OPEN_W; // building lines facing the N-S road (u) and the E-W road (v)

    /** Vertical prism of a (u, v) polygon from y=ya to y=yb, mirrored into quadrant (sx, sz). */
    const prism = (poly: [number, number][], ya: number, yb: number, color: number, sx: number, sz: number) => {
      const sh = new THREE.Shape(poly.map(([u, v]) => new THREE.Vector2(sx * u, -sz * v)));
      const geo = new THREE.ExtrudeGeometry(sh, { depth: yb - ya, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2); // (x, y, d) -> (x, d, -y)
      const m = new THREE.Mesh(geo, mat(color));
      m.position.y = ya;
      group.add(m);
    };

    /**
     * One street-front building in a row. alongU = the row runs along u (faces a constant-v street), else
     * along v. a0..a1 = span along the row. The building line is at `line` and the lot extends from it in
     * direction f (+1 / -1) by `dep`. arcade = ground floor recessed into a 騎樓 with a column (main roads).
     */
    const rowBuilding = (
      sx: number, sz: number, alongU: boolean, a0: number, a1: number, floors: number,
      line: number, f: number, dep: number, arcade: boolean,
    ) => {
      // box given in (along, depth) coordinates; depth is measured from the line into the lot
      const bx = (aa: number, ab: number, da: number, db: number, ya: number, yb: number, col: number) => {
        const ca = (aa + ab) / 2, cd = line + (f * (da + db)) / 2;
        const u = alongU ? ca : cd, v = alongU ? cd : ca;
        const wa = Math.abs(ab - aa), wd = Math.abs(db - da);
        box(alongU ? wa : wd, yb - ya, alongU ? wd : wa, sx * u, (ya + yb) / 2, sz * v, col);
      };
      const poly = (da: number, db: number): [number, number][] => {
        const d0 = line + f * da, d1 = line + f * db;
        return alongU ? [[a0, d0], [a1, d0], [a1, d1], [a0, d1]] : [[d0, a0], [d1, a0], [d1, a1], [d0, a1]];
      };
      const gh = arcade ? ARC_H : 3.4; // ground floor height
      const H = y0 + gh + (floors - 1) * FH;
      const w = a1 - a0;
      prism(poly(0, dep), y0 + gh, H, pick(facade), sx, sz); // upper floors out to the line
      prism(poly(arcade ? ARC_D : 0.3, dep), y0, y0 + gh, pick(shopCols), sx, sz); // shopfront / garage
      if (arcade) bx(a0, a0 + 0.5, 0.15, 0.65, y0, y0 + gh, 0xb4ada0); // arcade column on the party wall
      // windows: one dark band per upper floor plus a light frame line (aluminium / iron grille feel)
      for (let fl = 1; fl < floors; fl++) {
        const yb = y0 + gh + (fl - 1) * FH;
        bx(a0 + 0.4, a1 - 0.4, -0.08, 0.02, yb + 0.9, yb + 2.5, 0x2a3138);
        bx(a0 + 0.4, a1 - 0.4, -0.12, -0.02, yb + 1.65, yb + 1.72, 0xc8ccd0);
      }
      // shop sign over the ground floor, vertical blade sign sticking out over the walkway
      if (rnd() < (arcade ? 0.75 : 0.4)) bx(a0 + 0.2, a1 - 0.2, -0.2, 0, y0 + gh + 0.1, y0 + gh + 0.9, pick(signCols));
      if (floors > 2 && rnd() < (arcade ? 0.45 : 0.2)) {
        const top = Math.min(H - 0.5, y0 + gh + 0.5 + 2 + rnd() * 4);
        bx(a0 + 0.35, a0 + 0.6, -1.0, -0.05, y0 + gh + 0.5, top, pick(signCols));
      }
      // rooftop: water tank and / or a sheet-metal rooftop addition
      if (rnd() < 0.55) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.2, 10), mat(rnd() < 0.5 ? 0xd8d8d0 : 0x3f78b5));
        const ta = a0 + w * (0.3 + rnd() * 0.4), td = line + f * dep * (0.5 + rnd() * 0.3);
        t.position.set(sx * (alongU ? ta : td), H + 0.6, sz * (alongU ? td : ta));
        group.add(t);
      }
      if (rnd() < 0.3) bx(a0 + 0.3, a1 - 0.3, dep * 0.45, dep - 0.5, H, H + 2.6, rnd() < 0.5 ? 0x7f9db5 : 0xb9bcc0);
      const cd = line + (f * dep) / 2, ca = (a0 + a1) / 2;
      const cu = alongU ? ca : cd, cv = alongU ? cd : ca;
      obstacles.push({ tag: 'building', box: { cx: sx * cu, cz: sz * cv, hw: alongU ? w / 2 : dep / 2, hl: alongU ? dep / 2 : w / 2, yaw: 0 } });
    };

    /** Fill a.. b along a row with shophouses (and the odd apartment block). */
    const fillRow = (
      sx: number, sz: number, alongU: boolean, a: number, end: number,
      line: number, f: number, dep: number, main: boolean,
    ) => {
      while (end - a > 3.5) {
        const tower = rnd() < (main ? 0.15 : 0.08);
        let w = tower ? 12 + rnd() * 6 : 4 + rnd() * 2.5;
        if (end - a - w < 3.5) w = end - a; // last lot takes the remainder
        const floors = tower ? (main ? 8 : 6) + Math.floor(rnd() * 5) : (main ? 3 : 2) + Math.floor(rnd() * 4);
        rowBuilding(sx, sz, alongU, a, a + w, floors, line, f, dep, main);
        a += w;
      }
    };

    /** Chamfered corner block (taller), arcade wrapping round all three street faces. */
    const cornerBuilding = (sx: number, sz: number) => {
      const D = DEPTH, C = CHAMF, a = ARC_D;
      const rolled = 6 + Math.floor(rnd() * 4);
      // SW corner stays low: it sits between the overview camera and the junction and would hide the turn
      const floors = sx < 0 && sz > 0 ? 4 : rolled;
      const H = y0 + ARC_H + (floors - 1) * FH;
      const upper: [number, number][] = [[bu, bv + C], [bu, bv + D], [bu + D, bv + D], [bu + D, bv], [bu + C, bv]];
      const K = bu + bv + C + a * Math.SQRT2; // chamfer line u + v = K, pushed back by the arcade depth
      const ground: [number, number][] = [[bu + a, K - bu - a], [bu + a, bv + D], [bu + D, bv + D], [bu + D, bv + a], [K - bv - a, bv + a]];
      prism(upper, y0 + ARC_H, H, pick(facade), sx, sz);
      prism(ground, y0, y0 + ARC_H, pick(shopCols), sx, sz);
      const col = (u: number, v: number) => box(0.5, ARC_H, 0.5, sx * u, y0 + ARC_H / 2, sz * v, 0xb4ada0);
      col(bu + 0.4, bv + C); col(bu + C, bv + 0.4);
      col(bu + 0.4, bv + C + (D - C) / 2); col(bu + C + (D - C) / 2, bv + 0.4);
      // chamfer face: window bands + a big sign, as yawed boxes along the cut
      const p1 = new THREE.Vector2(sx * bu, sz * (bv + C)), p2 = new THREE.Vector2(sx * (bu + C), sz * bv);
      const dir = new THREE.Vector2().subVectors(p2, p1);
      const len = dir.length();
      dir.normalize();
      const out = new THREE.Vector2(-sx, -sz).normalize(); // outward normal of the cut (toward the junction)
      const yaw = Math.atan2(-dir.y, dir.x);
      const mid = (off: number) => new THREE.Vector2((p1.x + p2.x) / 2 + out.x * off, (p1.y + p2.y) / 2 + out.y * off);
      for (let f = 1; f < floors; f++) {
        const yb = y0 + ARC_H + (f - 1) * FH;
        const m = mid(0.03);
        box(len - 0.8, 1.6, 0.1, m.x, yb + 1.7, m.y, 0x2a3138, yaw);
      }
      const ms = mid(0.12);
      box(len - 0.4, 0.9, 0.2, ms.x, y0 + ARC_H + 0.5, ms.y, pick(signCols), yaw);
      // windows on the two long faces
      for (const alongU of [true, false]) {
        for (let f = 1; f < floors; f++) {
          const yb = y0 + ARC_H + (f - 1) * FH;
          const a0 = (alongU ? bu : bv) + C + 0.4, a1 = (alongU ? bu : bv) + D - 0.4;
          const ca = (a0 + a1) / 2;
          if (alongU) box(a1 - a0, 1.6, 0.1, sx * ca, yb + 1.7, sz * (bv - 0.03), 0x2a3138);
          else box(0.1, 1.6, a1 - a0, sx * (bu - 0.03), yb + 1.7, sz * ca, 0x2a3138);
        }
      }
      if (rnd() < 0.7) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.3, 14), mat(0xd8d8d0));
        t.position.set(sx * (bu + D * 0.7), H + 0.65, sz * (bv + D * 0.7));
        group.add(t);
      }
      obstacles.push({ tag: 'building', box: { cx: sx * (bu + D / 2), cz: sz * (bv + D / 2), hw: D / 2, hl: D / 2, yaw: 0 } });
    };

    // City blocks per quadrant, cut by the side streets. A block's side is 'main' (arcade frontage on a main
    // road), 'side' (plain row on a side street) or 'none' (city edge). Rows facing constant-v streets own
    // the block corners; rows facing constant-u streets fit between them; the leftover middle gets a filler.
    type Side = 'main' | 'side' | 'none';
    const spans = (start: number, streets: number[]) => {
      const out: { lo: number; hi: number; loT: Side; hiT: Side }[] = [];
      let lo = start, loT: Side = 'main';
      for (const c of streets) {
        out.push({ lo, hi: c - ALLEY_W / 2, loT, hiT: 'side' });
        lo = c + ALLEY_W / 2;
        loT = 'side';
      }
      out.push({ lo, hi: CITY, loT, hiT: 'none' });
      return out;
    };
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        cornerBuilding(sx, sz);
        for (const us of spans(NS, streetsU)) {
          for (const vs of spans(EW, streetsV)) {
            const corner = us.loT === 'main' && vs.loT === 'main';
            // building lines + lot depths of the four sides (null = no row on that side)
            const lineLoU = us.loT === 'main' ? bu : us.lo + SIDE_SET;
            const lineHiU = us.hiT === 'side' ? us.hi - SIDE_SET : us.hi;
            const lineLoV = vs.loT === 'main' ? bv : vs.lo + SIDE_SET;
            const lineHiV = vs.hiT === 'side' ? vs.hi - SIDE_SET : vs.hi;
            const depLoV = vs.loT === 'main' ? DEPTH : SIDE_DEPTH;
            const depHiV = vs.hiT === 'side' ? SIDE_DEPTH : 0;
            const depLoU = us.loT === 'main' ? DEPTH : SIDE_DEPTH;
            const depHiU = us.hiT === 'side' ? SIDE_DEPTH : 0;
            // rows facing the constant-v streets (full width of the block)
            fillRow(sx, sz, true, corner ? bu + DEPTH : lineLoU, lineHiU, lineLoV, 1, depLoV, vs.loT === 'main');
            if (vs.hiT === 'side') fillRow(sx, sz, true, lineLoU, lineHiU, lineHiV, -1, depHiV, false);
            // rows facing the constant-u streets, between those
            const v0 = lineLoV + depLoV, v1 = lineHiV - depHiV;
            fillRow(sx, sz, false, v0, v1, lineLoU, 1, depLoU, us.loT === 'main');
            if (us.hiT === 'side') fillRow(sx, sz, false, v0, v1, lineHiU, -1, depHiU, false);
            // leftover middle: a low back building, or left open (parking / courtyard)
            const iu0 = lineLoU + depLoU + 1, iu1 = lineHiU - depHiU - 1, iv0 = v0 + 1, iv1 = v1 - 1;
            if (iu1 - iu0 > 5 && iv1 - iv0 > 5 && rnd() < 0.7) {
              const h = y0 + 3.4 + Math.floor(1 + rnd() * 3) * FH;
              const cu = (iu0 + iu1) / 2, cv = (iv0 + iv1) / 2;
              box(iu1 - iu0, h, iv1 - iv0, sx * cu, h / 2, sz * cv, pick(facade));
              obstacles.push({ tag: 'building', box: { cx: sx * cu, cz: sz * cv, hw: (iu1 - iu0) / 2, hl: (iv1 - iv0) / 2, yaw: 0 } });
            }
          }
        }
        // side streets: level asphalt alleys (no curb) laid on the sidewalk slab, with white edge lines
        const ay = SIDEWALK_H + 0.005;
        for (const c of streetsU) {
          const len = CITY - EW, mid = EW + len / 2;
          box(ALLEY_W, 0.01, len, sx * c, ay, sz * mid, 0x3a3d42);
          for (const e of [-1, 1]) box(0.1, 0.01, len, sx * (c + e * (ALLEY_W / 2 - 0.3)), ay + 0.002, sz * mid, white);
        }
        for (const c of streetsV) {
          const len = CITY - NS, mid = NS + len / 2;
          box(len, 0.01, ALLEY_W, sx * mid, ay + 0.001, sz * c, 0x3a3d42);
          for (const e of [-1, 1]) box(len, 0.01, 0.1, sx * mid, ay + 0.003, sz * (c + e * (ALLEY_W / 2 - 0.3)), white);
        }
      }
    }

    // merge every city mesh by material: thousands of boxes -> a few dozen draw calls
    {
      const added = group.children.slice(firstCityChild) as THREE.Mesh[];
      const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
      for (const m of added) {
        group.remove(m);
        m.updateMatrix();
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
        g.clearGroups();
        g.applyMatrix4(m.matrix);
        m.geometry.dispose();
        const mt = m.material as THREE.Material;
        if (!buckets.has(mt)) buckets.set(mt, []);
        buckets.get(mt)!.push(g);
      }
      for (const [mt, list] of buckets) {
        const merged = mergeGeometries(list, false);
        for (const g of list) g.dispose();
        if (merged) group.add(new THREE.Mesh(merged, mt));
      }
    }

    // ---- refuge island ----
    if (c.island) {
      for (const ib of allIslands(c)) {
        capsule(ib.hw + 0.15, ib.hl + 0.15, 0.05, 0.005, 0xe8e8e8, ib.cx, ib.cz, ib.yaw); // painted apron
        capsule(ib.hw, ib.hl, 0.25, 0.0, 0xa8a49a, ib.cx, ib.cz, ib.yaw); // rounded-nose island
        // one keep-right sign assembly on the nose (junction-facing end), facing traffic leaving the junction
        const ax = Math.sin(ib.yaw), az = Math.cos(ib.yaw); // long axis
        const e = ax * ib.cx + az * ib.cz > 0 ? -1 : 1; // which end points to the centre
        const off = Math.max(0, ib.hl - 0.45);
        keepRightSign(ib.cx + e * ax * off, ib.cz + e * az * off, 0.25, Math.atan2(e * ax, e * az), ib.hw * 1.8);
        obstacles.push({ tag: 'island', box: { ...ib } });
      }
    }

    // ---- left-turn guide line ----
    // WHITE DASHED marking from the south arm's double yellow curving through the SW quadrant to the
    // west arm's double yellow centre line. With an island it ends at the island's near (east) tip
    // instead. Left-turners keep to its right (north-east) side.
    if (c.guideLine) for (const pts of guideLinePaths(c)) {
      const dashOn = 1.0, dashOff = 0.8;
      let cursor = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        const yaw = Math.atan2(-dx, -dz);
        let s0 = 0;
        while (s0 < len) {
          const phase = (cursor + s0) % (dashOn + dashOff);
          const remain = phase < dashOn ? dashOn - phase : dashOn + dashOff - phase;
          const step = Math.min(remain, len - s0);
          if (phase < dashOn && step > 0.05) {
            const mx = a.x + (dx * (s0 + step / 2)) / len;
            const mz = a.z + (dz * (s0 + step / 2)) / len;
            const m = box(0.18, 0.02, step, mx, 0.026, mz, white, yaw);
            m.renderOrder = 2;
          }
          s0 += step;
        }
        cursor += len;
      }
    }

  }

  /** Left-turn arc from the player's lane (northbound inner lane) into the westbound lane. */
  function turnArc(c: IntersectionConfig, startZ: number): Vec2[] {
    const { nsInner, ewLane } = lanes(c);
    const r = startZ + ewLane; // ends tangent to the westbound lane (z = -ewLane)
    const pts: Vec2[] = [];
    for (let z = 30; z > startZ + 0.5; z -= 3) pts.push({ x: nsInner, z });
    const n = 30;
    for (let i = 0; i <= n; i++) {
      const a = ((Math.PI / 2) * i) / n;
      pts.push({ x: nsInner - r + r * Math.cos(a), z: startZ - r * Math.sin(a) });
    }
    pts.push({ x: nsInner - r - 6, z: -ewLane }, { x: -28, z: -ewLane }, { x: -36, z: -ewLane });
    return pts;
  }

  /** Start of the turn (z, m south of the junction centre) of the proper 路心左轉: passes through the centre. */
  const CENTER_TURN_START_Z = 7;
  /** 切西瓜: starts turning EARLY, so the arc is LARGER and sweeps the inside (SW) of the junction. */
  const CUT_START_Z = 18;
  function viaCenterPath(c: IntersectionConfig): Vec2[] {
    return turnArc(c, CENTER_TURN_START_Z);
  }
  function cutCornerPath(c: IntersectionConfig): Vec2[] {
    return turnArc(c, CUT_START_Z);
  }
  /**
   * Act 1 pink path: follows the orange (cutCorner) arc for its first half, then goes STRAIGHT at the
   * crosswalk. The last point is the nominal impact point (west crosswalk, north half); the point
   * before it is where the car leaves the arc (Act 1 then steers the car straight at the pedestrian).
   */
  function act1HitPath(c: IntersectionConfig): Vec2[] {
    const arc = cutCornerPath(c);
    const k0 = arc.findIndex((p, i) => i > 0 && p.x < arc[i - 1].x); // second arc point
    const sw = arc.slice(0, k0 + 15); // arc samples 0..15 of 30 = first 45 degrees
    const cwx = -(c.nsHalfWidth + westSetback(c) + c.crosswalkWidth / 2);
    return [...sw, { x: cwx, z: -lanes(c).ewLane * 0.5 }];
  }

  /**
   * Guide-line centre curve: from the south arm's centreline at the box edge to the west arm's
   * centreline (or the island's east tip when there is an island), tangent to both.
   */
  function guideLinePath(c: IntersectionConfig): Vec2[] {
    // start: the south arm's median (island near tip when there is one); end: west island's east tip
    const isl = c.island ? allIslands(c) : null;
    const startZ = isl ? isl[2].cz - isl[2].hl : c.ewHalfWidth + 0.5;
    const endX = isl ? isl[0].cx + isl[0].hl : -c.nsHalfWidth;
    // keep to the RIGHT side of the islands/medians (east of the south island, north of the west island)
    const off = isl ? isl[0].hw + 0.1 : 0.7;
    return quadBezier({ x: off, z: startZ }, { x: off, z: -off }, { x: endX, z: -off }, 40);
  }
  /** Player-side guide line plus its 180-degree copy for the oncoming left-turner (north arm -> east arm). */
  function guideLinePaths(c: IntersectionConfig): Vec2[][] {
    const a = guideLinePath(c);
    return [a, a.map((p) => ({ x: -p.x, z: -p.z }))];
  }

  const world: World = {
    group,
    config: { ...(defaultConfig as IntersectionConfig), ...(cfg ?? {}) },
    obstacles,
    rebuild(partial) {
      disposeAll();
      Object.assign(world.config, partial); // in place: editor controllers keep their reference
      build(world.config);
    },
    onRoad(p) {
      const NS = world.config.nsHalfWidth, EW = world.config.ewHalfWidth, L = world.config.armLength;
      return (Math.abs(p.x) <= NS && Math.abs(p.z) <= L) || (Math.abs(p.z) <= EW && Math.abs(p.x) <= L);
    },
    westCrosswalk() {
      const c = world.config;
      const x = -(c.nsHalfWidth + westSetback(c) + c.crosswalkWidth / 2);
      return { south: { x, z: c.ewHalfWidth }, north: { x, z: -c.ewHalfWidth }, width: c.crosswalkWidth };
    },
    leftTurnPath(kind) {
      if (kind === 'act1Hit') return act1HitPath(world.config);
      return kind === 'cutCorner' ? cutCornerPath(world.config) : viaCenterPath(world.config);
    },
    pedestrianPath() {
      const w = world.westCrosswalk();
      return [w.south, w.north];
    },
    setSignal(state) {
      signal = state;
      applySignal();
    },
    dispose() {
      clearInterval(pedTimer);
      disposeAll();
    },
  };

  build(world.config);
  const pedTimer = setInterval(() => updatePeds(0.25), 250);
  return world;
}

// Re-export for convenience of consumers needing the type of obstacle boxes.
export type { Obb };
