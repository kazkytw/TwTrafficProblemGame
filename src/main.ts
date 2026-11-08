import * as THREE from 'three';
import { createGame } from './core/Game';
import type { Act, SharedState } from './types';
import { act1 } from './acts/Act1';
import { act2 } from './acts/Act2';
import { act3 } from './acts/Act3';
import { act4 } from './acts/Act4';
import { act5 } from './acts/Act5';
import { createEditor } from './dev/EditorMode';
import { loadPlayerCar } from './sim/CarModel';

// geometry saved by the editor (public/intersection.json); toggles always start off
const saved = await fetch('/intersection.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}));
const savedEye = await fetch('/driver-eye.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : undefined))
  .catch(() => undefined);
const savedMirror = await fetch('/side-mirror.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : undefined))
  .catch(() => undefined);
await loadPlayerCar(savedEye, savedMirror);
const game = createGame({ ...saved, island: false, crosswalkRetreat: false, guideLine: false, education: false });
const { ctx } = game;
game.start();
const editor = createEditor(game);
if (new URLSearchParams(location.search).get('edit') === '1') {
  ctx.rig.set({ pos: new THREE.Vector3(0, 70, 22), lookAt: new THREE.Vector3(0, 0, -2), fov: 70 });
  editor.toggle(true);
}

const acts: Act[] = [act1, act2, act3, act4, act5];

async function main() {
  const params = new URLSearchParams(location.search);
  const startAt = Math.max(1, Math.min(5, Number(params.get('act') ?? 1)));
  if (params.get('debug') === '1') {
    ctx.debug.enabled = true;
    game.debugDraw.setEnabled(true);
  }
  const shared: SharedState = {
    cards: {
      island: startAt >= 4,
      crosswalkRetreat: startAt >= 4,
      guideLine: startAt >= 4,
      education: startAt >= 4,
    },
  };
  if (editor.active) {
    // pure scene-inspection mode: no story, just the free camera
    return;
  }
  ctx.ui.setBlack(true);
  await ctx.ui.waitForClick('點擊開始 — 第一章「真的看不到」');
  ctx.audio.unlock();
  for (let i = startAt - 1; i < acts.length; i++) {
    await acts[i].run(ctx, shared);
  }
  ctx.ui.setBlack(true);
  await ctx.ui.waitForClick('第一章結束 — 點擊重新開始');
  location.reload();
}
main();
