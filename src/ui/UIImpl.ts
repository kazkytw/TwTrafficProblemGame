import type { UI } from '../types';

const CSS = `
.tw-layer{position:absolute;inset:0;pointer-events:none}
.tw-black{background:#000;opacity:0;z-index:10;transition:opacity 600ms ease}
.tw-narr{z-index:11;display:flex;align-items:center;justify-content:center;text-align:center;
  font-size:2.2rem;line-height:1.6;padding:0 12%;white-space:pre-line;opacity:0;transition:opacity 400ms ease;
  text-shadow:0 2px 12px rgba(0,0,0,.8);letter-spacing:.06em}
.tw-card{z-index:11;display:flex;align-items:center;justify-content:center;text-align:center;
  font-size:2.6rem;font-weight:700;line-height:1.5;padding:0 10%;white-space:pre-line;opacity:0;transition:opacity 450ms ease;
  background:radial-gradient(ellipse at center,rgba(0,0,0,.72) 0%,rgba(0,0,0,.55) 45%,rgba(0,0,0,.2) 100%);
  text-shadow:0 3px 16px #000;letter-spacing:.05em}
.tw-sub{position:absolute;left:50%;bottom:5%;transform:translateX(-50%);z-index:11;max-width:80%;
  display:flex;align-items:center;gap:.7em;background:rgba(0,0,0,.62);padding:.5em 1.1em;border-radius:.5em;
  font-size:1.4rem;line-height:1.5;opacity:0;transition:opacity 250ms ease;box-sizing:border-box}
.tw-chip{flex:none;font-size:.8em;font-weight:700;padding:.1em .6em;border-radius:1em;color:#fff}
.tw-chip.pedestrian{background:#e8a317;color:#222}
.tw-chip.driver{background:#2f7fd8}
.tw-chip.anchor{background:#d33a3a}
.tw-hints{position:absolute;left:0;right:0;bottom:18%;z-index:7;display:flex;flex-direction:column;align-items:center;gap:.5em}
.tw-hint{background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.25);padding:.4em 1.1em;border-radius:2em;
  font-size:1rem;opacity:0;transition:opacity 350ms ease;display:flex;align-items:center;gap:.35em}
.tw-key{display:inline-block;min-width:1.5em;padding:.1em .4em;text-align:center;font-weight:700;font-family:Consolas,monospace;
  background:linear-gradient(#f4f4f4,#cfcfcf);color:#222;border-radius:.35em;border-bottom:3px solid #8a8a8a;
  box-shadow:0 1px 3px rgba(0,0,0,.6)}
.tw-rewind{z-index:12;overflow:hidden;opacity:0;transition:opacity 150ms ease}
.tw-rewind .tint{position:absolute;inset:0;background:rgba(40,110,255,.22);mix-blend-mode:screen;
  box-shadow:inset 0 0 160px 40px rgba(0,0,30,.85);animation:tw-flick .18s steps(2) infinite}
.tw-rewind .scan{position:absolute;inset:-40px 0;background:repeating-linear-gradient(0deg,rgba(255,255,255,.12) 0 2px,rgba(0,0,0,.18) 2px 6px);
  animation:tw-scan .35s linear infinite}
.tw-rewind .bar{position:absolute;left:0;right:0;height:14%;background:linear-gradient(transparent,rgba(255,255,255,.18),transparent);
  animation:tw-bar .9s linear infinite}
.tw-rewind .lbl{position:absolute;left:4%;top:6%;font-size:2rem;font-weight:700;letter-spacing:.15em;color:#fff;
  text-shadow:2px 0 #f0f,-2px 0 #0ff;animation:tw-blink 1s steps(2) infinite}
@keyframes tw-scan{from{transform:translateY(0)}to{transform:translateY(-6px)}}
@keyframes tw-bar{from{top:-15%}to{top:105%}}
@keyframes tw-flick{0%{opacity:.85}50%{opacity:1}100%{opacity:.7}}
@keyframes tw-blink{0%{opacity:1}50%{opacity:.25}100%{opacity:1}}
.tw-news{z-index:11;background:#000;opacity:0;transition:opacity 450ms ease;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.4em}
.tw-news .frame{container-type:inline-size;position:relative;width:min(66vw,calc(62vh * 16 / 9));aspect-ratio:16/9;overflow:hidden;
  background:linear-gradient(180deg,#8c9aa0 0%,#6b7a76 45%,#3d4a46 70%,#2a3330 100%)}
.tw-news .logo{position:absolute;right:3%;top:4%;background:#fff;color:#c4161c;font-weight:900;font-size:clamp(.8rem,1.5vw,1.3rem);
  padding:.1em .7em;letter-spacing:.1em;border-radius:.2em;border-bottom:.2em solid #c4161c;box-shadow:0 2px 6px rgba(0,0,0,.5)}
.tw-news .l3{position:absolute;left:0;right:0;bottom:0;font-size:2.3cqw}
.tw-news .row{display:flex;align-items:stretch;height:3.4em}
.tw-news .side{flex:0 0 16%;box-sizing:border-box;min-width:0;background:#c4161c;
  display:flex;flex-direction:column;justify-content:center;align-items:center;padding:0 .4em;
  color:#fff;font-weight:900;line-height:1.15;white-space:nowrap;font-size:1.5em;letter-spacing:.1em}
.tw-news .side small{color:#fff;font-size:.8em}
.tw-news .main{flex:1;min-width:0;background:#fff;color:#111;position:relative;display:flex;align-items:center;padding:0 .8em .1em 1.6em;
  font-weight:900;font-size:1.45em;letter-spacing:.04em;white-space:nowrap;overflow:hidden;  text-shadow:1px 1px 0 rgba(0,0,0,.15)}
.tw-news .place{position:absolute;left:16%;top:-1.5em;background:#fff;color:#111;font-size:.85em;font-weight:800;
  padding:0 1.6em 0 1em;clip-path:polygon(0 0,90% 0,100% 100%,0 100%);height:1.7em;display:flex;align-items:center}
.tw-news .tick{display:flex;align-items:stretch;height:1.9em;background:#16286b;color:#fff;font-weight:700}
.tw-news .tick .lb{flex:0 0 16%;box-sizing:border-box;background:#6b6f76;padding:0 .4em;display:flex;align-items:center;justify-content:center;white-space:nowrap;letter-spacing:.1em;font-size:.85em}
.tw-news .tick .tx{flex:1;min-width:0;display:flex;align-items:center;padding:0 1em;font-size:1.05em;letter-spacing:.08em;white-space:nowrap;overflow:hidden}
.tw-news .anc{display:flex;align-items:center;gap:.7em;justify-content:center;width:min(66vw,calc(62vh * 16 / 9));text-align:center;font-size:1.4rem;line-height:1.5;
  min-height:3.2em}
.tw-news .anc .tx{text-align:center;white-space:pre-line}
.tw-cards{position:absolute;left:50%;bottom:0;transform:translateX(-50%);z-index:9;display:flex;justify-content:center;
  width:min(1000px,96%);height:0}
.tw-c{width:min(230px,20vw);aspect-ratio:5/7;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;text-align:center;
  font:inherit;color:#1b1f2a;background:linear-gradient(160deg,#fbf3df,#ecdcb8);border:3px solid #cdb98a;
  border-radius:14px;padding:16px 12px;cursor:pointer;position:absolute;bottom:0;transform-origin:50% 140%;
  left:calc(50% + var(--ox) - min(115px,10vw));
  transform:translateY(var(--ty)) rotate(var(--rot));
  box-shadow:0 4px 14px rgba(0,0,0,.6);transition:transform .18s ease,border-color .18s,box-shadow .18s}
.tw-c:hover:not(:disabled){transform:translateY(-40px) rotate(0deg) scale(1.12);z-index:5;border-color:#ffe066;
  box-shadow:0 0 18px 4px rgba(255,224,102,.8),0 10px 24px rgba(0,0,0,.7)}
.tw-c .t{display:block;font-weight:800;font-size:1.8rem;margin:.3em 0 .7em}
.tw-c .d{display:block;font-size:1.1rem;line-height:1.6;opacity:.95}
.tw-c.done{cursor:default;border-color:#4cd964;background:linear-gradient(160deg,#f1f3d8,#d4dcae);
  box-shadow:0 0 14px 2px rgba(76,217,100,.7)}
.tw-btn{font:inherit;color:#fff;background:rgba(0,0,0,.65);border:2px solid #fff;border-radius:.6em;
  padding:.6em 1.8em;font-size:1.5rem;cursor:pointer;letter-spacing:.1em;transition:background .15s,color .15s}
.tw-btn:hover{background:#fff;color:#000}
.tw-play{position:absolute;right:4%;bottom:5%;z-index:9;font-size:2rem;width:2.2em;height:2.2em;padding:0;
  display:flex;align-items:center;justify-content:center;border-radius:50%;border-color:#ffd54a;color:#ffd54a}
.tw-play::before{content:'';display:block;width:0;height:0;margin-left:.14em;border-style:solid;
  border-width:.45em 0 .45em .75em;border-color:transparent transparent transparent currentColor}
.tw-play:hover{background:#ffd54a;color:#000}
.tw-wait{z-index:13;display:flex;align-items:center;justify-content:center}
`;

