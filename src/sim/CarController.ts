import type { CarParams, CarState, DriveInput, Obb } from '../types';

/**
 * Kinematic bicycle-ish car.
 *   yaw rate = speed * tan(steerAngle) / wheelBase, then capped by maxSteerRate and by a
 *   lateral-acceleration limit. => cannot turn in place, min turn radius CAR_TUNING.minTurnRadius
 *   (at <= ~5.8 m/s), radius grows with speed above that.
 * yaw convention: heading = (-sin yaw, -cos yaw); +yaw = left turn.
 */
export const defaultCarParams: CarParams = {
  maxSpeed: 7, // m/s (~25 km/h), hard cap (see update())
  accel: 3.2, // m/s^2 at standstill (fades towards maxSpeed)
  brake: 9, // m/s^2 (S key)
  drag: 0.8, // m/s^2 constant coasting deceleration (plus CAR_TUNING.dragPerSpeed * v)
  wheelBase: 2.7,
  maxSteerRate: 1.2, // rad/s yaw-rate cap
  halfWidth: 0.9,
  halfLength: 2.2,
};

export const CAR_TUNING = {
  minTurnRadius: 4.8, // m, at full lock, low speed
  maxLatAccel: 7.0, // m/s^2 cap on v * yawRate
  steerRise: 3.2, // steer units / s while key held
  steerFall: 5.0, // steer units / s returning to centre / opposite
  dragPerSpeed: 0.03, // 1/s, aerodynamic-ish
  autoStopDecel: 5.0, // m/s^2 used by setAutoStop
  autoStopRamp: 4.0, // brake level ramp (1/s) => smooth onset
};

export class CarController {
  state: CarState = { x: 0, z: 0, yaw: 0, speed: 0, steer: 0 };
  /** last computed yaw rate (rad/s), for debug / prediction */
  yawRate = 0;
  readonly params: CarParams;
  private autoStop: ((s: CarState) => boolean) | null = null;
  private autoLevel = 0;
  /** When set, the car keeps rolling at (at least) this speed: releasing W doesn't slow it, S is ignored. */
  private cruiseMin: number | null = null;

  setCruise(minSpeed: number | null): void {
    this.cruiseMin = minSpeed;
  }

  constructor(params: CarParams = defaultCarParams) {
    this.params = params;
  }

  reset(x: number, z: number, yaw = 0, speed = 0): void {
    this.state = { x, z, yaw, speed: Math.max(0, speed), steer: 0 };
    this.yawRate = 0;
    this.autoLevel = 0;
  }

  /** fn returns true => car brakes smoothly to a stop and ignores W. Pass null to clear. */
  setAutoStop(fn: ((s: CarState) => boolean) | null): void {
    this.autoStop = fn;
    if (!fn) this.autoLevel = 0;
  }

  obb(): Obb {
    const s = this.state;
    return { cx: s.x, cz: s.z, hw: this.params.halfWidth, hl: this.params.halfLength, yaw: s.yaw };
  }

  update(dt: number, input: DriveInput): void {
    if (dt <= 0) return;
    const p = this.params;
    const st = this.state;

    // --- steering (smoothed) ---
    let target = 0;
    if (input.a && !input.d) target = 1;
    else if (input.d && !input.a) target = -1;
    const towardsCentre = target === 0 || Math.sign(target) !== Math.sign(st.steer);
    const rate = towardsCentre ? CAR_TUNING.steerFall : CAR_TUNING.steerRise;
    const dSteer = target - st.steer;
    const maxStep = rate * dt;
    st.steer += Math.abs(dSteer) <= maxStep ? dSteer : Math.sign(dSteer) * maxStep;
    st.steer = Math.max(-1, Math.min(1, st.steer));

    // --- longitudinal ---
    const auto = this.autoStop ? this.autoStop(st) : false;
    const lvlTarget = auto ? 1 : 0;
    const dl = lvlTarget - this.autoLevel;
    const lstep = CAR_TUNING.autoStopRamp * dt;
    this.autoLevel += Math.abs(dl) <= lstep ? dl : Math.sign(dl) * lstep;

    let acc = 0;
    const wHeld = input.w && !auto;
    const cruising = this.cruiseMin !== null && !auto;
    if (input.s && !cruising) {
      acc = -p.brake;
    } else if (wHeld) {
      const f = Math.max(0, 1 - (st.speed / p.maxSpeed) ** 2);
      acc = p.accel * f;
    } else if (cruising) {
      acc = st.speed < this.cruiseMin! ? p.accel : 0;
    } else {
      acc = -(p.drag + CAR_TUNING.dragPerSpeed * st.speed);
    }
    if (this.autoLevel > 0) acc = Math.min(acc, -CAR_TUNING.autoStopDecel * this.autoLevel);
    st.speed = Math.min(p.maxSpeed, Math.max(0, st.speed + acc * dt)); // never negative (S never reverses), never above the cap
    if (st.speed < 0.02 && acc < 0) st.speed = 0;

    // --- yaw (bicycle) ---
    const maxDelta = Math.atan(p.wheelBase / CAR_TUNING.minTurnRadius);
    const delta = st.steer * maxDelta;
    let yawRate = (st.speed * Math.tan(delta)) / p.wheelBase;
    const lim = Math.min(p.maxSteerRate, st.speed > 0.1 ? CAR_TUNING.maxLatAccel / st.speed : p.maxSteerRate);
    yawRate = Math.max(-lim, Math.min(lim, yawRate));
    this.yawRate = yawRate;

    const yawMid = st.yaw + yawRate * dt * 0.5;
    st.yaw += yawRate * dt;
    st.x += -Math.sin(yawMid) * st.speed * dt;
    st.z += -Math.cos(yawMid) * st.speed * dt;
  }
}
