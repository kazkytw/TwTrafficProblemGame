import * as THREE from 'three';
import GUI from 'lil-gui';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Game } from '../core/Game';
import type { IntersectionConfig } from '../types';
import { makeRibbon, disposeObject } from '../acts/helpers';
import { lanes } from '../world/lanes';
import { createCarMesh } from '../sim/CarMesh';
import { previewBlindSpawn, previewEarlySpawn, defaultEarlySpawnDistance } from '../sim/PedestrianSpawner';
import { DRIVER_EYE, aPillarFan } from '../sim/CarMesh';
import { createPlayerCar, remeasurePillar, pillarInfo, SIDE_MIRROR, refreshMirrors } from '../sim/CarModel';

/**
 * Dev editor. Toggle with F3 (or ?edit=1). Free-fly camera:
 *   hold right mouse = look, W/A/S/D = move, Q/E = down/up, Shift = fast, wheel = speed.
 * Game input is blocked while active; the game is paused by default (checkbox in panel).
 */
export function createEditor(game: Game) {
  const { ctx } = game;
  const cam = ctx.rig.camera;
  let active = false;
  let gui: GUI | null = null;
  const overlay = new THREE.Group();
  ctx.scene.add(overlay);

  // free cam state
  let yaw = 0;
  let pitch = 0;
  let speed = ctx.world.config.editorCamSpeed ?? 14;
  const saveSpeed = () => {
    ctx.world.config.editorCamSpeed = speed;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, 600); // saved into public/intersection.json with everything else
  };
  const keys = new Set<string>();
  let looking = false;

  // island proxy + transform controls
  const proxy = new THREE.Object3D();
  ctx.scene.add(proxy);
  const tc = new TransformControls(cam, ctx.renderer.domElement);
  tc.setMode('translate');
  tc.showY = false;
  tc.enabled = false;
  const tcHelper = tc.getHelper();
  tcHelper.visible = false;
  ctx.scene.add(tcHelper);

  const params = { pause: true, showPaths: true, debugDraw: true, showIsland: false, driverPreview: false, gizmo: '庇護島' as string };

  // ---- driver-eye preview: the player car parked at the start with the live eye sliders ----
  let previewCar: THREE.Group | null = null;
  const previewState = { x: lanes(ctx.world.config).nsInner, z: 30, yaw: 0, speed: 0, steer: 0 };
  const eyeStatus = { text: '' };
  let speedCtl: { setValue(v: number): unknown } | null = null;
  const spawnInfo = { carDist: '', eyeDist: '', angle: '', hidden: '' };
  const earlyInfo = { dist: '' };
  const spawnCtls: { updateDisplay(): unknown }[] = [];
  let eyeStatusCtl: { updateDisplay(): unknown } | null = null;
  let eyeSaveTimer = 0;
  const saveEye = async () => {
    const body = JSON.stringify({
      right: DRIVER_EYE.right,
      up: DRIVER_EYE.up,
      forward: DRIVER_EYE.forward,
      pitchDeg: DRIVER_EYE.pitchDeg ?? 0,
      fov: DRIVER_EYE.fov ?? 75,
    });
    try {
      const r = await fetch('/__save-config?name=driver-eye', { method: 'POST', body });
      status.text = r.ok ? '眼位已儲存 ' + new Date().toLocaleTimeString() : '眼位儲存失敗 ' + r.status;
    } catch {
      status.text = '眼位儲存失敗';
    }
    statusCtl?.updateDisplay();
  };
  let mirrorSaveTimer = 0;
  const onMirrorChange = () => {
    refreshMirrors();
    clearTimeout(mirrorSaveTimer);
    mirrorSaveTimer = window.setTimeout(async () => {
      try {
        const r = await fetch('/__save-config?name=side-mirror', { method: 'POST', body: JSON.stringify(SIDE_MIRROR) });
        status.text = r.ok ? '後照鏡已儲存 ' + new Date().toLocaleTimeString() : '後照鏡儲存失敗 ' + r.status + '（改過 vite.config 要重開 dev server）';
      } catch {
        status.text = '後照鏡儲存失敗';
      }
      statusCtl?.updateDisplay();
    }, 250);
  };
  const onEyeChange = () => {
    clearTimeout(eyeSaveTimer);
    eyeSaveTimer = window.setTimeout(() => {
      remeasurePillar();
      eyeStatus.text = `A柱 ${pillarInfo.minDeg.toFixed(1)}° ~ ${pillarInfo.maxDeg.toFixed(1)}°（寬 ${(pillarInfo.maxDeg - pillarInfo.minDeg).toFixed(1)}°）`;
      eyeStatusCtl?.updateDisplay();
      saveEye();
    }, 250);
  };
  function setPreview(on: boolean) {
    if (on && !previewCar) {
      previewCar = createPlayerCar();
      if (previewCar) {
        previewCar.position.set(previewState.x, 0, previewState.z);
        ctx.scene.add(previewCar);
      }
    } else if (!on && previewCar) {
      ctx.scene.remove(previewCar);
      previewCar = null;
    }
  }

  let rebuildTimer = 0;
  let saveTimer = 0;
  const status = { text: '(尚未儲存)' };
  let statusCtl: { updateDisplay(): unknown } | null = null;
  /** Writes the geometry (not the card toggles) to public/intersection.json through the dev server. */
  const save = async () => {
    const cfg = { ...ctx.world.config, island: false, crosswalkRetreat: false, guideLine: false, education: false };
    try {
      const r = await fetch('/__save-config', { method: 'POST', body: JSON.stringify(cfg) });
      status.text = r.ok ? '已儲存 ' + new Date().toLocaleTimeString() : '儲存失敗 ' + r.status;
    } catch {
      status.text = '儲存失敗（非 dev server？）';
    }
    statusCtl?.updateDisplay();
  };
  const scheduleRebuild = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(() => {
      ctx.world.rebuild({ ...ctx.world.config } as Partial<IntersectionConfig>);
      refreshOverlay();
    }, 60);
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, 600); // autosave
  };

  /** The drag gizmo only exists while the editor is open AND the checkbox is on (never in the game). */
  function syncGizmo() {
    const on = active && params.showIsland;
    if (on) tc.attach(proxy);
    else tc.detach();
    tc.enabled = on;
    tcHelper.visible = on;
  }

  function refreshOverlay() {
    [...overlay.children].forEach(disposeObject);
    game.debugDraw.clearAll();
    if (!active) return;
    if (params.showPaths) {
      overlay.add(makeRibbon(ctx.world.leftTurnPath('viaCenter'), 0xff4d3d, 0.5, 0.3));
      overlay.add(makeRibbon(ctx.world.leftTurnPath('cutCorner'), 0xffb300, 0.5, 0.32));
      overlay.add(makeRibbon(ctx.world.leftTurnPath('act1Hit'), 0xff6fb5, 0.5, 0.34));
      overlay.add(makeRibbon(ctx.world.pedestrianPath(), 0x2f7dff, 0.5, 0.3));
    }
    ctx.world.obstacles.forEach((o, i) => game.debugDraw.drawObb('obs' + i, o.box, o.tag === 'island' ? 0xffaa00 : o.tag === 'median' ? 0x44ddaa : 0x8888ff));
    const ib = ctx.world.config.islandBox;
    const wc = (ctx.world.config.waitingCar ??= { x: -lanes(ctx.world.config).nsInner, z: -1, yaw: Math.PI });
    // the waiting left-turn car, shown so it can be placed
    const wm = createCarMesh({ color: 0x4a4f5a });
    wm.position.set(wc.x, 0, wc.z);
    wm.rotation.y = wc.yaw;
    overlay.add(wm);
    // where the walker appears for the current settings (same rules as the game), drawn on the reference path
    {
      const addCar = (c: { x: number; z: number; yaw: number }, color: number) => {
        const cm = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.2, 4.4), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 }));
        cm.position.set(c.x, 0.2, c.z);
        cm.rotation.y = c.yaw;
        overlay.add(cm);
      };
      const addPed = (p: { x: number; z: number }, color: number) => {
        const mk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 2.2, 16), new THREE.MeshBasicMaterial({ color }));
        mk.position.set(p.x, 1.1, p.z);
        overlay.add(mk);
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.8, 24), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(p.x, 0.06, p.z);
        overlay.add(ring);
      };
      const b = previewBlindSpawn(ctx.world);
      if (b) {
        const fan = aPillarFan(b.car);
        game.debugDraw.drawFan('blindfan', fan.origin, fan.yawCentre, fan.halfAngle, b.eyeDist + 3, 0xffcc00); // A-pillar sector
        addCar(b.car, 0x44aaff); // blue = car when the walker spawns
        addPed(b.ped, 0xff2222); // red = walker
        overlay.add(makeRibbon([b.eye, b.ped], 0xff2222, 0.1, 0.4)); // sight line eye -> walker
        spawnInfo.carDist = `${b.carDist.toFixed(1)} m`;
        spawnInfo.eyeDist = `${b.eyeDist.toFixed(1)} m`;
        spawnInfo.angle = `${b.bearingDeg.toFixed(0)}°（A柱 ${pillarInfo.minDeg.toFixed(0)}~${pillarInfo.maxDeg.toFixed(0)}°）`;
        spawnInfo.hidden = b.offDeg <= 0.5 ? '藏在A柱後' : `露出（偏出 ${b.offDeg.toFixed(0)}°）`;
      } else {
        spawnInfo.carDist = spawnInfo.eyeDist = spawnInfo.angle = spawnInfo.hidden = '（路徑上找不到）';
      }
      const e = previewEarlySpawn(ctx.world);
      if (e) {
        addCar(e.car, 0x33cc66); // green = act 4 spawn
        addPed(e.ped, 0x33cc66);
        overlay.add(makeRibbon([e.car, e.ped], 0x33cc66, 0.1, 0.4));
        earlyInfo.dist = `離車 ${e.dist.toFixed(1)} m`;
      } else {
        earlyInfo.dist = '（路徑上找不到）';
      }
      spawnCtls.forEach((c) => c.updateDisplay());
    }
    game.debugDraw.drawObb('waitcar', { cx: wc.x, cz: wc.z, hw: 0.9, hl: 2.2, yaw: wc.yaw }, 0x44ff88);
    if (params.gizmo === '左轉車') proxy.position.set(wc.x, 0.3, wc.z);
    else proxy.position.set(ib.cx, 0.3, ib.cz);
  }

  function setView(pos: THREE.Vector3, look: THREE.Vector3) {
    cam.position.copy(pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(look);
    const d = look.clone().sub(pos).normalize();
    yaw = Math.atan2(-d.x, -d.z);
    pitch = Math.asin(d.y);
  }

  function buildGui() {
    spawnCtls.length = 0;
    gui?.destroy();
    const g = new GUI({ title: 'Editor (F3 close)' });
    gui = g;
    const cfg = ctx.world.config;
    g.add(params, 'pause').name('暫停遊戲').onChange((v: boolean) => (game.state.paused = v));
    g.add(params, 'showPaths').name('顯示左轉/行人路徑').onChange(refreshOverlay);
    g.add(params, 'debugDraw').name('碰撞框 / A柱扇形').onChange((v: boolean) => {
      ctx.debug.enabled = v;
      game.debugDraw.setEnabled(v);
      refreshOverlay();
    });
    const views: Record<string, () => void> = {
      俯瞰: () => setView(new THREE.Vector3(0, 70, 22), new THREE.Vector3(0, 0, -2)),
      正上方: () => setView(new THREE.Vector3(0, 95, 0.1), new THREE.Vector3(0, 0, 0)),
      駕駛起點: () => setView(new THREE.Vector3(2.2, 1.2, 44), new THREE.Vector3(2.2, 1, 0)),
      行人視角: () => {
        const w = ctx.world.westCrosswalk();
        setView(new THREE.Vector3(w.south.x, 1.6, w.south.z + 4), new THREE.Vector3(w.south.x, 1.6, w.north.z - 6));
      },
    };
    const fc = g.addFolder('鏡頭');
    for (const [k, f] of Object.entries(views)) fc.add({ f }, 'f').name(k);
    const speedObj = { v: speed };
    speedCtl = fc.add(speedObj, 'v', 2, 80).name('移動速度').onChange((v: number) => {
      speed = v;
      saveSpeed();
    });

    const fe = g.addFolder('駕駛眼位（開預覽才看得到）');
    fe.add(params, 'driverPreview').name('預覽駕駛視角').onChange((v: boolean) => {
      setPreview(v);
      if (v) {
        remeasurePillar();
        onEyeChange();
      }
    });
    fe.add(DRIVER_EYE, 'right', -1, 0.3, 0.01).name('左右（負=偏左）').onChange(onEyeChange);
    fe.add(DRIVER_EYE, 'up', 0.7, 2, 0.01).name('高度').onChange(onEyeChange);
    fe.add(DRIVER_EYE, 'forward', -0.8, 1.6, 0.01).name('前後（正=靠前）').onChange(onEyeChange);
    DRIVER_EYE.pitchDeg ??= 0;
    DRIVER_EYE.fov ??= 75;
    fe.add(DRIVER_EYE as { pitchDeg: number }, 'pitchDeg', -20, 20, 0.1).name('仰角（正=抬頭）').onChange(onEyeChange);
    fe.add(DRIVER_EYE as { fov: number }, 'fov', 50, 110, 1).name('視野 FOV').onChange(onEyeChange);
    eyeStatusCtl = fe.add(eyeStatus, 'text').name('A柱量測').disable();
    const fm = g.addFolder('左側後照鏡（存到 public/side-mirror.json）');
    fm.add(SIDE_MIRROR, 'show').name('顯示').onChange(onMirrorChange);
    fm.add(SIDE_MIRROR, 'x', -1.5, -0.7, 0.01).name('左右（越負越外）').onChange(onMirrorChange);
    fm.add(SIDE_MIRROR, 'y', 0.6, 1.6, 0.01).name('高度').onChange(onMirrorChange);
    fm.add(SIDE_MIRROR, 'z', -2.2, 0.2, 0.01).name('前後（越負越前）').onChange(onMirrorChange);
    fm.add(SIDE_MIRROR, 'size', 0.4, 2.5, 0.05).name('大小倍率').onChange(onMirrorChange);

    const f = g.addFolder('路口');
    f.add(cfg, 'nsHalfWidth', 5, 12, 0.1).name('南北向半寬（四線）').onChange(scheduleRebuild);
    f.add(cfg, 'ewHalfWidth', 2.4, 7, 0.1).name('東西向半寬（雙線）').onChange(scheduleRebuild);
    f.add(cfg, 'crosswalkWidth', 2, 6).onChange(scheduleRebuild);
    f.add(cfg, 'crosswalkSetback', 0, 8).onChange(scheduleRebuild);
    f.add(cfg, 'crosswalkRetreatExtra', 0, 10).onChange(scheduleRebuild);
    (['island', 'crosswalkRetreat', 'guideLine', 'education'] as const).forEach((k) =>
      f.add(cfg, k).name('卡片：' + k).onChange(scheduleRebuild),
    );
    const fi = g.addFolder('庇護島');
    const ib = cfg.islandBox;
    fi.add(params, 'showIsland').name('顯示拖曳軸').onChange(syncGizmo);
    fi.add(ib, 'cx', -25, 25, 0.05).onChange(scheduleRebuild);
    fi.add(ib, 'cz', -25, 25, 0.05).onChange(scheduleRebuild);
    fi.add(ib, 'hw', 0.2, 3, 0.05).onChange(scheduleRebuild);
    fi.add(ib, 'hl', 0.2, 5, 0.05).onChange(scheduleRebuild);
    fi.add(ib, 'yaw', -Math.PI, Math.PI, 0.01).onChange(scheduleRebuild);
    const fw = g.addFolder('對向等待左轉車');
    const wcfg = (cfg.waitingCar ??= { x: -lanes(cfg).nsInner, z: -1, yaw: Math.PI });
    fw.add(params, 'gizmo', ['庇護島', '左轉車']).name('拖曳軸控制對象').onChange(refreshOverlay);
    fw.add(wcfg, 'x', -12, 12, 0.05).name('x').onChange(scheduleRebuild);
    fw.add(wcfg, 'z', -12, 12, 0.05).name('z').onChange(scheduleRebuild);
    fw.add(wcfg, 'yaw', -Math.PI, Math.PI, 0.01).name('朝向 yaw（π=朝南）').onChange(scheduleRebuild);
    const fp = g.addFolder('行人移動速度');
    cfg.pedWalkSpeed ??= 1.4;
    fp.add(cfg as { pedWalkSpeed: number }, 'pedWalkSpeed', 0.5, 4, 0.05).name('m/s（第一幕玩家 + 行人）').onChange(scheduleRebuild);
    const fb = g.addFolder('第二幕行人生成（橘線切西瓜；藍車=生成瞬間 紅=行人 黃扇=A柱）');
    cfg.pedSpawnDistance ??= 4;
    fb.add(cfg as { pedSpawnDistance: number }, 'pedSpawnDistance', 0, 12, 0.1).name('生成距離 m').onChange(scheduleRebuild);
    cfg.pedBlindBearingDeg ??= cfg.pedBearingDeg ?? 25;
    fb.add(cfg as { pedBlindBearingDeg: number }, 'pedBlindBearingDeg', 0, 70, 1).name('生成方位角（車頭向左）').onChange(scheduleRebuild);
    spawnCtls.push(
      fb.add(spawnInfo, 'carDist').name('→ 車頭離行穿線').disable(),
      fb.add(spawnInfo, 'eyeDist').name('→ 行人離眼睛').disable(),
      fb.add(spawnInfo, 'angle').name('→ 行人實際角度').disable(),
      fb.add(spawnInfo, 'hidden').name('→ 生成瞬間').disable(),
    );
    const ft = g.addFolder('第四幕行人生成（紅線繞路心；綠車/綠柱）');
    cfg.pedEarlySpawnDistance ??= defaultEarlySpawnDistance;
    ft.add(cfg as { pedEarlySpawnDistance: number }, 'pedEarlySpawnDistance', 3, 20, 0.1).name('生成距離 m').onChange(scheduleRebuild);
    cfg.pedBearingDeg ??= 25;
    ft.add(cfg as { pedBearingDeg: number }, 'pedBearingDeg', 0, 50, 1).name('生成方位角（越小越近車頭）').onChange(scheduleRebuild);
    spawnCtls.push(ft.add(earlyInfo, 'dist').name('→ 行人').disable());
    statusCtl = g.add(status, 'text').name('儲存狀態').disable();
    g.add({ save }, 'save').name('立即儲存到 public/intersection.json');
    g.add(
      {
        export() {
          const json = JSON.stringify(ctx.world.config, null, 2);
          navigator.clipboard?.writeText(json).catch(() => {});
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
          a.download = 'intersection.json';
          a.click();
          console.log(json);
        },
      },
      'export',
    ).name('匯出 intersection.json');
  }

  tc.addEventListener('objectChange', () => {
    const wc = ctx.world.config.waitingCar;
    if (params.gizmo === '左轉車' && wc) {
      wc.x = proxy.position.x;
      wc.z = proxy.position.z;
    } else {
      const ib = ctx.world.config.islandBox;
      ib.cx = proxy.position.x;
      ib.cz = proxy.position.z;
    }
    scheduleRebuild();
    gui?.controllersRecursive().forEach((c) => c.updateDisplay());
  });

  const dom = ctx.renderer.domElement;
  dom.addEventListener('contextmenu', (e) => active && e.preventDefault());
  dom.addEventListener('pointerdown', (e) => {
    if (active && e.button === 2) {
      looking = true;
      dom.setPointerCapture(e.pointerId);
    }
  });
  dom.addEventListener('pointerup', (e) => {
    if (e.button === 2) {
      looking = false;
      dom.releasePointerCapture?.(e.pointerId);
    }
  });
  dom.addEventListener('pointermove', (e) => {
    if (!active || !looking) return;
    yaw -= e.movementX * 0.003;
    pitch = Math.max(-1.55, Math.min(1.55, pitch - e.movementY * 0.003));
  });
  dom.addEventListener('wheel', (e) => {
    if (!active) return;
    speed = Math.max(2, Math.min(80, speed * (e.deltaY < 0 ? 1.15 : 0.87)));
    saveSpeed();
    speedCtl?.setValue(speed);
  });

  const GAME_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  // capture phase: keep WASD away from the game's Input while editing
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.code === 'F3') {
        toggle();
        e.preventDefault();
        return;
      }
      if (!active) return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      keys.add(e.code);
      if (GAME_KEYS.includes(e.code)) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (e) => {
      keys.delete(e.code);
      if (active && GAME_KEYS.includes(e.code)) e.stopImmediatePropagation();
    },
    true,
  );

  game.onLate((dt) => {
    if (!active) return;
    if (params.driverPreview && previewCar) {
      // camera exactly as the game computes it, so what you tune is what you get
      const st = previewState;
      const e = DRIVER_EYE;
      const fx = -Math.sin(st.yaw), fz = -Math.cos(st.yaw), rx = Math.cos(st.yaw), rz = -Math.sin(st.yaw);
      cam.position.set(st.x + rx * e.right + fx * e.forward, e.up, st.z + rz * e.right + fz * e.forward);
      cam.up.set(0, 1, 0);
      cam.lookAt(cam.position.x + fx * 10, e.up + Math.tan(((e.pitchDeg ?? 0) * Math.PI) / 180) * 10, cam.position.z + fz * 10);
      if (cam.fov !== (e.fov ?? 75)) {
        cam.fov = e.fov ?? 75;
        cam.updateProjectionMatrix();
      }
      if (ctx.debug.enabled) {
        const fan = aPillarFan(st);
        game.debugDraw.drawFan('fan', fan.origin, fan.yawCentre, fan.halfAngle, 30, 0xffcc00);
      }
      return;
    }
    const fwd = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const v = new THREE.Vector3();
    if (keys.has('KeyW')) v.add(fwd);
    if (keys.has('KeyS')) v.sub(fwd);
    if (keys.has('KeyD')) v.add(right);
    if (keys.has('KeyA')) v.sub(right);
    if (keys.has('KeyE')) v.y += 1;
    if (keys.has('KeyQ')) v.y -= 1;
    if (v.lengthSq() > 0) v.normalize().multiplyScalar(speed * (keys.has('ShiftLeft') ? 3 : 1) * dt);
    cam.position.add(v);
    cam.up.set(0, 1, 0);
    cam.lookAt(cam.position.clone().add(fwd));
    if (cam.fov !== 70) {
      cam.fov = 70;
      cam.updateProjectionMatrix();
    }
  });

  function toggle(force?: boolean) {
    active = force ?? !active;
    if (active) {
      const d = new THREE.Vector3();
      cam.getWorldDirection(d);
      yaw = Math.atan2(-d.x, -d.z);
      pitch = Math.asin(d.y);
      game.state.paused = params.pause;
      ctx.rig.setMode('free');
      ctx.debug.enabled = params.debugDraw;
      game.debugDraw.setEnabled(params.debugDraw);
      buildGui();
      syncGizmo();
    } else {
      game.state.paused = false;
      gui?.destroy();
      gui = null;
      params.driverPreview = false;
      setPreview(false);
      syncGizmo();
      looking = false;
    }
    refreshOverlay();
  }

  return {
    toggle,
    get active() {
      return active;
    },
  };
}
