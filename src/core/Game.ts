import * as THREE from 'three';
import type { GameContext, IntersectionConfig } from '../types';
import { createInput } from './Input';
import { createCameraRig } from './CameraRig';
import { createAudio } from './AudioImpl';
import { createUI } from '../ui/UIImpl';
import { createWorld } from '../world/World';
import { DebugDraw } from '../dev/DebugDraw';

export interface Game {
  ctx: GameContext;
  state: { paused: boolean };
  onLate(fn: (dt: number) => void): void;
  debugDraw: DebugDraw;
  /** Time-scaled frame hooks that always run (editor, debug overlays). */
  start(): void;
}

export function createGame(configOverrides?: Partial<IntersectionConfig>): Game {
  const app = document.getElementById('app')!;
  const uiRoot = document.getElementById('ui')!;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(app.clientWidth, app.clientHeight);
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb9d3e6);
  scene.fog = new THREE.Fog(0xb9d3e6, 40, 150);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x777788, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.4);
  sun.position.set(30, 60, 20);
  scene.add(sun);

  const rig = createCameraRig(app.clientWidth / app.clientHeight);
  const input = createInput();
  const ui = createUI(uiRoot);
  const audio = createAudio();
  const world = createWorld(configOverrides);
  scene.add(world.group);
  const debugDraw = new DebugDraw(scene);

  const updaters = new Set<(dt: number) => void>();
  const ctx: GameContext = {
    scene,
    renderer,
    rig,
    input,
    ui,
    audio,
    world,
    debug: { enabled: false },
    debugDraw,
    onUpdate(fn) {
      updaters.add(fn);
      return () => updaters.delete(fn);
    },
    wait(ms) {
      return new Promise<void>((resolve) => {
        let left = ms;
        const off = ctx.onUpdate((dt) => {
          left -= dt * 1000;
          if (left <= 0) {
            off();
            resolve();
          }
        });
      });
    },
    until(pred) {
      return new Promise<void>((resolve) => {
        if (pred()) return resolve();
        const off = ctx.onUpdate(() => {
          if (pred()) {
            off();
            resolve();
          }
        });
      });
    },
  };

  window.addEventListener('resize', () => {
    renderer.setSize(app.clientWidth, app.clientHeight);
    rig.resize(app.clientWidth / app.clientHeight);
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F2') {
      ctx.debug.enabled = !ctx.debug.enabled;
      debugDraw.setEnabled(ctx.debug.enabled);
      e.preventDefault();
    }
  });

  const state = { paused: false };
  const late = new Set<(dt: number) => void>();
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!state.paused) {
      for (const fn of [...updaters]) fn(dt);
      rig.tick(dt);
    }
    for (const fn of late) fn(dt);
    renderer.render(scene, rig.camera);
    requestAnimationFrame(frame);
  };

  return {
    ctx,
    state,
    onLate: (fn) => void late.add(fn),
    debugDraw,
    start() {
      last = performance.now();
      requestAnimationFrame(frame);
    },
  };
}
