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
  SHAKE_IMPULSE,
  shakeWorld,
  SPAWN_DURATION,
  spawnProgressOf,
  type World,
} from '../src/lib/physics';
import { seededRandom } from '../src/lib/rng';
import type { ParticipantItem } from '../src/lib/types';

function items(n: number): ParticipantItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, label: `P${i}` }));
}

function run(world: World, frames: number, agitation: number, seed = 0): void {
  for (let i = 0; i < frames; i++) {
    world.agitation = agitation;
    advanceWorld(world, 1 / 60, seededRandom(seed + i));
  }
}

/** Momentum angular medio alrededor del centro: >0 gira antihorario. */
function meanAngularMomentum(world: World): number {
  let total = 0;
  for (const b of world.balls) {
    total += (b.x - world.cx) * b.vy - (b.y - world.cy) * b.vx;
  }
  return total / world.balls.length;
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

  it('disipa la energia cuando deja de agitarse', () => {
    const world = createWorld(0, 0, 300, 50);
    populate(world, items(50), seededRandom(11));
    run(world, 600, 1);
    const peak = kineticEnergy(world);

    run(world, 1800, 0);
    expect(kineticEnergy(world)).toBeLessThan(peak * 0.05);
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
    // primer layout del overlay las bolas son 0, el buffer quedaba en 1 y
    // Int32Array ignoraba en silencio las escrituras fuera de rango: el bombo
    // se renderizaba pero sin ninguna colision entre bolas.
    const world = createWorld(0, 0, 300, 60);
    resizeWorld(world, 100, 200, 356);
    populate(world, items(2), seededRandom(9));

    expect(world.grid.items.length).toBeGreaterThanOrEqual(world.balls.length);

    const [a, b] = world.balls;
    a!.x = 100;
    a!.y = 200;
    b!.x = 101;
    b!.y = 200;

    resolveCollisionsNow(world);
    expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeGreaterThan(a!.r + b!.r - 1);
  });
});

