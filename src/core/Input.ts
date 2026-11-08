import type { InputState } from '../types';

const MAP: Record<string, 'w' | 'a' | 's' | 'd'> = {
  KeyW: 'w',
  KeyA: 'a',
  KeyS: 's',
  KeyD: 'd',
  ArrowUp: 'w',
  ArrowLeft: 'a',
  ArrowDown: 's',
  ArrowRight: 'd',
};

export function createInput(): InputState & { dispose(): void; reset(): void } {
  const codes = new Set<string>();
  const st = {
    w: false,
    a: false,
    s: false,
    d: false,
    get any() {
      return st.w || st.a || st.s || st.d;
    },
    down: (code: string) => codes.has(code),
    reset() {
      codes.clear();
      st.w = st.a = st.s = st.d = false;
    },
    dispose() {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', st.reset);
    },
  };
  const onDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    codes.add(e.code);
    const k = MAP[e.code];
    if (k) {
      st[k] = true;
      e.preventDefault();
    }
  };
  const onUp = (e: KeyboardEvent) => {
    codes.delete(e.code);
    const k = MAP[e.code];
    if (k) st[k] = false;
  };
  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
  window.addEventListener('blur', st.reset);
  return st;
}
