import type { AudioFx } from '../types';

/** Synthesized WebAudio placeholders. Every method is a safe no-op before unlock(). */
export function createAudio(): AudioFx {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuf: AudioBuffer | null = null;
  let volume = 0.8;
  let cutTimer: ReturnType<typeof setTimeout> | null = null;

  interface Engine {
    o1: OscillatorNode;
    o2: OscillatorNode;
    lp: BiquadFilterNode;
    gain: GainNode;
    vol: number;
  }
  let engine: Engine | null = null;
  let engineSpeed = 0;

  function ensure(): AudioContext | null {
    return ctx;
  }

  function noise(c: AudioContext): AudioBufferSourceNode {
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    return src;
  }

  function applyEngine(c: AudioContext): void {
    if (!engine) return;
    const s = Math.min(1, Math.max(0, engineSpeed));
    const f = 55 + s * (140 - 55);
    const t = c.currentTime;
    engine.o1.frequency.setTargetAtTime(f, t, 0.06);
    engine.o2.frequency.setTargetAtTime(f * 1.005, t, 0.06);
    engine.lp.frequency.setTargetAtTime(240 + s * 600, t, 0.06);
    engine.gain.gain.setTargetAtTime((0.07 + 0.09 * s) * engine.vol, t, 0.08);
  }

  function stopAt(nodes: AudioScheduledSourceNode[], when: number): void {
    for (const n of nodes) {
      try {
        n.stop(when);
      } catch {
        /* ignore */
      }
    }
  }

  const fx: AudioFx = {
    unlock() {
      try {
        if (!ctx) {
          const AC: typeof AudioContext =
            window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          if (!AC) return;
          ctx = new AC();
          master = ctx.createGain();
          master.gain.value = volume;
          master.connect(ctx.destination);
          const len = ctx.sampleRate * 2;
          noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
          const d = noiseBuf.getChannelData(0);
          for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        }
        if (ctx.state === 'suspended') void ctx.resume();
      } catch {
        ctx = null;
        master = null;
      }
    },

    engineStart(opts) {
      const c = ensure();
      if (!c || !master || engine) return;
      const o1 = c.createOscillator();
      const o2 = c.createOscillator();
      o1.type = 'sawtooth';
      o2.type = 'square';
      o2.detune.value = 9;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 2;
      const gain = c.createGain();
      gain.gain.value = 0;
      o1.connect(lp);
      o2.connect(lp);
      lp.connect(gain);
      gain.connect(master);
      o1.start();
      o2.start();
      engine = { o1, o2, lp, gain, vol: opts?.volume ?? 1 };
      applyEngine(c);
    },

    setEngine(speed01) {
      engineSpeed = speed01;
      if (ctx) applyEngine(ctx);
    },

    engineStop() {
      const c = ctx;
      if (!c || !engine) return;
      const e = engine;
      engine = null;
      const t = c.currentTime;
      e.gain.gain.cancelScheduledValues(t);
      e.gain.gain.setTargetAtTime(0, t, 0.05);
      stopAt([e.o1, e.o2], t + 0.4);
    },

    impact() {
      const c = ensure();
      if (!c || !master) return;
      const t = c.currentTime;
      const out = c.createGain();
      out.gain.value = 0.5; // impact is quieter than full scale
      out.connect(master);
      // noise burst, level rises quickly to a peak then decays
      const n = noise(c);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(600, t);
      lp.frequency.exponentialRampToValueAtTime(6000, t + 0.12);
      lp.frequency.exponentialRampToValueAtTime(400, t + 1.2);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1.0, t + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
      const shaper = c.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * 2 - 1;
        curve[i] = Math.tanh(x * 3);
      }
      shaper.curve = curve;
      n.connect(lp);
      lp.connect(g);
      g.connect(shaper);
      shaper.connect(out);
      n.start(t);
      n.stop(t + 1.4);
      // low thump
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(110, t + 0.08);
      o.frequency.exponentialRampToValueAtTime(30, t + 0.7);
      const og = c.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(1.0, t + 0.1);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(og);
      og.connect(out);
      o.start(t);
      o.stop(t + 1);
      // metallic crunch
      const m = c.createOscillator();
      m.type = 'square';
      m.frequency.setValueAtTime(180, t + 0.1);
      m.frequency.exponentialRampToValueAtTime(60, t + 0.5);
      const mg = c.createGain();
      mg.gain.setValueAtTime(0.0001, t);
      mg.gain.exponentialRampToValueAtTime(0.35, t + 0.12);
      mg.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      m.connect(mg);
      mg.connect(out);
      m.start(t);
      m.stop(t + 0.6);
    },

    cutOff() {
      const c = ensure();
      if (!c || !master) return;
      const t = c.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(0, t);
      if (cutTimer) clearTimeout(cutTimer);
      cutTimer = setTimeout(() => {
        cutTimer = null;
        if (ctx && master) {
          const n = ctx.currentTime;
          master.gain.cancelScheduledValues(n);
          master.gain.setValueAtTime(volume, n);
        }
      }, 1500);
    },

    rewind(ms) {
      const c = ensure();
      if (!c || !master) return;
      const t = c.currentTime;
      const dur = Math.max(0.1, ms / 1000);
      // reversed sweep: high -> low pitch (tape spooling backwards)
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(2200, t);
      o.frequency.exponentialRampToValueAtTime(140, t + dur);
      // tape flutter
      const lfo = c.createOscillator();
      lfo.frequency.value = 9;
      const lfoGain = c.createGain();
      lfoGain.gain.value = 60;
      lfo.connect(lfoGain);
      lfoGain.connect(o.detune);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2000, t);
      bp.frequency.exponentialRampToValueAtTime(300, t + dur);
      bp.Q.value = 3;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + Math.min(0.15, dur / 3));
      g.gain.setValueAtTime(0.18, t + dur * 0.8);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      // hiss
      const n = noise(c);
      const nf = c.createBiquadFilter();
      nf.type = 'highpass';
      nf.frequency.value = 3000;
      const ng = c.createGain();
      ng.gain.value = 0.04;
      const flutter = c.createOscillator();
      flutter.type = 'square';
      flutter.frequency.value = 18;
      const fg = c.createGain();
      fg.gain.value = 0.02;
      flutter.connect(fg);
      fg.connect(ng.gain);
      o.connect(bp);
      bp.connect(g);
      g.connect(master);
      n.connect(nf);
      nf.connect(ng);
      ng.connect(master);
      const all = [o, lfo, n, flutter];
      for (const s of all) s.start(t);
      stopAt(all, t + dur + 0.05);
    },

    beep() {
      const c = ensure();
      if (!c || !master) return;
      const t = c.currentTime;
      const tone = (f: number, at: number, len: number) => {
        const o = c.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t + at);
        g.gain.exponentialRampToValueAtTime(0.35, t + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + at + len);
        o.connect(g);
        g.connect(master!);
        o.start(t + at);
        o.stop(t + at + len + 0.05);
      };
      tone(880, 0, 0.14);
      tone(1318.5, 0.15, 0.3);
    },

    bump() {
      const c = ensure();
      if (!c || !master) return;
      const t = c.currentTime;
      // low thud (raised to 140->60 Hz so it is audible on small speakers)
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(55, t + 0.25);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.7, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + 0.45);
      // short mid-range knock so the hit reads clearly
      const n = noise(c);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 500;
      bp.Q.value = 0.8;
      const ng = c.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(0.5, t + 0.008);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      n.connect(bp);
      bp.connect(ng);
      ng.connect(master);
      n.start(t);
      n.stop(t + 0.2);
    },

    horn() {
      const c = ensure();
      if (!c || !master) return;
      const t = c.currentTime;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.03);
      g.gain.setValueAtTime(0.3, t + 0.55);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      lp.connect(g);
      g.connect(master);
      for (const f of [420, 525]) {
        const o = c.createOscillator();
        o.type = 'square';
        o.frequency.value = f;
        o.connect(lp);
        o.start(t);
        o.stop(t + 0.75);
      }
    },

    setMasterVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      if (ctx && master && !cutTimer) {
        const n = ctx.currentTime;
        master.gain.cancelScheduledValues(n);
        master.gain.setValueAtTime(volume, n);
      }
    },
  };
  return fx;
}
