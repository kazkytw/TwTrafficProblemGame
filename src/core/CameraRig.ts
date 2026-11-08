import * as THREE from 'three';
import type { CameraMode, CameraPose, CameraRig, CarState, DriverEye, Vec2 } from '../types';

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

interface Tween {
  from: CameraPose;
  to: CameraPose;
  t: number;
  ms: number;
  done: () => void;
}
interface Playback {
  frames: { t: number; pose: CameraPose }[];
  t: number;
  done: () => void;
}

/**
 * Owns the single PerspectiveCamera. Call `tick(dt)` every frame BEFORE render.
 * While a tween/keyframe playback is active, follow* calls are ignored so
 * cinematic moves are not overwritten by the act's per-frame follow.
 */
export function createCameraRig(aspect: number): CameraRig & { tick(dt: number): void; resize(aspect: number): void } {
  const camera = new THREE.PerspectiveCamera(70, aspect, 0.05, 400);
  const pose: CameraPose = {
    pos: new THREE.Vector3(0, 10, 30),
    lookAt: new THREE.Vector3(0, 0, 0),
    fov: 70,
    roll: 0,
  };
  let tween: Tween | null = null;
  let play: Playback | null = null;
  const eyeHeight = { pedestrian: 1.6, driver: 1.15 };

  const clonePose = (p: CameraPose): CameraPose => ({
    pos: p.pos.clone(),
    lookAt: p.lookAt.clone(),
    fov: p.fov,
    roll: p.roll,
  });
  const merge = (base: CameraPose, p: Partial<CameraPose>): CameraPose => ({
    pos: p.pos ? p.pos.clone() : base.pos.clone(),
    lookAt: p.lookAt ? p.lookAt.clone() : base.lookAt.clone(),
    fov: p.fov ?? base.fov,
    roll: p.roll ?? base.roll,
  });
  const lerpPose = (a: CameraPose, b: CameraPose, k: number): CameraPose => ({
    pos: a.pos.clone().lerp(b.pos, k),
    lookAt: a.lookAt.clone().lerp(b.lookAt, k),
    fov: a.fov + (b.fov - a.fov) * k,
    roll: a.roll + (b.roll - a.roll) * k,
  });
  const apply = () => {
    camera.position.copy(pose.pos);
    camera.up.set(0, 1, 0);
    camera.lookAt(pose.lookAt);
    if (pose.roll) camera.rotateZ(pose.roll);
    if (camera.fov !== pose.fov) {
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
    }
  };
  const setPose = (p: CameraPose) => {
    pose.pos.copy(p.pos);
    pose.lookAt.copy(p.lookAt);
    pose.fov = p.fov;
    pose.roll = p.roll;
  };

  const rig = {
    camera,
    mode: 'free' as CameraMode,
    eyeHeight,
    setMode(m: CameraMode) {
      rig.mode = m;
    },
    set(p: Partial<CameraPose>) {
      setPose(merge(pose, p));
      apply();
    },
    tweenTo(p: Partial<CameraPose>, ms: number) {
      return new Promise<void>((resolve) => {
        tween?.done();
        tween = { from: clonePose(pose), to: merge(pose, p), t: 0, ms: Math.max(1, ms), done: resolve };
      });
    },
    playKeyframes(frames: { t: number; pose: Partial<CameraPose> }[]) {
      return new Promise<void>((resolve) => {
        play?.done();
        let base = clonePose(pose);
        const abs = frames
          .slice()
          .sort((a, b) => a.t - b.t)
          .map((f) => {
            base = merge(base, f.pose);
            return { t: f.t, pose: clonePose(base) };
          });
        play = { frames: abs, t: 0, done: resolve };
      });
    },
    followDriver(car: CarState, eye: DriverEye) {
      if (tween || play) return;
      const fx = -Math.sin(car.yaw);
      const fz = -Math.cos(car.yaw);
      const rx = Math.cos(car.yaw);
      const rz = -Math.sin(car.yaw);
      pose.pos.set(car.x + rx * eye.right + fx * eye.forward, eye.up, car.z + rz * eye.right + fz * eye.forward);
      pose.lookAt.set(pose.pos.x + fx * 10, eye.up + Math.tan(((eye.pitchDeg ?? 0) * Math.PI) / 180) * 10, pose.pos.z + fz * 10);
      pose.fov = eye.fov ?? 75;
      pose.roll = 0;
      apply();
    },
    followPedestrian(pos: Vec2, yaw: number, pitch = 0) {
      if (tween || play) return;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      pose.pos.set(pos.x, eyeHeight.pedestrian, pos.z);
      pose.lookAt.set(pos.x + fx * 10, eyeHeight.pedestrian + Math.tan(pitch) * 10, pos.z + fz * 10);
      pose.fov = 72;
      pose.roll = 0;
      apply();
    },
    tick(dt: number) {
      if (play) {
        play.t += dt * 1000;
        const f = play.frames;
        const end = f[f.length - 1].t;
        if (play.t >= end) {
          setPose(f[f.length - 1].pose);
          const d = play.done;
          play = null;
          d();
        } else {
          let i = 0;
          while (i < f.length - 1 && f[i + 1].t <= play.t) i++;
          const a = f[i];
          const b = f[Math.min(i + 1, f.length - 1)];
          const k = b.t === a.t ? 1 : (play.t - a.t) / (b.t - a.t);
          setPose(lerpPose(a.pose, b.pose, ease(Math.min(1, Math.max(0, k)))));
        }
        apply();
      } else if (tween) {
        tween.t += dt * 1000;
        const k = Math.min(1, tween.t / tween.ms);
        setPose(lerpPose(tween.from, tween.to, ease(k)));
        apply();
        if (k >= 1) {
          const d = tween.done;
          tween = null;
          d();
        }
      }
    },
    resize(aspect: number) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },
  };
  apply();
  return rig;
}
