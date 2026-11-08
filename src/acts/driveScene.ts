import * as THREE from 'three';
import type { CarState, CollisionKind, GameContext } from '../types';
import { CarController } from '../sim/CarController';
import { createCockpit, DRIVER_EYE, aPillarFan } from '../sim/CarMesh';
import { createPlayerCar } from '../sim/CarModel';
import { TrafficStream, TrafficParams, applyLaneLayout } from '../sim/TrafficStream';
import { lanes } from '../world/lanes';
import { PedestrianSpawner, defaultEarlySpawnDistance, blindBearing } from '../sim/PedestrianSpawner';
import { obbOverlap } from '../world/colliders';
import type { DebugDraw } from '../dev/DebugDraw';

export type DriveOutcome =
  | { kind: 'crash'; cause: CollisionKind } // oncoming / island / offroad / pedestrian
  | { kind: 'stopped' }; // act 4 success: auto-braked in front of the crosswalk

export interface DriveOptions {
  /** 'blind' = act 2 (ped hidden by A-pillar, collision course), 'early' = act 4 (visible ped, auto-brake). */
  mode: 'blind' | 'early';
  debugDraw?: DebugDraw;
  /** Called every frame (e.g. for the dev panel). */
  onFrame?: (car: CarState) => void;
}

export const START = { z: 46, yaw: 0, speed: 3 };
/** Start state of the player's car (inner northbound lane). */
export const startState = (c: Parameters<typeof lanes>[0]) => ({ x: lanes(c).nsInner, z: START.z, yaw: START.yaw, speed: 0, steer: 0 });
/** Distance (m) from the west-crosswalk centre at which the pedestrian is spawned in blind mode. */
export const SPAWN_DISTANCE = 12;

/**
 * One attempt of the driver scene. Resolves with the outcome. The caller handles
 * narration / retry. Cleans up everything it created before resolving.
 */