describe('giro del bombo', () => {
  function spunWorld(spinRate: number, count: number, seed: number): World {
    const world = createWorld(0, 0, 300, 60);
    world.spinRate = spinRate;
    populate(world, items(count), seededRandom(seed));
    return world;
  }

  it('arrastra las bolas en el sentido del giro, no al azar', () => {
    // La prueba de que la fisica es la del bombo y no ruido: con el tambor
    // girando antihorario, el conjunto adquiere momentum angular positivo.
    const world = spunWorld(2.6, 40, 31);
    run(world, 900, 1);
    expect(meanAngularMomentum(world)).toBeGreaterThan(0);
  });

  it('girando al reves arrastra al reves', () => {
    const world = spunWorld(-2.6, 40, 31);
    run(world, 900, 1);
    expect(meanAngularMomentum(world)).toBeLessThan(0);
  });

  it('sin giro no hay direccion preferida', () => {
    const quieto = spunWorld(0, 40, 31);
    const girando = spunWorld(2.6, 40, 31);
    run(quieto, 900, 1);
    run(girando, 900, 1);

    expect(Math.abs(meanAngularMomentum(quieto))).toBeLessThan(
      Math.abs(meanAngularMomentum(girando)) * 0.5,
    );
  });

  it('la friccion del muro arrastra una bola apoyada', () => {
    // La pared en rotacion debe empujar tangencialmente: sin esto el giro del
    // bombo no se transmitiria a la bola. Con giro positivo, en el fondo del
    // bombo (y abajo en canvas) la tangente apunta hacia -x.
    const world = createWorld(0, 300, 300, 4);
    world.spinRate = 4;
    populate(world, items(1), seededRandom(3));
    const ball = world.balls[0]!;
    ball.x = 0;
    ball.y = world.cy + (world.R - ball.r) - 0.2;
    ball.vx = 0;
    ball.vy = 0;

    const before = ball.x;
    run(world, 15, 1);
    expect(ball.x).toBeLessThan(before - 5);
    expect(ball.vx).toBeLessThan(0);
  });

  it('el aire no toca a una bola en la mitad superior', () => {
    // La misma bola, con y sin agitacion, tiene que caer igual: el acople de
    // aire solo existe en la base.
    const recipe = (agitation: number) => {
      const world = createWorld(0, 0, 300, 10);
      populate(world, items(1), seededRandom(3));
      const ball = world.balls[0]!;
      ball.x = 0;
      ball.y = -0.6 * world.R;
      ball.vx = 0;
      ball.vy = 0;
      world.spinRate = 2.6;
      run(world, 10, agitation);
      return { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy };
    };

    expect(recipe(1)).toEqual(recipe(0));
  });

  it('el aire de la base empuja en horizontal y no hacia arriba', () => {
    // En el fondo la tangente del tambor es horizontal. La corriente no debe
    // tener componente vertical: eso es lo que hacia flotar bolas sueltas.
    const world = createWorld(0, 0, 300, 10);
    populate(world, items(1), seededRandom(3));
    const ball = world.balls[0]!;
    ball.x = 0;
    ball.y = 0.7 * world.R;
    ball.vx = 0;
    ball.vy = 0;
    world.spinRate = 2.6;

    run(world, 5, 1);
    expect(ball.vx).toBeLessThan(0);
    expect(ball.vy).toBeGreaterThan(0);
  });

  it('el aire se prolonga por el flanco izquierdo', () => {
    // La corriente sigue por el lado ascendente: una bola que sube por la
    // izquierda conserva el impulso en vez de frenarse por gravedad y roce.
    const fly = (agitation: number) => {
      const world = createWorld(0, 0, 300, 10);
      populate(world, items(1), seededRandom(3));
      const ball = world.balls[0]!;
      ball.x = -0.7 * world.R;
      ball.y = 0;
      ball.vx = 0;
      ball.vy = -300;
      world.spinRate = 4.6;
      run(world, 20, agitation);
      return { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy };
    };

    const conAire = fly(1);
    const sinAire = fly(0);
    expect(conAire.vy).toBeLessThan(sinAire.vy);
    expect(conAire.y).toBeLessThan(sinAire.y);
  });

  it('las bolas no se pegan al muro: la gravedad sigue mandando', () => {
    const world = spunWorld(2.6, 40, 77);
    run(world, 1200, 1);

    let pegadas = 0;
    for (const b of world.balls) {
      if (Math.hypot(b.x, b.y) + b.r >= world.R - 0.5) pegadas++;
    }
    expect(pegadas).toBeLessThan(world.balls.length / 2);
  });

  it('el interior de la pila tambien se mueve', () => {
    const world = createWorld(0, 0, 335, 60);
    populate(world, items(57), seededRandom(7));
    run(world, 300, 1);

    let interior = 0;
    let speed = 0;
    for (const b of world.balls) {
      if (Math.hypot(b.x, b.y) + b.r >= world.R - 1.5) continue;
      interior += 1;
      speed += Math.hypot(b.vx, b.vy);
    }

    expect(interior).toBeGreaterThan(10);
    expect(speed / interior).toBeGreaterThan(250);
  });

  it('con pocas bolas ninguna queda flotando en el medio', () => {
    // El aire tambien sopla por el flanco izquierdo, asi que es valido que una
    // bola suba por ese lado. Lo que no debe pasar es que quede flotando en el
    // centro o la parte de arriba, lejos del flanco ascendente.
    const world = createWorld(0, 0, 335, 60);
    populate(world, items(5), seededRandom(7));
    run(world, 400, 1);

    const flotando = world.balls.filter(
      (b) => b.y - world.cy < -0.2 * world.R && b.x - world.cx > -0.2 * world.R,
    );
    expect(flotando).toHaveLength(0);
  });

  it('la base se mueve tanto con pocas como con muchas bolas', () => {
    // La corriente de la base tiene que agitar la pila en los dos extremos: no
    // es solo un efecto de las bolas que quedan cerca del muro.
    const bottomSpeed = (n: number): number => {
      const world = createWorld(0, 0, 335, 200);
      populate(world, items(n), seededRandom(7));
      run(world, 300, 1);
      const bottom = world.balls.filter((b) => b.y - world.cy > 0.2 * world.R);
      return bottom.reduce((s, b) => s + Math.hypot(b.vx, b.vy), 0) / bottom.length;
    };

    expect(bottomSpeed(5)).toBeGreaterThan(40);
    expect(bottomSpeed(57)).toBeGreaterThan(40);
  });
});

