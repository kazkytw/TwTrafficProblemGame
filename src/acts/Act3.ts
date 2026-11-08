import * as THREE from 'three';
import type { Act, SharedState } from '../types';
import { makeRibbon, disposeObject } from './helpers';

const CARDS = [
  {
    key: 'crosswalkRetreat' as const,
    title: '行穿線退縮',
    desc: '行人離轉彎弧線更遠',
    note: '在行穿線前多出儲車空間，讓駕駛可以分段注意，左轉前看對向來車，左轉後注意行人',
  },
  {
    key: 'island' as const,
    title: '行人庇護島',
    desc: '物理擋住切西瓜',
    note: '讓車輛無法「切西瓜」，引導車輛在行穿線前轉正，視野更好',
  },
  {
    key: 'guideLine' as const,
    title: '左轉導引線',
    desc: '地面標線引導到路心',
    note: '引導車輛依正確軌跡左轉',
  },
  {
    key: 'education' as const,
    title: '教育駕駛',
    desc: '先到路心再左轉',
    note: '教育駕駛先到路心再左轉',
  },
];

export const act3: Act = {
  id: 'act3',
  async run(ctx, shared: SharedState) {
    const { ui, rig, world } = ctx;
    ui.clearAll();
    // rewind finished -> bird's eye
    world.setSignal('green');
    const overlay = new THREE.Group();
    ctx.scene.add(overlay);

    const redraw = () => {
      [...overlay.children].forEach(disposeObject);
      const carPath = shared.cards.island ? world.leftTurnPath('viaCenter') : world.leftTurnPath('cutCorner');
      overlay.add(makeRibbon(carPath, 0xff4d3d, 0.7, 0.25));
      overlay.add(makeRibbon(world.pedestrianPath(), 0x2f7dff, 0.7, 0.25));
    };

    shared.cards = { island: false, crosswalkRetreat: false, guideLine: false, education: false };
    world.rebuild({ island: false, crosswalkRetreat: false, guideLine: false, education: false });
    redraw();

    rig.setMode('overview');
    await rig.tweenTo({ pos: new THREE.Vector3(0, 64, 32), lookAt: new THREE.Vector3(0, 0, 8), fov: 45, roll: 0 }, 2200);
    ui.setBlack(false);

    let installed = 0;
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    ui.showCards(
      CARDS.map((c) => ({ title: c.title, desc: c.desc, note: c.note })),
      (i) => {
        const c = CARDS[i];
        shared.cards[c.key] = true;
        world.rebuild({
          island: shared.cards.island,
          crosswalkRetreat: shared.cards.crosswalkRetreat,
          guideLine: shared.cards.guideLine,
          education: shared.cards.education,
        });
        redraw();
        installed++;
        if (installed === CARDS.length) ui.showPlayButton(() => done());
      },
    );
    await finished;
    ui.hideCards();
    await ui.fadeToBlack(700);
    [...overlay.children].forEach(disposeObject);
    overlay.removeFromParent();
  },
};
