import * as THREE from 'three';
import type { Act } from '../types';
import { driveAttempt, startState, crashMessage, isSolidHit } from './driveScene';
import { DRIVER_EYE } from '../sim/CarMesh';

export const act2: Act = {
  id: 'act2',
  async run(ctx, _shared) {
    const { ui, rig, audio, world } = ctx;
    ui.clearAll();
    world.rebuild({ island: false, crosswalkRetreat: false, guideLine: false, education: false });
    world.setSignal('green');
    const debugDraw = (ctx as unknown as { debugDraw?: import('../dev/DebugDraw').DebugDraw }).debugDraw;

    let first = true;
    for (;;) {
      if (first) {
        // rewind arrives from act 1: show rewind effect over the live start position
        // put the camera at the driver's start position first so the rewind plays over the right view
        rig.setMode('driver');
        rig.followDriver(startState(world.config), DRIVER_EYE);
        ui.setBlack(false);
        audio.rewind(2200);
        await ui.rewindOverlay(2200);
        first = false;
      } else {
        ui.setBlack(false);
      }
      const disposeHint = ui.hint('[W] 前進　[A][D] 轉彎　[S] 煞車');
      const res = await driveAttempt(ctx, { mode: 'blind', debugDraw });
      disposeHint();

      if (res.kind === 'crash' && res.cause === 'pedestrian') {
        // vehicle-view shake, sound cut, black
        audio.impact();
        const p = rig.camera.position.clone();
        const look = new THREE.Vector3();
        rig.camera.getWorldDirection(look);
        const base = p.clone().add(look.multiplyScalar(10));
        await rig.playKeyframes([
          { t: 0, pose: { pos: p.clone(), lookAt: base.clone() } },
          { t: 60, pose: { pos: p.clone().add(new THREE.Vector3(0.12, 0.08, 0)), lookAt: base.clone() } },
          { t: 120, pose: { pos: p.clone().add(new THREE.Vector3(-0.12, -0.06, 0)), lookAt: base.clone() } },
          { t: 180, pose: { pos: p.clone().add(new THREE.Vector3(0.08, 0.05, 0)), lookAt: base.clone() } },
          { t: 260, pose: { pos: p.clone(), lookAt: base.clone() } },
        ]);
        audio.cutOff();
        ui.setBlack(true);
        res.cleanup();
        await ctx.wait(900);
        await ui.narration('他看了。只是在他的視角，的確看不到。', 3600);
        await ui.narration('他確實有責任，但這個路口，也有值得改進的地方。', 4000);
        // rewind to a bird's eye view
        ui.setBlack(false);
        audio.rewind(2200);
        await Promise.all([
          ui.rewindOverlay(2200),
          rig.tweenTo({ pos: new THREE.Vector3(0, 64, 32), lookAt: new THREE.Vector3(0, 0, 8), fov: 45, roll: 0 }, 2200),
        ]);
        return;
      }

      // failure: oncoming car / island / off-road -> restart
      const solid = res.kind === 'crash' && isSolidHit(res.cause);
      if (solid) audio.impact();
      await ctx.wait(250);
      if (solid) audio.cutOff();
      ui.setBlack(true);
      res.cleanup();
      await ctx.wait(500);
      await ui.narration(res.kind === 'crash' ? crashMessage(res.cause) : '再試一次吧', 2200);
    }
  },
};
