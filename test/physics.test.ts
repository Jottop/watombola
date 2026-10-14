import { describe, expect, it } from 'vitest';
import {
  addBall,
  advanceWorld,
  ballRadiusFor,
  createWorld,
  kineticEnergy,
  MAX_BALL_R,
  populate,
  resizeWorld,
  resolveCollisionsNow,
  SPAWN_DURATION,
  spawnProgressOf,
} from '../src/lib/physics';
import { seededRandom } from '../src/lib/rng';
import type { ParticipantItem } from '../src/lib/types';

function items(n: number): ParticipantItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, label: `P${i}` }));
}

function run(world: ReturnType<typeof createWorld>, frames: number, agitation: number): void {
  for (let i = 0; i < frames; i++) {
    world.agitation = agitation;
    advanceWorld(world, 1 / 60, seededRandom(i));
  }
}

describe('ballRadiusFor', () => {
  it('se achica a medida que crecen los participantes', () => {
    expect(ballRadiusFor(10, 400)).toBeGreaterThan(ballRadiusFor(100, 400));
    expect(ballRadiusFor(100, 400)).toBeGreaterThan(ballRadiusFor(200, 400));
  });

  it('respeta los limites de legibilidad', () => {
    expect(ballRadiusFor(1, 400)).toBeLessThanOrEqual(MAX_BALL_R);
    expect(ballRadiusFor(100000, 400)).toBeGreaterThan(0);
  });
});

describe('populate', () => {
  it('crea una bola por participante, todas del mismo radio', () => {
    const world = createWorld(0, 0, 300, 50);
    populate(world, items(50), seededRandom(1));
    expect(world.balls).toHaveLength(50);
    expect(new Set(world.balls.map((b) => b.r)).size).toBe(1);
  });

  it('coloca las bolas adentro del bombo', () => {
    const world = createWorld(0, 0, 300, 50);
    populate(world, items(50), seededRandom(2));
    for (const b of world.balls) {
      expect(Math.hypot(b.x, b.y) + b.r).toBeLessThanOrEqual(world.R + 0.001);
    }
  });

  it('deja la lista vacia sin romperse', () => {
    const world = createWorld(0, 0, 300, 50);
    populate(world, [], seededRandom(3));
    expect(world.balls).toHaveLength(0);
  });
});

describe('simulacion', () => {
  it('nunca deja una bola escapar del bombo', () => {
    const world = createWorld(0, 0, 300, 60);
    populate(world, items(60), seededRandom(7));
    run(world, 600, 1);
    run(world, 600, 0);

    for (const b of world.balls) {
      expect(Math.hypot(b.x, b.y) + b.r).toBeLessThanOrEqual(world.R + 0.5);
    }
  });

  it('mantiene las bolas separadas una vez asentadas', () => {
    const world = createWorld(0, 0, 300, 40);
    populate(world, items(40), seededRandom(3));
    run(world, 2400, 0);
    resolveCollisionsNow(world);

    const radius = world.balls[0]!.r;
    let worstOverlap = 0;
    for (let i = 0; i < world.balls.length; i++) {
      for (let j = i + 1; j < world.balls.length; j++) {
        const a = world.balls[i]!;
        const b = world.balls[j]!;
        const overlap = a.r + b.r - Math.hypot(a.x - b.x, a.y - b.y);
        if (overlap > worstOverlap) worstOverlap = overlap;
      }
    }
    expect(worstOverlap).toBeLessThan(radius * 0.5);
  });

  it('pierde energia cuando deja de agitarse', () => {
    const world = createWorld(0, 0, 300, 50);
    populate(world, items(50), seededRandom(11));
    run(world, 600, 1);
    const peak = kineticEnergy(world);

    run(world, 1800, 0);
    expect(kineticEnergy(world)).toBeLessThan(peak * 0.2);
  });

  it('la agitacion mantiene el bombo en movimiento', () => {
    const world = createWorld(0, 0, 300, 50);
    populate(world, items(50), seededRandom(13));
    run(world, 900, 1);
    const moving = kineticEnergy(world);

    run(world, 1800, 0);
    expect(moving).toBeGreaterThan(kineticEnergy(world) * 5);
  });

  it('es determinista con la misma seed', () => {
    const a = createWorld(0, 0, 300, 30);
    const b = createWorld(0, 0, 300, 30);
    populate(a, items(30), seededRandom(21));
    populate(b, items(30), seededRandom(21));
    run(a, 600, 1);
    run(b, 600, 1);
    expect(a.balls.map((x) => [x.x, x.y])).toEqual(b.balls.map((x) => [x.x, x.y]));
  });

  it('aguanta un dt enorme sin romperse', () => {
    const world = createWorld(0, 0, 300, 40);
    populate(world, items(40), seededRandom(5));
    world.agitation = 1;
    advanceWorld(world, 12, seededRandom(1));
    for (const b of world.balls) {
      expect(Number.isFinite(b.x)).toBe(true);
      expect(Number.isFinite(b.y)).toBe(true);
    }
  });

  it('mantiene el solver despues de un resize previo a poblar', () => {
    // Regresion: resizeWorld dimensionaba la rejilla con balls.length. En el
    // primer layout del overlay las bolas dan 0, el buffer quedaba en 1 y
    // Int32Array ignoraba en silencio las escrituras fuera de rango: el bombo
    // se renderizaba pero sin ninguna colision entre bolas.
    const world = createWorld(0, 0, 300, 60);
    resizeWorld(world, 100, 200, 356);
    populate(world, items(2), seededRandom(9));

    expect(world.grid.items.length).toBeGreaterThanOrEqual(world.balls.length);

    const [a, b] = world.balls;
    a!.x = 0;
    a!.y = 0;
    b!.x = 1;
    b!.y = 0;

    resolveCollisionsNow(world);
    expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeGreaterThan(a!.r + b!.r - 1);
  });
});

