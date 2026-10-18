import {
  advanceWorld,
  addBall,
  createWorld,
  populate,
  shakeWorld,
  SHAKE_IMPULSE,
  type Ball,
  type World,
} from './physics';
import { cryptoRandom, randomInt, shuffle, type RandomSource } from './rng';
import type { ParticipantItem } from './types';

export type Phase = 'idle' | 'spinning' | 'ejecting' | 'reveal';

export const SPIN_DURATION = 7.5;
export const SPIN_UP = 0.6;
export const SPIN_DOWN = 1.8;
export const EJECT_STAGGER = 0.07;
export const EJECT_TRAVEL = 0.55;
export const REVEAL_DURATION = 0.9;
export const EJECT_IDLE_AGITATION = 0;

/**
 * Sacudida manual (tecla R en reposo). El impulso a las bolas lo da
 * `shakeWorld`; esto es solo el retroceso visual del bombo, que vuelve solo
 * por un resorte con amortiguacion.
 */
export const SHAKE_VISUAL_V = 150;
const SHAKE_SPRING = 90;
const SHAKE_DAMP = 11;

export interface DrumEvents {
  onPhaseChange?(phase: Phase, previous: Phase): void;
  onEject?(ball: Ball, remaining: number): void;
  onReveal?(ball: Ball): void;
}