describe('rotacion de las bolas', () => {
  it('una bola que circula por el bombo adquiere giro', () => {
    const world = createWorld(0, 0, 300, 10);
    populate(world, items(10), seededRandom(5));
    world.spinRate = 2.6;
    run(world, 900, 1);

    expect(world.balls.some((b) => Math.abs(b.spin) > 0.05)).toBe(true);
  });

  it('el giro no crece solo con el tiempo', () => {
    const world = createWorld(0, 0, 300, 40);
    populate(world, items(40), seededRandom(3));
    run(world, 600, 1);
    const early = world.balls.reduce((s, b) => s + Math.abs(b.spin), 0);
    run(world, 2400, 1);
    const late = world.balls.reduce((s, b) => s + Math.abs(b.spin), 0);

    expect(late).toBeLessThan(early * 4);
  });
});

describe('reposo', () => {
  it('una pila se asienta y se queda quieta', () => {
    // La metrica es la DERIVA: lo que se ve en pantalla es que la bola se mueva
    // de lugar. Con warm starting la pila converge y duerme de verdad.
    const world = createWorld(0, 0, 335, 200);
    populate(world, items(57), seededRandom(13));
    run(world, 1800, 0);

    const antes = world.balls.map((b) => ({ x: b.x, y: b.y }));
    run(world, 600, 0, 5000);

    let peor = 0;
    for (let i = 0; i < world.balls.length; i++) {
      peor = Math.max(
        peor,
        Math.hypot(world.balls[i]!.x - antes[i]!.x, world.balls[i]!.y - antes[i]!.y),
      );
    }
    expect(peor).toBeLessThan(0.5);
  });

  it('una pila de 200 bolas converge (warm starting)', () => {
    // Sin warm starting el residuo de una pila de 200 quedaba en ~97 px/s y solo
    // una fraccion dormia. Con contactos persistentes la pila hereda el apoyo y
    // se asienta entera.
    const world = createWorld(0, 0, 335, 200);
    populate(world, items(200), seededRandom(13));
    run(world, 1800, 0);

    let maxv = 0;
    let dormidas = 0;
    for (const b of world.balls) {
      maxv = Math.max(maxv, Math.hypot(b.vx, b.vy));
      if (b.sleeping) dormidas += 1;
    }

    expect(maxv).toBeLessThan(15);
    expect(dormidas).toBeGreaterThan(world.balls.length * 0.8);
  });

  it('las dormidas no reciben gravedad', () => {
    // Si una bola "congelada" siguiera en la integracion, la gravedad la
    // hundiria, perderia el contacto y se despertaria: un ciclo lento que en
    // pantalla parece una bola flotando y tiritando.
    const world = createWorld(0, 0, 335, 200);
    populate(world, items(30), seededRandom(7));
    run(world, 1800, 0);

    const dormidas = world.balls.filter((b) => b.sleeping);
    expect(dormidas.length).toBeGreaterThan(0);

    const antes = dormidas.map((b, i) => ({ b, x: b.x, y: b.y, i }));

    run(world, 300, 0, 8000);

    // Solo las que siguen dormidas: una que se despierta por un choque es
    // comportamiento correcto y no tiene por que quedarse pegada.
    for (const ref of antes) {
      if (!ref.b.sleeping) continue;
      expect(Math.hypot(ref.b.x - ref.x, ref.b.y - ref.y)).toBe(0);
      expect(Math.hypot(ref.b.vx, ref.b.vy)).toBe(0);
    }
  });

  it('no se duerme en el aire', () => {
    const world = createWorld(0, 0, 300, 10);
    populate(world, items(10), seededRandom(2));
    const b = world.balls[0]!;
    b.vy = -800;
    b.spin = 5;

    run(world, 6, 0);
    expect(b.sleeping).toBe(false);
    expect(Math.hypot(b.vx, b.vy) + Math.abs(b.spin)).toBeGreaterThan(0.5);
  });

  it('la agitacion despierta lo que estaba dormido', () => {
    const world = createWorld(0, 0, 300, 30);
    populate(world, items(30), seededRandom(9));
    run(world, 1800, 0);
    const quieto = kineticEnergy(world);
    expect(world.balls.every((b) => b.sleeping)).toBe(true);

    run(world, 300, 1);
    expect(kineticEnergy(world)).toBeGreaterThan(quieto);
    expect(world.balls.some((b) => !b.sleeping)).toBe(true);
  });
});