export function createUI(root: HTMLElement): UI {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const mk = (cls: string, parent: HTMLElement = root, tag = 'div'): HTMLElement => {
    const el = document.createElement(tag);
    el.className = cls;
    parent.appendChild(el);
    return el;
  };

  // ---- shared timing helpers -------------------------------------------------
  let epoch = 0;
  const sleepers = new Set<{ t: ReturnType<typeof setTimeout>; r: () => void }>();
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const s = {
        t: setTimeout(() => {
          sleepers.delete(s);
          resolve();
        }, ms),
        r: resolve,
      };
      sleepers.add(s);
    });
  const raf2 = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  /** Serial queue per channel. */
  const makeQueue = () => {
    let tail: Promise<void> = Promise.resolve();
    return (task: () => Promise<void>): Promise<void> => {
      const my = epoch;
      const p = tail.then(() => (my === epoch ? task() : undefined)).catch(() => undefined);
      tail = p;
      return p;
    };
  };
  const narrQ = makeQueue();
  const sayQ = makeQueue();
  const cardQ = makeQueue();
  const waitQ = makeQueue();

  // ---- black layer (shared) ---------------------------------------------------
  const black = mk('tw-layer tw-black');
  let blackOn = false;
  const setBlackStyle = (on: boolean, ms: number) => {
    blackOn = on;
    black.style.transitionDuration = `${ms}ms`;
    black.style.opacity = on ? '1' : '0';
  };

  // ---- subtitles ---------------------------------------------------------------
  let cardActive = 0;
  let curSay: HTMLElement | null = null;
  const hideSay = () => {
    if (curSay) {
      curSay.style.opacity = '0';
      const e = curSay;
      setTimeout(() => e.remove(), 300);
      curSay = null;
    }
  };
  const roleLabel = { pedestrian: '行人', driver: '駕駛', anchor: '主播' } as const;

  // ---- hints ------------------------------------------------------------------
  const hintBox = mk('tw-hints');
  const renderTokens = (el: HTMLElement, text: string) => {
    const re = /\[([^\]]+)\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      const k = document.createElement('span');
      k.className = 'tw-key';
      k.textContent = m[1];
      el.appendChild(k);
      last = m.index + m[0].length;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  };

  // ---- cards ------------------------------------------------------------------
  let cardsEl: HTMLElement | null = null;
  let playEl: HTMLElement | null = null;

  const ui: UI = {
    narration(text, holdMs = Math.min(6000, Math.max(1800, 1000 + 120 * text.length)), sub?: string, fadeMs = 400) {
      return narrQ(async () => {
        const my = epoch;
        const el = mk('tw-layer tw-narr');
        el.style.transitionDuration = `${fadeMs}ms`;
        if (sub) {
          el.style.flexDirection = 'column';
          mk('', el, 'div').textContent = text;
          const s = mk('', el, 'div');
          s.textContent = sub;
          s.style.cssText = 'font-size:1rem;opacity:.65;margin-top:1.6em;letter-spacing:.08em';
        } else {
          el.textContent = text;
        }
        if (!blackOn) {
          setBlackStyle(true, 400);
          await sleep(400);
        }
        await raf2();
        el.style.opacity = '1';
        await sleep(fadeMs + holdMs);
        el.style.opacity = '0';
        await sleep(fadeMs);
        el.remove();
        void my;
      });
    },

    say(kind, text, holdMs = Math.min(7000, Math.max(1500, 1200 + 140 * text.length))) {
      return sayQ(async () => {
        const my = epoch;
        while (cardActive > 0 && my === epoch) await sleep(100);
        if (my !== epoch) return;
        hideSay();
        const el = mk('tw-sub', root);
        const chip = mk(`tw-chip ${kind}`, el, 'span');
        chip.textContent = roleLabel[kind];
        const tx = mk('', el, 'span');
        tx.textContent = text;
        curSay = el;
        await raf2();
        el.style.opacity = '1';
        await sleep(250 + holdMs);
        if (curSay === el) hideSay();
        else el.remove();
        await sleep(280);
      });
    },

    card(text, holdMs = Math.min(6000, Math.max(2200, 1200 + 130 * text.length))) {
      return cardQ(async () => {
        const el = mk('tw-layer tw-card');
        el.textContent = text;
        cardActive++;
        hideSay();
        await raf2();
        el.style.opacity = '1';
        await sleep(450 + holdMs);
        el.style.opacity = '0';
        await sleep(450);
        el.remove();
        cardActive--;
      }).finally(() => {
        // epoch reset by clearAll may skip the task; keep counter sane
        if (cardActive < 0) cardActive = 0;
      });
    },

    news(headline, anchorText, holdMs = 7000) {
      return cardQ(async () => {
        const el = mk('tw-layer tw-news');
        const frame = mk('frame', el);
        mk('logo', frame).textContent = 'ㄙ見新聞台';
        const l3 = mk('l3', frame);
        const row = mk('row', l3);
        const side = mk('side', row);
        mk('', side, 'span').textContent = '最新';
        const main = mk('main', row);
        mk('', main, 'span').textContent = headline;
        const tick = mk('tick', l3);
        mk('lb', tick).textContent = '11:11';
        mk('tx', tick).textContent = '行人遭左轉小客車撞擊送醫　駕駛稱沒看到人　警方調查中';
        const anc = mk('anc', el);
        mk('tw-chip anchor', anc, 'span').textContent = roleLabel.anchor;
        mk('tx', anc, 'span').textContent = anchorText;
        cardActive++;
        hideSay();
        await raf2();
        el.style.opacity = '1';
        // news voice-over: the cut only ends once it has finished playing (and the minimum hold has passed)
        const voice = new Audio(import.meta.env.BASE_URL + 'news.mp3');
        const voiceDone = new Promise<void>((resolve) => {
          voice.addEventListener('ended', () => resolve());
          voice.addEventListener('error', () => resolve());
          setTimeout(resolve, 60000); // safety net if playback stalls
          voice.play().catch(() => resolve()); // autoplay blocked / load failure: fall back to the timer
        });
        await Promise.all([sleep(450 + holdMs), voiceDone]);
        voice.pause();
        el.style.opacity = '0';
        await sleep(450);
        el.remove();
        cardActive--;
      }).finally(() => {
        if (cardActive < 0) cardActive = 0;
      });
    },

    hint(text) {
      const el = mk('tw-hint', hintBox);
      renderTokens(el, text);
      void raf2().then(() => (el.style.opacity = '1'));
      let gone = false;
      return () => {
        if (gone) return;
        gone = true;
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 400);
      };
    },

    fadeToBlack(ms = 600) {
      setBlackStyle(true, ms);
      return sleep(ms);
    },
    fadeFromBlack(ms = 600) {
      setBlackStyle(false, ms);
      return sleep(ms);
    },
    setBlack(on) {
      setBlackStyle(on, 0);
    },

    rewindOverlay(ms) {
      const el = mk('tw-layer tw-rewind');
      mk('tint', el);
      mk('scan', el);
      mk('bar', el);
      const lbl = mk('lbl', el);
      lbl.textContent = '◀◀ 倒帶';
      requestAnimationFrame(() => (el.style.opacity = '1'));
      return sleep(Math.max(0, ms)).then(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 200);
      });
    },

    showCards(cards, onPick) {
      ui.hideCards();
      const wrap = mk('tw-cards');
      cardsEl = wrap;
      cards.forEach((c, i) => {
        const b = mk('tw-c clickable', wrap, 'button') as HTMLButtonElement;
        const o = i - (cards.length - 1) / 2;
        b.style.setProperty('--rot', `${o * 11}deg`);
        b.style.setProperty('--ty', `${8 + Math.abs(o) * 16}%`);
        b.style.setProperty('--ox', `${o * 18}vmin`);
        mk('t', b, 'span').textContent = c.title;
        const d = mk('d', b, 'span');
        d.textContent = c.note; // effect always visible on the card
        b.addEventListener('click', () => {
          if (b.disabled) return;
          b.disabled = true;
          b.classList.add('done');
          onPick(i);
        });
      });
    },

    showPlayButton(onClick) {
      if (playEl) playEl.remove();
      const b = mk('tw-btn tw-play clickable', root, 'button');
            b.setAttribute('aria-label', 'play');
      b.addEventListener('click', () => onClick());
      playEl = b;
    },

    hideCards() {
      cardsEl?.remove();
      playEl?.remove();
      cardsEl = playEl = null;
    },

    waitForClick(label) {
      return waitQ(
        () =>
          new Promise<void>((resolve) => {
            const layer = mk('tw-layer tw-wait');
            const b = mk('tw-btn clickable', layer, 'button');
            b.textContent = label;
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              layer.remove();
              resolve();
            };
            b.addEventListener('click', finish);
            // clearAll() flushes via epoch change: poll-free hook
            const my = epoch;
            const iv = setInterval(() => {
              if (my !== epoch) {
                clearInterval(iv);
                finish();
              } else if (done) clearInterval(iv);
            }, 100);
          }),
      );
    },

    clearAll() {
      epoch++;
      for (const s of sleepers) {
        clearTimeout(s.t);
        s.r();
      }
      sleepers.clear();
      cardActive = 0;
      hideSay();
      root.querySelectorAll('.tw-sub,.tw-narr,.tw-card,.tw-news,.tw-rewind,.tw-wait').forEach((e) => e.remove());
      hintBox.replaceChildren();
      ui.hideCards();
    },
  };
  return ui;
}
