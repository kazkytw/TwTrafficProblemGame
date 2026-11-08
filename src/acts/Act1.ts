import * as THREE from 'three';
import type { Act, Vec2 } from '../types';
import { createCarMesh } from '../sim/CarMesh';
import { disposeObject } from './helpers';
import { lanes } from '../world/lanes';

const CAR_SPEED = 10;

export const act1: Act = {
  id: 'act1',
  async run(ctx) {
    const { ui, rig, audio, world, input, scene } = ctx;
    ui.clearAll();
    world.rebuild({ island: false, crosswalkRetreat: false, guideLine: false, education: false });
    world.setSignal('red');

    const WALK_SPEED = world.config.pedWalkSpeed ?? 1.4; // editable in the editor
    const LANE_Z = -lanes(world.config).ewLane; // westbound lane the left-turning car ends in
    // the car follows the pink path: the orange arc's first half (all but the last point), then it
    // leaves the arc and drives STRAIGHT at the pedestrian, so it hits wherever they stopped
    const path = world.leftTurnPath('act1Hit').slice(0, -1);
    const swPt = path[path.length - 1];
    const cum: number[] = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
    const sample = (s: number) => {
      const t = Math.min(Math.max(s, 0), cum[cum.length - 1] - 0.01);
      let i = 1;
      while (i < cum.length - 1 && cum[i] < t) i++;
      const k = (t - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
      const a = path[i - 1], b = path[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, fx: (b.x - a.x) / len, fz: (b.z - a.z) / len };
    };
    const cw = world.westCrosswalk();
    const cx = (cw.south.x + cw.north.x) / 2;
    // pedestrian starts on the south sidewalk side of the west crosswalk, facing north
    const pos: Vec2 = { x: cx, z: cw.south.z + 4 };
    const startZ = pos.z;
    const total = Math.abs(cw.north.z - cw.south.z); // crosswalk length (curb to curb)
    rig.setMode('pedestrian');
    rig.followPedestrian(pos, 0);

    ui.setBlack(true);
    await ui.fadeFromBlack(1200);
    ctx.world.setSignal('red');
    await ctx.wait(1200);
    world.setSignal('green');

    await ui.say('pedestrian', '綠燈了。', 1500);
    const disposeHint = ui.hint('按住 [W] 走上斑馬線');
    await ctx.until(() => input.w);
    disposeHint();

    // walk until mid-crossing
    let carSpawned = false;
    let carMesh: THREE.Group | null = null;
    let carS = 0; // arc length travelled along the pink arc
    let homing = false; // true once the car has left the arc and charges straight at the pedestrian
    const cur = { x: 0, z: 0 };
    let crashed = false;
    let bob = 0;
    const off = ctx.onUpdate((dt) => {
      if (crashed) return;
      if (input.w) {
        pos.z -= WALK_SPEED * dt;
        bob += dt * 8;
      }
      rig.followPedestrian({ x: pos.x, z: pos.z }, 0, Math.sin(bob) * 0.004);
      const walked = startZ - pos.z;
      const midZ = (cw.south.z + cw.north.z) / 2;
      if (!carSpawned && pos.z <= midZ - 0.5) {
        // the left-turning car appears behind-right and charges at the pedestrian
        carSpawned = true;
        const tPed = Math.max(1, (pos.z - LANE_Z) / WALK_SPEED);
        const swLen = cum[cum.length - 1];
        const D = Math.hypot(pos.x - swPt.x, pos.z - swPt.z);
        carS = swLen + D - (CAR_SPEED * tPed + 3); // distance travelled at spawn (< 0 is clamped)
        let s0 = sample(Math.max(0, carS));
        if (carS > swLen) {
          homing = true;
          const k = (carS - swLen) / (D || 1);
          cur.x = swPt.x + (pos.x - swPt.x) * k;
          cur.z = swPt.z + (pos.z - swPt.z) * k;
          s0 = { x: cur.x, z: cur.z, fx: (pos.x - swPt.x) / (D || 1), fz: (pos.z - swPt.z) / (D || 1) };
        }
        carMesh = createCarMesh({ color: 0x3a6ea5 });
        carMesh.rotation.y = Math.atan2(-s0.fx, -s0.fz);
        carMesh.position.set(s0.x, 0, s0.z);
        scene.add(carMesh);
        audio.engineStart({ volume: 0.3 });
        void walked;
      }
      if (carMesh) {
        let s: { x: number; z: number; fx: number; fz: number };
        if (!homing) {
          carS += CAR_SPEED * dt;
          if (carS >= cum[cum.length - 1]) {
            homing = true;
            cur.x = swPt.x;
            cur.z = swPt.z;
          }
        }
        if (homing) {
          // straight line at the pedestrian's current position
          const hx = pos.x - cur.x;
          const hz = pos.z - cur.z;
          const hl = Math.hypot(hx, hz) || 1;
          s = { x: cur.x, z: cur.z, fx: hx / hl, fz: hz / hl };
          cur.x += s.fx * CAR_SPEED * dt;
          cur.z += s.fz * CAR_SPEED * dt;
        } else {
          s = sample(carS);
        }
        carMesh.position.set(s.x, 0, s.z);
        carMesh.rotation.y = Math.atan2(-s.fx, -s.fz);
        audio.setEngine(0.35);
        // pedestrian inside the car's (padded) box, in car-local axes -> hit, even if they stopped halfway
        const rx = pos.x - s.x;
        const rz = pos.z - s.z;
        const along = rx * s.fx + rz * s.fz;
        const lateral = -rx * s.fz + rz * s.fx;
        if (Math.abs(along) < 2.6 && Math.abs(lateral) < 1.7) crashed = true;
      }
    });
    await ctx.until(() => crashed);
    off();

    // impact: camera is flung off the ground
    audio.impact();
    const p0 = rig.camera.position.clone();
    const L = (x: number, y: number, z: number) => new THREE.Vector3(p0.x + x, y, p0.z + z);
    const fling = rig.playKeyframes([
      { t: 0, pose: { pos: p0.clone(), lookAt: L(0, 1.6, -10) } },
      { t: 300, pose: { pos: L(-1.0, 3.5, 0.5), lookAt: L(-6, 0, -6), roll: 1.2 } },
      { t: 700, pose: { pos: L(-2.0, 7.5, 1.5), lookAt: L(0, 20, -2), roll: 3.0 } },
      { t: 1100, pose: { pos: L(-2.6, 9.0, 2.0), lookAt: L(2, 0, 4), roll: 4.8 } },
      { t: 1500, pose: { pos: L(-3.0, 6.5, 2.4), lookAt: L(3, 0, 2), roll: 6.4 } },
    ]);
    await ctx.wait(1000);
    audio.cutOff(); // sound peaks, then stops dead
    ui.setBlack(true);
    await fling;
    audio.engineStop();
    if (carMesh) disposeObject(carMesh);
    rig.set({ roll: 0 });
    await ctx.wait(900);

    audio.beep();
    await ui.news('走斑馬線遭左轉車撞倒！行人送醫急救', '今天清晨，在○○區○○路口發生車禍，一名行人遭左轉的小客車撞擊後送醫，\n稍早駕駛供稱沒有看到人，而警方正在調查事發經過。', 8000);
    await ui.say('driver', '我真的沒看到……', 3700);
    await ui.say('driver', '而且我之前賺的，跟未來幾年賺的，都要拿去賠償，我的人生是不是也完了。', 5500);
    await ui.narration('他真的沒看到嗎？', 3200);
  },
};
