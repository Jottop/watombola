import { describe, expect, it } from 'vitest';
import {
  advanceDrum,
  createDrumState,
  ejectProgressOf,
  isBusy,
  loadParticipants,
  resetDrum,
  shakeDrum,
  startDraw,
  winnerBall,
  type DrumEvents,
  type DrumState,
  type Phase,
} from '../src/lib/drum-machine';
import { seededRandom } from '../src/lib/rng';
import type { ParticipantItem } from '../src/lib/types';

function items(n: number): ParticipantItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, label: `Nombre ${i}` }));
}

function makeState(count: number, seed = 5): DrumState {
  const state = createDrumState(0, 0, 300, 200);
  loadParticipants(state, items(count), seededRandom(seed));
  return state;
}

function playToEnd(state: DrumState, events: DrumEvents = {}, seed = 1): void {
  for (let i = 0; i < 4000; i++) {
    advanceDrum(state, 1 / 60, events, seededRandom(i + seed));
  }
}

describe('las expulsadas salen de la simulacion', () => {
  it('marca como gone a las que terminaron de salir', () => {
    const state = makeState(12);
    startDraw(state, seededRandom(1), {});
    playToEnd(state);

    const gone = state.world.balls.filter((b) => b.gone).length;
    expect(gone).toBe(state.world.balls.length - 1);
  });

  it('resetDrum las devuelve todas', () => {
    const state = makeState(12);
    startDraw(state, seededRandom(1), {});
    playToEnd(state);
    expect(state.world.balls.some((b) => b.gone)).toBe(true);

    resetDrum(state, items(12), seededRandom(2));
    expect(state.world.balls.every((b) => !b.gone)).toBe(true);
  });

  it('la pila baja al vaciarse, en vez de quedar sostenida', () => {
    // Regresion: el renderer dejaba de dibujar las expulsadas pero la fisica
    // seguia simulandolas, asi que ocupaban espacio invisible y empujaban a las
    // demas. Medido: con 29 bolas la altura media era 0.288R, casi la misma
    // que con 57 (0.301R): la pila no se reacomodaba en el espacio liberado.
    const state = makeState(40);
    startDraw(state, seededRandom(1), {});

    const R = state.world.R;
    const remaining = (): typeof state.world.balls =>
      state.world.balls.filter((_, i) => ejectProgressOf(state, i) < 1);

    const meanHeight = (balls: typeof state.world.balls): number =>
      balls.reduce((s, b) => s + (b.y - state.world.cy) / R, 0) / balls.length;

    let early = 0;
    let late = 0;
    for (let i = 0; i < 1400; i++) {
      advanceDrum(state, 1 / 60, {}, seededRandom(i));
      const balls = remaining();
      if (state.phase !== 'ejecting') continue;
      if (balls.length > 34 && balls.length < 40 && early === 0) early = meanHeight(balls);
      if (balls.length > 12 && balls.length < 18) late = meanHeight(balls);
    }

    expect(early).toBeGreaterThan(0);
    // Quedando la mitad, la pila tiene que estar claramente mas abajo.
    expect(late).toBeGreaterThan(early + 0.1);
  });
});