describe('addBall', () => {
  it('agrega una bola sin tocar las anteriores', () => {
    const world = createWorld(0, 0, 300, 60);
    populate(world, items(10), seededRandom(4));
    const before = world.balls.map((b) => ({ x: b.x, y: b.y, id: b.id }));

    const index = addBall(world, { id: 'nuevo', label: 'Nombre Nuevo' }, seededRandom(3), 0);

    expect(index).toBe(10);
    expect(world.balls).toHaveLength(11);
    for (let i = 0; i < before.length; i++) {
      expect(world.balls[i]!.id).toBe(before[i]!.id);
      expect(world.balls[i]!.x).toBe(before[i]!.x);
      expect(world.balls[i]!.y).toBe(before[i]!.y);
    }
  });

  it('coloca la bola nueva dentro del bombo y sin tapar a otra', () => {
    const world = createWorld(0, 0, 300, 60);
    populate(world, items(12), seededRandom(8));

    addBall(world, { id: 'nuevo', label: 'Nombre Nuevo' }, seededRandom(17), 0);
    const fresh = world.balls[world.balls.length - 1]!;

    expect(Math.hypot(fresh.x, fresh.y) + fresh.r).toBeLessThanOrEqual(world.R + 0.001);

    for (const other of world.balls.slice(0, -1)) {
      expect(Math.hypot(fresh.x - other.x, fresh.y - other.y)).toBeGreaterThan(fresh.r + other.r);
    }
  });

  it('deja todas las bolas con el mismo radio', () => {
    const world = createWorld(0, 0, 300, 60);
    populate(world, items(20), seededRandom(6));
    addBall(world, { id: 'nuevo', label: 'Otro' }, seededRandom(2), 0);

    expect(new Set(world.balls.map((b) => b.r)).size).toBe(1);
  });

  it('la simulacion sigue moviendo la bola nueva sin sacarla del bombo', () => {
    const world = createWorld(0, 0, 300, 60);
    populate(world, items(20), seededRandom(6));
    addBall(world, { id: 'nuevo', label: 'Otro' }, seededRandom(2), 0);

    run(world, 400, 0);
    for (const b of world.balls) {
      expect(Math.hypot(b.x, b.y) + b.r).toBeLessThanOrEqual(world.R + 0.5);
    }
  });

  it('devuelve -1 cuando el bombo esta lleno', () => {
    const world = createWorld(0, 0, 300, 5);
    populate(world, items(5), seededRandom(1));
    expect(addBall(world, { id: 'nuevo', label: 'Tarde' }, seededRandom(1), 0)).toBe(-1);
    expect(world.balls).toHaveLength(5);
  });

  it('anima la entrada de la bola durante SPAWN_DURATION', () => {
    const world = createWorld(0, 0, 300, 20);
    populate(world, items(5), seededRandom(1));

    const index = addBall(world, { id: 'nuevo', label: 'Otro' }, seededRandom(1), 10);
    const fresh = world.balls[index!]!;

    expect(spawnProgressOf(fresh, 10)).toBe(0);
    expect(spawnProgressOf(fresh, 10 + SPAWN_DURATION / 2)).toBeCloseTo(0.5, 5);
    expect(spawnProgressOf(fresh, 10 + SPAWN_DURATION)).toBeCloseTo(1, 5);
    expect(spawnProgressOf(fresh, 10 + SPAWN_DURATION * 2)).toBe(1);
  });
});
