import { shuffle, type RandomSource } from './rng';
import type { ParticipantItem } from './types';

const TAU = Math.PI * 2;
const FIXED_DT = 1 / 120;
const GRAVITY = 2100;
const DRAG = 0.55;
const WALL_RESTITUTION = 0.58;
const BALL_RESTITUTION = 0.5;
const TANGENTIAL_FRICTION = 0.22;
const MAX_SPEED = 3200;
const SHAKE_INTERVAL = 0.07;
const SHAKE_STRENGTH = 620;
const PACKING = 0.5;
const SOLVER_ITERATIONS = 3;
const CONTACT_SLOP = 0.05;
const CORRECTION = 0.8;

export const MIN_BALL_R = 7;
export const MAX_BALL_R = 42;

export interface Ball {
  id: string;
  label: string;
  /** Version abreviada que entra en la bola segun su radio. Vacia si no entra. */
  displayLabel: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hue: number;
  /** Reloj global en que la bola entro; se usa para la animacion de aparicion. */
  spawnAt: number;
}

interface Grid {
  cellSize: number;
  cols: number;
  counts: Int32Array;
  items: Int32Array;
}

export interface World {
  cx: number;
  cy: number;
  R: number;
  balls: Ball[];
  /** Tope de bolas: la rejilla se dimensiona con esto, no con balls.length. */
  maxBalls: number;
  agitation: number;
  spinRate: number;
  spinPhase: number;
  shakeTimer: number;
  grid: Grid;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function makeGrid(R: number, maxBalls: number): Grid {
  const cellSize = MAX_BALL_R * 2;
  const cols = Math.max(1, Math.ceil((2 * R) / cellSize) + 2);
  const cells = cols * cols;
  return {
    cellSize,
    cols,
    counts: new Int32Array(cells + 1),
    items: new Int32Array(Math.max(1, maxBalls)),
  };
}

export function createWorld(cx: number, cy: number, R: number, maxBalls = 200): World {
  return {
    cx,
    cy,
    R,
    balls: [],
    maxBalls,
    agitation: 0,
    spinRate: 2.6,
    spinPhase: 0,
    shakeTimer: SHAKE_INTERVAL,
    grid: makeGrid(R, maxBalls),
  };
}

/** Reubica el bombo y reconstruye la rejilla, que depende del radio.
 *  Ojo: el buffer de items se dimensiona con maxBalls. Si usara balls.length,
 *  un resize antes de poblar dejaría el buffer en 1 y el solver descartaría
 *  silenciosamente casi todas las bolas (Int32Array ignora escrituras fuera
 *  de rango), dejando el bombo sin colisiones. */
export function resizeWorld(world: World, cx: number, cy: number, R: number): void {
  world.cx = cx;
  world.cy = cy;
  world.R = R;
  world.grid = makeGrid(R, world.maxBalls);
}


/** Radio uniforme para que `count` bolas entren en el bombo sin saturarlo. */
export function ballRadiusFor(count: number, R: number): number {
  if (count <= 0) return MAX_BALL_R;
  return clamp(R * Math.sqrt(PACKING / count), MIN_BALL_R, MAX_BALL_R);
}

/** Retícula hexagonal dentro del círculo: densidad ~0.9, sin posiciones repetidas. */
function latticeSlots(world: World, r: number): { x: number; y: number }[] {
  const maxD = Math.max(0, world.R - r);
  const spacing = r * 2.04;
  const rowStep = spacing * 0.866;
  const cols = Math.max(1, Math.ceil((maxD * 2) / spacing) + 1);
  const rows = Math.max(1, Math.ceil((maxD * 2) / rowStep) + 1);

  const slots: { x: number; y: number }[] = [];
  for (let ry = 0; ry < rows; ry++) {
    const y = -maxD + ry * rowStep;
    const offset = (ry % 2) * spacing * 0.5;
    for (let rx = 0; rx < cols; rx++) {
      const x = -maxD + rx * spacing + offset;
      if (x * x + y * y <= maxD * maxD) slots.push({ x: world.cx + x, y: world.cy + y });
    }
  }
  return slots;
}

/**
 * Cuanto mas chica la bola, mas corta la etiqueta. Con muchas participantes
 * un nombre completo no entra ni se lee en un stream, asi que caemos a
 * iniciales; si tampoco entra, la bola va sin texto.
 */
export function displayLabelFor(label: string, r: number): string {
  if (!label) return '';
  if (r >= 26) return label;

  if (r >= 17) {
    const parts = label.split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]![0]!}${parts[parts.length - 1]![0]!}`.toUpperCase();
    }
    return label.slice(0, 3).toUpperCase();
  }

  return '';
}

export function populate(world: World, items: readonly ParticipantItem[], rand: RandomSource): void {
  const n = items.length;
  if (n === 0) {
    world.balls = [];
    return;
  }

  // Si la retícula no alcanza para todos los participantes, achicamos las
  // bolas en vez de reciclar posiciones: dos bolas naciendo en el mismo
  // punto producen un solapamiento que el solver tarda segundos en digerir.
  let r = ballRadiusFor(n, world.R);
  let spots = latticeSlots(world, r);
  for (let attempt = 0; spots.length < n && r > MIN_BALL_R && attempt < 16; attempt++) {
    r = Math.max(MIN_BALL_R, r * 0.94);
    spots = latticeSlots(world, r);
  }

  const chosen = shuffle(spots, rand);
  const jitter = Math.min(r * 0.12, r - MIN_BALL_R / 2);
  const maxD = Math.max(0, world.R - r);
  const balls: Ball[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const spot = chosen[i % chosen.length]!;
    balls[i] = {
      id: items[i]!.id,
      label: items[i]!.label,
      displayLabel: displayLabelFor(items[i]!.label, r),
      x: clamp(spot.x + (rand() - 0.5) * jitter, world.cx - maxD, world.cx + maxD),
      y: clamp(spot.y + (rand() - 0.5) * jitter, world.cy - maxD, world.cy + maxD),
      vx: (rand() - 0.5) * 240,
      vy: 120 + rand() * 260,
      r,
      hue: (i * 137.508) % 360,
      spawnAt: 0,
    };
  }

  world.balls = balls;
}

export const SPAWN_DURATION = 0.35;

/**
 * Inserta una bola suelta sin reconstruir el bombo ni tocar las demas. Se usa
 * cuando alguien se anota por chat mientras la tombola esta en reposo.
 *
 * El radio se recalcula segun cuantos hay para que el conjunto siga entrando;
 * si las bolas existentes tenian otro radio, se ajustan todas de golpe (solo
 * pasa mientras la tombola esta quieta, asi que no se nota).
 *
 * Devuelve el indice de la bola nueva, o -1 si el bombo esta lleno.
 */
export function addBall(
  world: World,
  item: ParticipantItem,
  rand: RandomSource,
  clock: number,
): number {
  if (world.balls.length >= world.maxBalls) return -1;

  const target = ballRadiusFor(world.balls.length + 1, world.R);
  const changed = Math.abs(world.balls[0]!.r - target) > 0.5;
  for (const b of world.balls) b.r = target;

  const maxD = Math.max(0, world.R - target);
  let x = world.cx;
  let y = world.cy - maxD * 0.6;
  let placed = false;

  for (let attempt = 0; attempt < 220 && !placed; attempt++) {
    const angle = rand() * TAU;
    const dist = Math.sqrt(rand()) * maxD;
    x = world.cx + Math.cos(angle) * dist;
    y = world.cy + Math.sin(angle) * dist;

    placed = true;
    for (const other of world.balls) {
      const min = (target + other.r) * 1.02;
      if ((x - other.x) ** 2 + (y - other.y) ** 2 < min * min) {
        placed = false;
        break;
      }
    }
  }

  if (!placed) {
    // Sin hueco libre: cae desde arriba y el solver la acomoda en el proximo
    // paso. Es preferible un solapamiento de un frame a descartar a alguien.
    x = world.cx + (rand() - 0.5) * target * 2;
    y = world.cy - maxD;
  }

  world.balls.push({
    id: item.id,
    label: item.label,
    displayLabel: displayLabelFor(item.label, target),
    x: clamp(x, world.cx - maxD, world.cx + maxD),
    y: clamp(y, world.cy - maxD, world.cy + maxD),
    vx: (rand() - 0.5) * 160,
    vy: -120 - rand() * 180,
    r: target,
    hue: (world.balls.length * 137.508) % 360,
    spawnAt: changed ? clock - SPAWN_DURATION : clock,
  });

  return world.balls.length - 1;
}

/** 0..1 de la animacion de entrada de la bola. 1 = ya aparecio. */
export function spawnProgressOf(ball: Ball, clock: number): number {
  const t = (clock - ball.spawnAt) / SPAWN_DURATION;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

function shake(world: World, rand: RandomSource): void {
  const power = SHAKE_STRENGTH * world.agitation;
  const spin = world.spinRate * world.agitation * 190;
  for (const b of world.balls) {
    const angle = rand() * TAU;
    const mag = power * (0.4 + rand() * 0.9);
    b.vx += Math.cos(angle) * mag;
    b.vy += Math.sin(angle) * mag;

    const dx = b.x - world.cx;
    const dy = b.y - world.cy;
    const d = Math.hypot(dx, dy) || 1;
    const tangent = spin * (0.4 + rand() * 0.9);
    b.vx += (-dy / d) * tangent;
    b.vy += (dx / d) * tangent;
  }
}

function integrate(world: World, dt: number): void {
  const dragK = Math.max(0, 1 - DRAG * dt);

  for (const b of world.balls) {
    b.vy += GRAVITY * dt;
    b.vx *= dragK;
    b.vy *= dragK;

    const speed = Math.hypot(b.vx, b.vy);
    if (speed > MAX_SPEED) {
      const k = MAX_SPEED / speed;
      b.vx *= k;
      b.vy *= k;
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;
  }
}

/** Mantiene cada bola dentro del tambor. Se aplica DESPUES de resolver
 *  colisiones, porque separar bolas puede empujarlas contra el muro. */
function constrainToWalls(world: World): void {
  const { balls, cx, cy, R } = world;

  for (const b of balls) {
    const dx = b.x - cx;
    const dy = b.y - cy;
    const d = Math.hypot(dx, dy);
    const limit = R - b.r;
    if (d <= limit || d < 1e-6) continue;

    const nx = dx / d;
    const ny = dy / d;
    b.x = cx + nx * limit;
    b.y = cy + ny * limit;

    const vn = b.vx * nx + b.vy * ny;
    if (vn <= 0) continue;

    const tx = -ny;
    const ty = nx;
    const vt = (b.vx * tx + b.vy * ty) * (1 - TANGENTIAL_FRICTION);
    b.vx = -vn * WALL_RESTITUTION * nx + vt * tx;
    b.vy = -vn * WALL_RESTITUTION * ny + vt * ty;
  }
}

function buildGrid(world: World): void {
  const g = world.grid;
  const cells = g.cols * g.cols;
  g.counts.fill(0);

  for (const b of world.balls) g.counts[cellIndex(b, world, g)]! += 1;

  let sum = 0;
  for (let c = 0; c < cells; c++) {
    sum += g.counts[c]!;
    g.counts[c] = sum;
  }
  // counts tiene cells+1 entradas: este es el "fin" de la ultima celda.
  g.counts[cells] = sum;

  for (let i = world.balls.length - 1; i >= 0; i--) {
    const c = cellIndex(world.balls[i]!, world, g);
    g.counts[c]! -= 1;
    g.items[g.counts[c]!] = i;
  }
}

function cellIndex(b: Ball, world: World, g: Grid): number {
  const rawX = ((b.x - world.cx + world.R) / g.cellSize) | 0;
  const rawY = ((b.y - world.cy + world.R) / g.cellSize) | 0;
  const x = rawX < 0 ? 0 : rawX >= g.cols ? g.cols - 1 : rawX;
  const y = rawY < 0 ? 0 : rawY >= g.cols ? g.cols - 1 : rawY;
  return y * g.cols + x;
}

function resolvePair(a: Ball, b: Ball): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  const rsum = a.r + b.r;
  if (d2 >= rsum * rsum) return;

  let nx: number;
  let ny: number;
  let d: number;
  if (d2 < 1e-9) {
    nx = 1;
    ny = 0;
    d = rsum;
  } else {
    d = Math.sqrt(d2);
    nx = dx / d;
    ny = dy / d;
  }

  const ma = a.r * a.r;
  const mb = b.r * b.r;
  const total = ma + mb;

  // Correccion posicional ponderada por masa: las bolas livianas ceden mas.
  const overlap = rsum - d - CONTACT_SLOP;
  if (overlap > 0) {
    const push = CORRECTION * overlap;
    a.x -= nx * push * (mb / total);
    a.y -= ny * push * (mb / total);
    b.x += nx * push * (ma / total);
    b.y += ny * push * (ma / total);
  }

  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const vn = rvx * nx + rvy * ny;
  if (vn >= 0) return;

  const impulse = (-(1 + BALL_RESTITUTION) * vn) / (1 / ma + 1 / mb);

  a.vx -= (nx * impulse) / ma;
  a.vy -= (ny * impulse) / ma;
  b.vx += (nx * impulse) / mb;
  b.vy += (ny * impulse) / mb;

  const tx = -ny;
  const ty = nx;
  const vt = rvx * tx + rvy * ty;
  const jt = clamp(-vt * 0.12, -impulse * 0.3, impulse * 0.3);

  a.vx -= (tx * jt) / ma;
  a.vy -= (ty * jt) / ma;
  b.vx += (tx * jt) / mb;
  b.vy += (ty * jt) / mb;
}

// Vecindario 3x3 completo. Con el filtro `j > i` de resolveCollisions cada
// par se resuelve exactamente una vez. Usar solo la mitad del vecindario NO
// sirve aca: el orden de indices de las bolas es independiente del orden de
// las celdas, asi que la mitad de los pares entre celdas distintas se
// descartarian y quedarian bolas superpuestas.
const NEIGHBORS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [0, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const;

function resolveCollisions(world: World): void {
  buildGrid(world);
  const g = world.grid;
  const cols = g.cols;
  const balls = world.balls;

  for (let i = 0; i < balls.length; i++) {
    const a = balls[i]!;
    const rawX = ((a.x - world.cx + world.R) / g.cellSize) | 0;
    const rawY = ((a.y - world.cy + world.R) / g.cellSize) | 0;

    for (const [ox, oy] of NEIGHBORS) {
      const gx = rawX + ox;
      const gy = rawY + oy;
      if (gx < 0 || gy < 0 || gx >= cols || gy >= cols) continue;

      const cell = gy * cols + gx;
      for (let k = g.counts[cell]!; k < g.counts[cell + 1]!; k++) {
        const j = g.items[k]!;
        if (j > i) resolvePair(a, balls[j]!);
      }
    }
  }
}

export function advanceWorld(world: World, dt: number, rand: RandomSource): void {
  if (dt <= 0) return;

  world.spinPhase += world.spinRate * world.agitation * dt;

  if (world.agitation > 0.001) {
    world.shakeTimer -= dt;
    while (world.shakeTimer <= 0) {
      world.shakeTimer += SHAKE_INTERVAL;
      shake(world, rand);
    }
  } else {
    world.shakeTimer = SHAKE_INTERVAL;
  }

  let remaining = Math.min(dt, 0.25);
  while (remaining > 0) {
    const h = Math.min(FIXED_DT, remaining);
    integrate(world, h);
    for (let s = 0; s < SOLVER_ITERATIONS; s++) {
      resolveCollisions(world);
      constrainToWalls(world);
    }
    remaining -= h;
  }
}

/** Util para tests: separa dos bolas que se hayan solapado. */
export function resolveCollisionsNow(world: World): void {
  for (let s = 0; s < SOLVER_ITERATIONS; s++) {
    resolveCollisions(world);
    constrainToWalls(world);
  }
}

export function kineticEnergy(world: World): number {
  let total = 0;
  for (const b of world.balls) total += 0.5 * b.r * b.r * (b.vx * b.vx + b.vy * b.vy);
  return total;
}