describe('sorteo', () => {
  it('recorre spinning -> ejecting -> reveal', () => {
    const state = makeState(12);
    const seen: Phase[] = [];
    const events: DrumEvents = { onPhaseChange: (p) => seen.push(p) };

    startDraw(state, seededRandom(1), events);
    expect(state.phase).toBe('spinning');
    expect(isBusy(state)).toBe(true);

    for (let i = 0; i < 4000; i++) advanceDrum(state, 1 / 60, events, seededRandom(i));

    expect(seen).toEqual(['spinning', 'ejecting', 'reveal']);
    expect(state.phase).toBe('reveal');
  });

  it('expulsa a todos menos al ganador', () => {
    const state = makeState(12);
    startDraw(state, seededRandom(2));
    playToEnd(state);

    expect(state.ejectOrder).toHaveLength(11);
    expect(state.ejectOrder).not.toContain(state.winnerIndex);

    for (let i = 0; i < state.world.balls.length; i++) {
      const progress = ejectProgressOf(state, i);
      if (i === state.winnerIndex) expect(progress).toBe(-1);
      else expect(progress).toBe(1);
    }
  });

  it('anuncia al ganador una sola vez', () => {
    const state = makeState(10);
    let reveals = 0;
    const events: DrumEvents = { onReveal: () => (reveals += 1) };

    startDraw(state, seededRandom(3), events);
    playToEnd(state, events);

    expect(reveals).toBe(1);
    expect(state.winnerLabel).toBe(winnerBall(state)!.label);
  });

  it('emite un evento de eyecion por cada perdedor', () => {
    const state = makeState(15);
    const ejected: string[] = [];
    const events: DrumEvents = { onEject: (ball) => ejected.push(ball.id) };

    startDraw(state, seededRandom(4), events);
    playToEnd(state, events);

    expect(ejected).toHaveLength(14);
    expect(new Set(ejected).size).toBe(14);
    expect(ejected).not.toContain(winnerBall(state)!.id);
  });

  it('no sortea si no hay participantes', () => {
    const state = createDrumState(0, 0, 300, 10);
    expect(startDraw(state, seededRandom(1))).toBe(false);
    expect(state.phase).toBe('idle');
  });

  it('no sortea dos veces sin reiniciar', () => {
    const state = makeState(8);
    startDraw(state, seededRandom(1));
    expect(startDraw(state, seededRandom(1))).toBe(false);
  });

  it('ignora cambios de participantes mientras corre', () => {
    const state = makeState(10);
    startDraw(state, seededRandom(1));
    expect(loadParticipants(state, items(30), seededRandom(2))).toBe(false);
    expect(state.world.balls).toHaveLength(10);
  });

  it('acepta cambios de participantes en fase reveal y neutraliza la bola grande', () => {
    // El ganador vive en el DOM, no en el array de bolas: recargar en reveal
    // tiene que rellenar el bombo sin que winnerIndex apunte a otro nombre.
    const state = makeState(10);
    startDraw(state, seededRandom(1), {});
    playToEnd(state);
    expect(state.phase).toBe('reveal');

    expect(loadParticipants(state, items(4), seededRandom(2))).toBe(true);
    expect(state.world.balls).toHaveLength(4);
    expect(state.winnerIndex).toBe(-1);
    expect(state.revealProgress).toBe(0);

    // Todas las bolas quedan dentro del bombo, ninguna en modo eyeccion.
    for (let i = 0; i < state.world.balls.length; i++) {
      expect(ejectProgressOf(state, i)).toBe(-1);
    }
  });

  it('rechaza cambios mientras eyecta bolas', () => {
    const state = makeState(20);
    startDraw(state, seededRandom(1), {});
    for (let i = 0; i < 2000 && state.phase !== 'ejecting'; i++) {
      advanceDrum(state, 1 / 60, {}, seededRandom(i));
    }
    expect(state.phase).toBe('ejecting');

    expect(loadParticipants(state, items(5), seededRandom(2))).toBe(false);
    expect(state.world.balls).toHaveLength(20);
  });

  it('resetDrum deja el bombo listo para el siguiente sorteo', () => {
    const state = makeState(10);
    startDraw(state, seededRandom(1));
    playToEnd(state);

    resetDrum(state, items(10), seededRandom(9));

    expect(state.phase).toBe('idle');
    expect(state.winnerIndex).toBe(-1);
    expect(state.revealProgress).toBe(0);
    expect(startDraw(state, seededRandom(1))).toBe(true);
  });

  it('el ganador es equiprobable entre todos los participantes', () => {
    const counts = new Array<number>(4).fill(0);
    const runs = 4000;

    for (let run = 0; run < runs; run++) {
      const state = makeState(4, run);
      startDraw(state, seededRandom(run * 7919 + 1));
      counts[state.winnerIndex]! += 1;
    }

    const expected = runs / 4;
    for (const count of counts) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.08);
    }
  });
});

describe('sacudida manual', () => {
  it('solo sacude en reposo', () => {
    const state = makeState(10);
    expect(shakeDrum(state, 1, 0)).toBe(true);

    startDraw(state, seededRandom(1));
    expect(shakeDrum(state, 1, 0)).toBe(false);
  });

  it('despierta y mueve las bolas de la pila', () => {
    const state = makeState(20);
    for (let i = 0; i < 1200; i++) advanceDrum(state, 1 / 60, {}, seededRandom(i));
    expect(state.world.balls.some((b) => b.sleeping)).toBe(true);

    shakeDrum(state, 1, 0);
    expect(state.world.balls.every((b) => !b.sleeping)).toBe(true);
  });

  it('el retroceso visual del bombo vuelve a cero', () => {
    const state = makeState(10);
    shakeDrum(state, 1, 0);
    expect(Math.abs(state.shakeVX)).toBeGreaterThan(0);

    for (let i = 0; i <= 600; i++) advanceDrum(state, 1 / 60, {}, seededRandom(i));

    expect(Math.abs(state.shakeX)).toBeLessThan(0.5);
    expect(Math.abs(state.shakeY)).toBeLessThan(0.5);
    expect(Math.hypot(state.shakeVX, state.shakeVY)).toBeLessThan(1);
  });

  it('resetDrum limpia el retroceso', () => {
    const state = makeState(10);
    shakeDrum(state, 0, 1);
    resetDrum(state, items(10), seededRandom(2));

    expect(state.shakeX).toBe(0);
    expect(state.shakeY).toBe(0);
    expect(state.shakeVX).toBe(0);
    expect(state.shakeVY).toBe(0);
  });
});