describe('estabilidad', () => {
  it('el asentamiento no inyecta energia en reposo', () => {
    // Con un estado ya asentado y sin agitacion, la energia cinetica tiene que
    // quedar en cero. Una correccion de penetracion que empuja posiciones o un
    // solver sin warm starting la harian crecer.
    const world = createWorld(0, 0, 300, 60);
    populate(world, items(60), seededRandom(19));
    run(world, 1800, 0);

    const inicial = kineticEnergy(world);
    let pico = inicial;
    for (let i = 0; i < 1200; i++) {
      advanceWorld(world, 1 / 60, seededRandom(i));
      pico = Math.max(pico, kineticEnergy(world));
    }

    expect(pico).toBeLessThan(1e-3);
    expect(kineticEnergy(world)).toBeLessThan(1e-3);
  });

  it('no aparecen NaN ni infinitos tras un dt enorme', () => {
    const world = createWorld(0, 0, 300, 60);
    populate(world, items(60), seededRandom(4));
    world.agitation = 1;
    advanceWorld(world, 12, seededRandom(2));

    for (const b of world.balls) {
      expect(Number.isFinite(b.x)).toBe(true);
      expect(Number.isFinite(b.y)).toBe(true);
      expect(Number.isFinite(b.spin)).toBe(true);
    }
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
    const fresh = world.balls[index]!;

    expect(spawnProgressOf(fresh, 10)).toBe(0);
    expect(spawnProgressOf(fresh, 10 + SPAWN_DURATION / 2)).toBeCloseTo(0.5, 5);
    expect(spawnProgressOf(fresh, 10 + SPAWN_DURATION)).toBeCloseTo(1, 5);
    expect(spawnProgressOf(fresh, 10 + SPAWN_DURATION * 2)).toBe(1);
  });
});

describe('sacudida manual', () => {
  function settled(count = 40): World {
    const world = createWorld(0, 0, 300, 60);
    populate(world, items(count), seededRandom(13));
    run(world, 1200, 0);
    return world;
  }

  it('despierta todas las bolas y las empuja en la direccion del golpe', () => {
    const world = settled();
    expect(world.balls.some((b) => b.sleeping)).toBe(true);

    shakeWorld(world, 1, 0, 400);

    expect(world.balls.every((b) => !b.sleeping)).toBe(true);
    const meanVx = world.balls.reduce((s, b) => s + b.vx, 0) / world.balls.length;
    expect(meanVx).toBeGreaterThan(0);
  });

  it('las bolas del lado del golpe salen con mas fuerza', () => {
    const world = settled();
    shakeWorld(world, 1, 0, 400);

    const speed = (side: 'left' | 'right'): number => {
      const set = world.balls.filter((b) => (side === 'left' ? b.x < world.cx : b.x > world.cx));
      return set.reduce((s, b) => s + Math.hypot(b.vx, b.vy), 0) / set.length;
    };

    // El golpe empuja hacia +x: el impacto es del lado izquierdo.
    expect(speed('left')).toBeGreaterThan(speed('right'));
  });

  it('con el golpe fuerte las bolas no se escapan del bombo', () => {
    const world = settled();
    shakeWorld(world, 1, 0, SHAKE_IMPULSE);
    run(world, 120, 0);

    for (const b of world.balls) {
      expect(Number.isFinite(b.x)).toBe(true);
      expect(Number.isFinite(b.y)).toBe(true);
      expect(Math.hypot(b.x - world.cx, b.y - world.cy) + b.r).toBeLessThanOrEqual(world.R + 1);
    }
  });

  it('sin direccion no toca nada', () => {
    const world = settled();
    const before = world.balls.map((b) => [b.vx, b.vy, b.sleeping]);
    shakeWorld(world, 0, 0, 400);
    expect(world.balls.map((b) => [b.vx, b.vy, b.sleeping])).toEqual(before);
  });
});
