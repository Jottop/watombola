/**
 * Ejecuta el bundle REAL de /overlay (no una copia de la logica) sobre stubs
 * minimos de DOM, Canvas 2D, WebAudio y localStorage, y avanza el reloj
 * frame a frame a traves de todo el sorteo.
 *
 * Uso: astro build && node scripts/smoke-overlay.mjs
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST = join(process.cwd(), 'dist', '_astro');
const bundleFile = readdirSync(DIST).find((f) => f.startsWith('overlay') && f.endsWith('.js'));
if (!bundleFile) {
  console.error('No encontre el bundle del overlay en dist/_astro. Corré `npm run build` primero.');
  process.exit(1);
}
const bundle = pathToFileURL(join(DIST, bundleFile)).href;

const errors = [];
const log = [];

// ---------- Canvas 2D ----------
const gradient = { addColorStop() {} };
const ctx2d = {
  canvas: null,
  globalAlpha: 1,
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  font: '',
  textAlign: 'start',
  textBaseline: 'alphabetic',
  save() {},
  restore() {},
  translate() {},
  rotate() {},
  setTransform() {},
  beginPath() {},
  closePath() {},
  clip() {},
  arc() {},
  ellipse() {},
  rect() {},
  roundRect() {},
  fill() {},
  stroke() {},
  fillRect() {},
  fillText() {},
  clearRect() {},
  moveTo() {},
  lineTo() {},
  measureText: (t) => ({ width: String(t).length * 8 }),
  createRadialGradient: () => gradient,
  createLinearGradient: () => gradient,
};

// ---------- AudioContext ----------
const param = {
  value: 0,
  setTargetAtTime() {},
  cancelScheduledValues() {},
  setValueAtTime() {},
  exponentialRampToValueAtTime() {},
  linearRampToValueAtTime() {},
};
const node = () => ({
  connect() {},
  disconnect() {},
  start() {},
  stop() {},
  gain: param,
  frequency: param,
  Q: param,
  type: '',
  buffer: null,
  loop: false,
});

class AudioContextStub {
  constructor() {
    this.state = 'suspended';
    this.sampleRate = 48000;
    this.destination = node();
    this.currentTime = 0;
  }
  async resume() {
    this.state = 'running';
  }
  createGain() {
    return node();
  }
  createOscillator() {
    return node();
  }
  createBufferSource() {
    return node();
  }
  createBiquadFilter() {
    return node();
  }
  createBuffer(_ch, length) {
    return { length, getChannelData: () => new Float32Array(length) };
  }
}

// ---------- DOM ----------
function makeEl(id) {
  return {
    id,
    textContent: '',
    hidden: false,
    style: {},
    dataset: {},
    files: null,
    clientWidth: 1920,
    clientHeight: 1080,
    classList: {
      set: new Set(),
      add(c) {
        this.set.add(c);
      },
      remove(c) {
        this.set.delete(c);
      },
      contains(c) {
        return this.set.has(c);
      },
      toggle(c, force) {
        const on = force ?? !this.set.has(c);
        on ? this.set.add(c) : this.set.delete(c);
        return on;
      },
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    removeEventListener() {},
    listeners: {},
    focus() {},
    click() {},
    closest: () => null,
    getContext: () => ctx2d,
    getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
  };
}

const els = {};
const store = new Map();
const rafQueue = [];

globalThis.window = {
  innerWidth: 1920,
  innerHeight: 1080,
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  },
  removeEventListener() {},
  listeners: {},
  AudioContext: AudioContextStub,
};
globalThis.AudioContext = AudioContextStub;
globalThis.devicePixelRatio = 1;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.location = { search: '' };
globalThis.requestAnimationFrame = (fn) => {
  rafQueue.push(fn);
  return rafQueue.length;
};
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = {
  body: makeEl('body'),
  getElementById(id) {
    els[id] ??= makeEl(id);
    return els[id];
  },
  createElement: () => makeEl('tmp'),
  addEventListener() {},
};

globalThis.addEventListener = window.addEventListener;

// ---------- Correr ----------
function pump(frames, dtMs = 1000 / 60) {
  let t = globalThis.performance.now();
  for (let i = 0; i < frames; i++) {
    const batch = rafQueue.splice(0, rafQueue.length);
    t += dtMs;
    for (const fn of batch) {
      try {
        fn(t);
      } catch (err) {
        errors.push(`frame ${i}: ${err?.stack ?? err}`);
        if (errors.length > 3) return;
        return;
      }
    }
  }
}

await import(bundle);

const fire = (type, event) => {
  for (const fn of window.listeners[type] ?? []) {
    try {
      fn(event);
    } catch (err) {
      errors.push(`${type}: ${err?.stack ?? err}`);
    }
  }
};

const phase = () => document.body.dataset.phase;

log.push(`participantes cargados: ${(JSON.parse(store.get('tombola:participantes:v1') ?? '[]')).length}`);

pump(30);
log.push(`tras 30 frames en idle, fase=${phase()}`);

// sortear con el teclado
fire('keydown', { key: ' ', repeat: false, preventDefault() {} });
// trigger() es async (await audio.unlock()), hay que dejar correr el microtask
await new Promise((r) => setTimeout(r, 0));
log.push(`tras sortear, fase=${phase()}`);

// 12 segundos de sorteo
pump(720);
log.push(`tras 12s, fase=${phase()}`);

// dejar completar el reveal
pump(420);
log.push(`tras 19s, fase=${phase()}`);
log.push(`ganador mostrado: "${els['winner-name'].textContent}"`);
log.push(`clases del ganador: ${[...els.winner.classList.set].join(',') || '(ninguna)'}`);
log.push(`sorteos guardados: ${JSON.parse(store.get('tombola:sorteos:v1') ?? '[]').length}`);
log.push(`nudge visible: ${els.nudge.classList.contains('is-visible')}`);

// reiniciar con R
fire('keydown', { key: 'r', repeat: false, preventDefault() {} });
pump(120);
log.push(`tras R, fase=${phase()} ganador="${els['winner-name'].textContent}"`);

if (errors.length) {
  console.log(log.join('\n'));
  console.error('\nERRORES:\n' + errors.slice(0, 3).join('\n---\n'));
  process.exit(1);
}
console.log(log.join('\n'));
console.log('\nOK: el overlay corrio todo el sorteo sin excepciones.');