export interface DrumState {
  world: World;
  phase: Phase;
  clock: number;
  phaseTime: number;
  winnerIndex: number;
  ejectOrder: number[];
  ejectCursor: number;
  /** Momento (reloj global) en que cada bola empieza a salir. -1 = sigue dentro. */
  ejectAt: Float64Array;
  ejectFromX: Float64Array;
  ejectFromY: Float64Array;
  revealProgress: number;
  revealFired: boolean;
  winnerLabel: string;
  /** Retroceso visual del bombo por un golpe manual. Vuelve a 0 con el resorte. */
  shakeX: number;
  shakeY: number;
  shakeVX: number;
  shakeVY: number;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function createDrumState(cx: number, cy: number, R: number, maxBalls = 200): DrumState {
  return {
    world: createWorld(cx, cy, R, maxBalls),
    phase: 'idle',
    clock: 0,
    phaseTime: 0,
    winnerIndex: -1,
    ejectOrder: [],
    ejectCursor: 0,
    ejectAt: new Float64Array(maxBalls),
    ejectFromX: new Float64Array(maxBalls),
    ejectFromY: new Float64Array(maxBalls),
    revealProgress: 0,
    revealFired: false,
    winnerLabel: '',
    shakeX: 0,
    shakeY: 0,
    shakeVX: 0,
    shakeVY: 0,
  };
}

function setPhase(state: DrumState, next: Phase, events: DrumEvents): void {
  if (state.phase === next) return;
  const previous = state.phase;
  state.phase = next;
  state.phaseTime = 0;
  events.onPhaseChange?.(next, previous);
}

/** Mientras el bombo gira no se tocan las bolas. En reveal sÃ­ se puede: el
 *  ganador ya estÃ¡ en el DOM y no depende del array de bolas. */
export function isDrumAnimating(state: DrumState): boolean {
  return state.phase === 'spinning' || state.phase === 'ejecting';
}

export function loadParticipants(
  state: DrumState,
  items: readonly ParticipantItem[],
  rand: RandomSource = cryptoRandom,
): boolean {
  if (isDrumAnimating(state)) return false;

  populate(state.world, items, rand);
  state.ejectAt.fill(-1);

  if (state.phase === 'reveal') {
    // La bola grande se neutraliza: winnerIndex apuntarÃ­a a un Ã­ndice
    // cualquiera de la lista nueva y mostrarÃ­a el nombre equivocado. El
    // ganador sigue visible en el DOM, que es donde vive de verdad.
    state.winnerIndex = -1;
    state.revealProgress = 0;
    state.ejectOrder = [];
    state.ejectCursor = 0;
  }

  return true;
}

/**
 * El ganador se sortea acÃ¡ con entropia criptografica, NO con la fisica.
 * Dejarlo en manos de la simulacion introduciria sesgo (las bolas se
 * acumulan en los bordes), y ademas seria imposible de auditar.
 */
export function startDraw(
  state: DrumState,
  rand: RandomSource = cryptoRandom,
  events: DrumEvents = {},
): boolean {
  if (state.phase !== 'idle' || state.world.balls.length === 0) return false;

  const count = state.world.balls.length;
  state.winnerIndex = randomInt(count, rand);
  state.winnerLabel = '';

  const rest: number[] = [];
  for (let i = 0; i < count; i++) {
    if (i !== state.winnerIndex) rest.push(i);
  }
  state.ejectOrder = shuffle(rest, rand);
  state.ejectCursor = 0;
  state.ejectAt.fill(-1);
  state.revealFired = false;
  state.revealProgress = 0;
  state.world.agitation = 0;
// Por si se arranca un sorteo sin pasar por resetDrum: ninguna bola arranca
  // marcada como salida.
  for (const ball of state.world.balls) {
    ball.gone = false;
    ball.sleeping = false;
    ball.still = 0;
  }

  setPhase(state, 'spinning', events);
  return true;
}

export function resetDrum(
  state: DrumState,
  items: readonly ParticipantItem[],
  rand: RandomSource = cryptoRandom,
  events: DrumEvents = {},
): void {
  setPhase(state, 'idle', events);
  state.winnerIndex = -1;
  state.ejectOrder = [];
  state.ejectCursor = 0;
  state.ejectAt.fill(-1);
  state.revealProgress = 0;
  state.revealFired = false;
  state.winnerLabel = '';
  state.world.agitation = 0;
  state.shakeX = 0;
  state.shakeY = 0;
  state.shakeVX = 0;
  state.shakeVY = 0;
  populate(state.world, items, rand);
}

/**
 * Sacude el bombo con un golpe en la direccion dada (desde el punto del golpe
 * hacia el centro). Solo tiene sentido en reposo: mientras hay un sorteo en
 * curso el resultado ya esta decidido y no se toca. Devuelve false si no
 * corresponde sacudir, para que quien llama decida otra cosa (reiniciar).
 */
export function shakeDrum(state: DrumState, dirX: number, dirY: number): boolean {
  if (state.phase !== 'idle') return false;

  const len = Math.hypot(dirX, dirY);
  if (len < 1e-6) return false;
  const nx = dirX / len;
  const ny = dirY / len;

  shakeWorld(state.world, nx, ny, SHAKE_IMPULSE);
  state.shakeVX += nx * SHAKE_VISUAL_V;
  state.shakeVY += ny * SHAKE_VISUAL_V;
  return true;
}

function agitationFor(phase: Phase, t: number): number {
  if (phase === 'spinning') {
    let a: number;
    if (t < SPIN_UP) {
      a = t / SPIN_UP;
    } else if (t < SPIN_DURATION - SPIN_DOWN) {
      a = 1;
    } else {
      a = Math.max(0, 1 - (t - (SPIN_DURATION - SPIN_DOWN)) / SPIN_DOWN);
    }
    return a * a * (3 - 2 * a);
  }
  if (phase === 'ejecting') return EJECT_IDLE_AGITATION;
  return 0;
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

function tick(state: DrumState, events: DrumEvents): void {
  switch (state.phase) {
    case 'idle':
      state.revealProgress = 0;
      break;

    case 'spinning':
      if (state.phaseTime >= SPIN_DURATION) setPhase(state, 'ejecting', events);
      break;

    case 'ejecting': {
      const base = state.clock - state.phaseTime;
      while (state.ejectCursor < state.ejectOrder.length) {
        const index = state.ejectOrder[state.ejectCursor]!;
        const at = state.ejectCursor * EJECT_STAGGER;
        if (at > state.phaseTime) break;

        const ball = state.world.balls[index];
        if (ball) {
          state.ejectFromX[index] = ball.x;
          state.ejectFromY[index] = ball.y;
          state.ejectAt[index] = base + at;
          state.ejectCursor++;
          events.onEject?.(ball, Math.max(0, state.world.balls.length - state.ejectCursor - 1));
        } else {
          state.ejectCursor++;
        }
      }

      const total = state.ejectOrder.length * EJECT_STAGGER + EJECT_TRAVEL;
      if (state.phaseTime >= total) setPhase(state, 'reveal', events);
      break;
    }

    case 'reveal': {
      state.revealProgress = easeOutBack(clamp01(state.phaseTime / REVEAL_DURATION));
      if (!state.revealFired && state.phaseTime >= REVEAL_DURATION) {
        state.revealFired = true;
        const ball = state.world.balls[state.winnerIndex];
        if (ball) {
          state.winnerLabel = ball.label;
          events.onReveal?.(ball);
        }
      }
      break;
    }
  }
}

/** Resorte amortiguado del retroceso visual: vuelve solo a cero. */
function updateShake(state: DrumState, dt: number): void {
  const ax = -SHAKE_SPRING * state.shakeX - SHAKE_DAMP * state.shakeVX;
  const ay = -SHAKE_SPRING * state.shakeY - SHAKE_DAMP * state.shakeVY;
  state.shakeVX += ax * dt;
  state.shakeVY += ay * dt;
  state.shakeX += state.shakeVX * dt;
  state.shakeY += state.shakeVY * dt;
}

export function advanceDrum(
  state: DrumState,
  dt: number,
  events: DrumEvents = {},
  rand: RandomSource = cryptoRandom,
): void {
  if (dt <= 0) return;

  state.clock += dt;
  state.phaseTime += dt;
  state.world.agitation = agitationFor(state.phase, state.phaseTime);
  updateShake(state, dt);

  advanceWorld(state.world, dt, rand);
  markEjected(state);
  tick(state, events);
}

/**
 * Retira de la simulacion a las bolas que EMPIEZAN a salir.
 *
 * El renderer las sigue animando hasta el progreso 1, pero `gone` las saca del
 * solver y de la rejilla desde el primer frame de la eyeccion. Si se esperara a
 * que termine la animacion (0.55 s), la bola ocuparia espacio invisible todo ese
 * tiempo: medido, habia ~6 bolas en vuelo empujando a la vez y el hueco recien
 * se liberaba al final, asi que las que quedaban no bajaban cuando se veia salir
 * una. Retirandola al empezar, el lugar se libera enseguida y la pila se
 * reacomoda a la par de la animacion.
 *
 * Va DESPUES de advanceWorld: fisicamente la bola deja de contar recien en el
 * proximo subpaso, lo que evita cortar un contacto a mitad de resolver.
 */
function markEjected(state: DrumState): void {
  let salio = false;
  for (let i = 0; i < state.world.balls.length; i++) {
    const ball = state.world.balls[i]!;
    if (ball.gone) continue;
    if (ejectProgressOf(state, i) >= 0) {
      ball.gone = true;
      salio = true;
    }
  }

  // Despertar a las dormidas. Una bola congelada que estaba apoyada en la que
  // acaba de salir se queda sin apoyo, pero como la que salio se saca de la
  // simulacion NO hay ningun contacto que la despierte: quedaria flotando en
  // el aire para siempre. Es el caso contrario del bug que motivation esto.
  if (salio) {
    for (const ball of state.world.balls) {
      if (!ball.sleeping) continue;
      ball.sleeping = false;
      ball.still = 0;
    }
  }
}

/** -1 = la bola sigue en el bombo. 0..1 = progreso de salida. 1 = ya salio. */
export function ejectProgressOf(state: DrumState, index: number): number {
  const at = state.ejectAt[index];
  if (at === undefined || at < 0) return -1;
  return clamp01((state.clock - at) / EJECT_TRAVEL);
}

/**
 * Anota a alguien mientras la tombola esta quieta: la bola entra al bombo con
 * su animacion de caida. Si ya hay un sorteo en curso NO se toca el bombo,
 * porque el ganador de esa ronda ya esta definido; el participante queda en la
 * lista y su bola aparece en el proximo reinicio.
 *
 * Devuelve 'added' | 'busy' | 'full'.
 */
export function admitParticipant(
  state: DrumState,
  item: ParticipantItem,
  rand: RandomSource = cryptoRandom,
): 'added' | 'busy' | 'full' {
  if (state.phase !== 'idle') return 'busy';
  if (state.world.balls.some((b) => b.id === item.id)) return 'full';
  if (state.world.balls.length >= state.world.maxBalls) return 'full';

  addBall(state.world, item, rand, state.clock);
  return 'added';
}

export function isBusy(state: DrumState): boolean {
  return state.phase !== 'idle';
}

export function winnerBall(state: DrumState): Ball | null {
  return state.world.balls[state.winnerIndex] ?? null;
}
