import * as THREE from 'three';
import type { Act, SharedState } from '../types';
import { driveAttempt, crashMessage, isSolidHit } from './driveScene';

export const act4: Act = {
  id: 'act4',
  async run(ctx, shared: SharedState) {
    const { ui, rig, audio, world } = ctx;
    ui.clearAll();
    world.rebuild({ ...shared.cards });
    world.setSignal('green');
    const debugDraw = (ctx as unknown as { debugDraw?: import('../dev/DebugDraw').DebugDraw }).debugDraw;

    let first = true;
    for (;;) {
      ui.setBlack(false);
      const hints: (() => void)[] = [];
      first = false;
      hints.push(ui.hint('跟隨導引線轉彎'));
      const res = await driveAttempt(ctx, { mode: 'early', debugDraw });
      hints.forEach((h) => h());

      if (res.kind === 'stopped') {
        // pedestrian view: turns toward the car and nods, then back
        const ped = res.spawner.pedestrian!;
        const carPos = new THREE.Vector3(res.car.state.x, 1.1, res.car.state.z);
        const eye = new THREE.Vector3(ped.pos.x, rig.eyeHeight.pedestrian, ped.pos.z);
        const driverPose = { pos: rig.camera.position.clone(), lookAt: carPos.clone().add(new THREE.Vector3(-6, 0, 0)) };
        rig.setMode('pedestrian');
        // cut to pedestrian, looking north first, then turn toward the car (east/right)
        rig.set({ pos: eye, lookAt: eye.clone().add(new THREE.Vector3(0, 0, -10)), fov: 72, roll: 0 });
        await rig.tweenTo({ lookAt: new THREE.Vector3(carPos.x, rig.eyeHeight.pedestrian, carPos.z) }, 700);
        const target = new THREE.Vector3(carPos.x, rig.eyeHeight.pedestrian, carPos.z);
        await rig.playKeyframes([
          { t: 0, pose: { lookAt: target.clone() } },
          { t: 220, pose: { lookAt: target.clone().add(new THREE.Vector3(0, -2.2, 0)) } },
          { t: 480, pose: { lookAt: target.clone() } },
        ]);
        await ctx.wait(250);
        // back to the driver
        rig.setMode('driver');
        rig.set({ pos: driverPose.pos, lookAt: driverPose.lookAt, fov: 75, roll: 0 });
        await ui.say('driver', '還好，有看到。', 2400);
        await ui.fadeToBlack(800);
        res.cleanup();
        return;
      }

      // crash: island or other
      if (res.cause === 'island' || res.cause === 'islandWest') {
        audio.impact();
        await ctx.wait(400);
        ui.setBlack(true);
        res.cleanup();
        await ctx.wait(300);
        await ui.narration(crashMessage(res.cause), 2800);
      } else {
        const solid = isSolidHit(res.cause);
        if (solid) audio.impact();
        await ctx.wait(250);
        if (solid) audio.cutOff();
        ui.setBlack(true);
        res.cleanup();
        await ctx.wait(500);
        await ui.narration(crashMessage(res.cause), 2200);
      }
      await ctx.wait(600);
    }
  },
};