export async function driveAttempt(ctx: GameContext, opt: DriveOptions): Promise<DriveResult> {
  const { scene, rig, input, world, audio } = ctx;

  const car = new CarController();
  car.reset(lanes(world.config).nsInner, START.z, START.yaw, START.speed);
  const traffic = new TrafficStream(scene);
  applyLaneLayout(world.config);
  // act 4 (island): the waiting car would sit on the centre line the player is guided along
  TrafficParams.waitingCarEnabled = true; // the oncoming left-turner is part of every act (position set in the editor)
  traffic.start();
  const spawner = new PedestrianSpawner(scene, world);
  // preferred: the camera sits inside the real car model; fallback: greybox cockpit on the camera
  const playerCar = createPlayerCar();
  const cockpit = playerCar ? null : createCockpit();
  if (playerCar) scene.add(playerCar);
  if (!rig.camera.parent) scene.add(rig.camera);
  if (cockpit) rig.camera.add(cockpit);
  rig.setMode('driver');

  const cw = world.westCrosswalk();
  const cwX = (cw.south.x + cw.north.x) / 2;
  const nearEdgeX = cwX + cw.width / 2; // east edge of the crosswalk
  let spawned = false;

  if (opt.mode === 'early') {
    car.setAutoStop((s) => {
      const brake = 7;
      const front = s.x + -Math.sin(s.yaw) * 2.3; // front bumper x
      const dist = front - (nearEdgeX + 1.5);
      const need = (s.speed * s.speed) / (2 * brake) + 0.5;
      return s.yaw > 1.0 && dist <= need;
    });
  }

  audio.engineStart({ volume: 0.6 });

  let outcome: DriveOutcome | null = null;
  let stopped = 0;
  const off = ctx.onUpdate((dt) => {
    if (outcome) return;
    const inp = { w: input.w, a: input.a, s: input.s, d: input.d };
    car.update(dt, inp);
    traffic.update(dt);
    const st = car.state;
    if (playerCar) {
      playerCar.position.set(st.x, 0, st.z);
      playerCar.rotation.y = st.yaw;
    }
    rig.followDriver(st, DRIVER_EYE);
    audio.setEngine(Math.min(1, st.speed / 12));

    if (!spawned) {
      if (opt.mode === 'early') {
        // act 4: visible walker, appears once the bumper is close enough to the crosswalk (editor setting)
        if (spawner.distanceToCrosswalk(st) <= (world.config.pedEarlySpawnDistance ?? defaultEarlySpawnDistance)) {
          spawner.spawnAhead(st, world);
          spawned = true;
        }
      } else if (spawner.distanceToCrosswalk(st) <= (world.config.pedSpawnDistance ?? spawner.params.distance)) {
        // act 2: like act 4 - the walker appears at the editor's bearing once the bumper is within the editor's
        // spawn distance, then simply crosses (editor: 生成距離 / 生成方位角).
        spawner.spawnAhead(st, world, blindBearing(world));
        spawned = true;
        // keep the car rolling even if W is released / S pressed, so the scene can't stall
        car.setCruise(Math.max(4, st.speed));
      }
    }
    spawner.update(dt, st);

    const box = car.obb();
    let hit: CollisionKind = 'none';
    if (traffic.hitTest(box)) hit = 'oncoming';
    else if (world.obstacles.some((o) => o.tag === 'median' && obbOverlap(box, o.box))) hit = 'median';
    else if (world.obstacles.some((o) => o.tag === 'island' && obbOverlap(box, o.box))) {
      // the west island (cx < 0, on the E-W axis) is the one next to the story's crosswalk
      const west = world.obstacles.some((o) => o.tag === 'island' && o.box.cx < -1 && Math.abs(o.box.cx) > Math.abs(o.box.cz) && obbOverlap(box, o.box));
      hit = west ? 'islandWest' : 'island';
    } else if (!world.onRoad({ x: st.x, z: st.z })) hit = 'offroad';
    else if (
      // wrong direction of travel: U-turn in the south arm, straight on into the north arm, right turn into the east arm
      (st.z > world.config.ewHalfWidth + 2 && Math.cos(st.yaw) < -0.3) ||
      st.z < -(world.config.ewHalfWidth + 1) ||
      (st.x > world.config.nsHalfWidth + 1 && Math.abs(st.z) <= world.config.ewHalfWidth)
    ) hit = 'wrongWay';
    else if (
      // drove onto the opposing side of the road: south arm southbound lanes / west arm eastbound lane
      (st.z > world.config.ewHalfWidth + 2 && st.x < -1) ||
      (st.x < -(world.config.nsHalfWidth + 2) && st.z > 1)
    ) hit = 'wrongSide';
    else if (spawner.pedestrian && spawner.hitTest(box)) {
      // hit before the pedestrian got past 1/3 of the crosswalk => the car was in the wrong (oncoming) lane
      const prog = (cw.south.z - spawner.pedestrian.pos.z) / (cw.south.z - cw.north.z);
      hit = prog < 1 / 3 ? 'wrongSide' : 'pedestrian';
    }
    // blind mode safety net: car drove through the crosswalk without hitting -> still the story's accident
    else if (opt.mode === 'blind' && spawned && st.x < cwX - cw.width / 2 - 2 && spawner.pedestrian) hit = 'pedestrian';

    if (hit !== 'none') {
      outcome = { kind: 'crash', cause: hit };
      return;
    }
    if (opt.mode === 'early' && spawner.pedestrian && st.speed < 0.05 && st.yaw > 1.0) {
      stopped += dt;
      if (stopped > 0.4) outcome = { kind: 'stopped' };
    }

    if (opt.debugDraw && ctx.debug.enabled) {
      const dd = opt.debugDraw;
      dd.drawObb('car', box, 0x00ff88);
      traffic.obbs().forEach((b, i) => dd.drawObb('t' + i, b, 0xff5533));
      const fan = aPillarFan(st);
      dd.drawFan('fan', fan.origin, fan.yawCentre, fan.halfAngle, 30, 0xffcc00);
    }
    opt.onFrame?.(st);
  });

  await ctx.until(() => outcome !== null);
  off();
  const result = outcome as unknown as DriveOutcome;

  const cleanup = () => {
    audio.engineStop();
    if (cockpit) {
      rig.camera.remove(cockpit);
      cockpit.traverse((c) => (c as THREE.Mesh).geometry?.dispose?.());
    }
    if (playerCar) scene.remove(playerCar); // geometry/materials are shared with the template
    traffic.dispose();
    spawner.dispose();
    opt.debugDraw?.clearAll();
  };
  return { ...result, cleanup, car, spawner };
}

export type DriveResult = DriveOutcome & { cleanup: () => void; car: CarController; spawner: PedestrianSpawner };

/** Retry message shown after a failed (non-pedestrian) attempt. */
export function crashMessage(cause: CollisionKind): string {
  switch (cause) {
    case 'oncoming': return '撞到車了，再試一次吧';
    case 'median': return '你駕駛技術不太好喔，再試一次吧';
    case 'islandWest': return '還好撞到的是島不是人';
    case 'island': return '不小心撞到島了，再試一次吧';
    case 'offroad': return '你要開去哪= =?';
    case 'wrongSide': return '這裡不是日本餒，靠右行駛喔';
    case 'wrongWay': return '開錯邊囉，公司不在這個方向';
    default: return '再試一次吧';
  }
}

/** Only crashes into a physical object make a crash sound (not wrong-way / wrong-side / off-road). */
export function isSolidHit(cause: CollisionKind): boolean {
  return cause === 'oncoming' || cause === 'median' || cause === 'island' || cause === 'islandWest' || cause === 'pedestrian';
}
