import { shuffle, type RandomSource } from './rng';
import type { ParticipantItem } from './types';

const TAU = Math.PI * 2;

/**
 * Paso temporal fijo. La simulacion nunca ve el dt real del frame: eso la haria
 * depender de los FPS. `advanceWorld` parte el dt en pasos de este tamano.
 */
const FIXED_DT = 1 / 120;

/**
 * Techo de tiempo simulado por llamada. Un frame perdido (pausa de OBS, tab en
 * segundo plano) puede traer un dt enorme: sin tope habria que simular segundos
 * enteros de una sola vez y el overlay se congelaria. El resto se descarta.
 */
const MAX_FRAME_DT = 0.25;

const GRAVITY = 2100;

/** Amortiguacion viscosa del aire, como factor por segundo. */
const DRAG = 0.55;
/** El giro se frena algo mas fuerte: una bola que rueda sin rodar se nota. */
const SPIN_DRAG = DRAG * 1.6;

const MAX_SPEED = 3200;

const PACKING = 0.5;

export const MIN_BALL_R = 7;
export const MAX_BALL_R = 42;

/**
 * Iteraciones del solver por subpaso. Con warm starting (ver abajo) unas pocas
 * alcanzan: los impulsos se heredan del paso anterior, asi que una pila no tiene
 * que re-converger desde cero cada frame.
 */
const SOLVER_ITERATIONS = 8;

/**
 * Holgura: solapamiento tolerado antes de que la correccion de posicion empuje.
 * Un valor chico evita que se vean bolas traspasadas; no puede ser cero porque
 * entonces cada contacto empuja y el sistema nunca queda quieto.
 */
const SLOP = 0.35;

/**
 * La penetracion se resuelve moviendo posiciones, no cambiando velocidades. Es
 * la version "split" de la correccion: al no tocar la velocidad no inyecta
 * energia cinetica (el asentamiento no puede autoacelerarse). Con warm starting
 * la penetracion es chica, asi que la correccion tambien.
 */
const POSITION_CORRECTION = 0.25;
const POSITION_ITERATIONS = 3;

/** Margen para no perder un contacto que se acaba de separar por epsilon. */
const CONTACT_MARGIN = 0.5;

/**
 * Restitucion que se desvanece en impactos lentos: por debajo de esta velocidad
 * el rebote tiende a cero. Sin esto una pila asentada se autoalimenta (la
 * gravedad acerca, el rebote separa, y el conjunto vibra para siempre).
 */
const REST_VELOCITY = 110;
const WALL_RESTITUTION = 0.52;
const BALL_RESTITUTION = 0.42;

/** Friccion de Coulomb. El tope es la fuerza normal acumulada del contacto. */
const MU_WALL = 0.55;
const MU_BALL = 0.32;

/**
 * Aire arrastrado por el tambor. No es una fuerza por bola ni una sacudida
 * aleatoria: es una corriente hacia la que las bolas se acoplan de forma
 * viscosa. Solo sopla en la base: si se aplica en todo el volumen, una bola que
 * queda en el medio recibe una componente vertical que compite con la gravedad
 * y se ve flotando. En la base empuja la pila contra el piso, que es donde el
 * giro tiene que notarse. La reaccion la absorbe el motor del bombo, externo.
 */
const AIR_COUPLING = 0.8;
const AIR_RATE = 2.8;
const AIR_SPIN_RATE = 2.8;
/** Banda vertical (fraccion de R por debajo del centro) donde actua el aire. */
const AIR_BOTTOM_START = 0.2;
const AIR_BOTTOM_FULL = 0.7;
/**
 * El aire de la base se prolonga por el flanco izquierdo, que es el lado por el
 * que suben las bolas con el giro normal. Si la corriente corta en el fondo, al
 * salir de ahi la unica fuerza es el roce del muro y pierden el impulso enseguida.
 */
const AIR_LEFT_START = 0.3;
const AIR_LEFT_FULL = 0.7;
/** Altura a la que el flanco deja de soplar: no llega a la parte de arriba. */
const AIR_LEFT_TOP_START = 0.15;
const AIR_LEFT_TOP_FADE = 0.6;

/**
 * Sacudida manual (tecla R en reposo). No es una agitacion del bombo: es un
 * golpe puntual. Todas las bolas despiertan y reciben el impulso en la
 * direccion del golpe, y las que estan del lado del impacto reciben casi todo
 * porque son las que el muro empuja primero; las del lado opuesto apenas una
 * fraccion. El golpe es fuerte a proposito: se tiene que sentir contundente.
 */
export const SHAKE_IMPULSE = 950;
/** Fraccion del impulso que recibe una bola del lado opuesto al golpe. */
const SHAKE_FAR = 0.06;

/**
 * Reposo. Con warm starting el residuo de una pila asentada baja de decenas a
 * unos pocos px/s, asi que el umbral puede ser realista en vez de un parche.
 * La condicion `supported` es la que impide congelar una bola que cae lento: sin
 * apoyo no se duerme, por debajo del umbral o no.
 */
const SLEEP_SPEED = 20;
const SLEEP_SPIN = 0.7;
const SLEEP_DELAY = 0.5;

/** Velocidad relativa a la que un choque despierta a una bola dormida. */
const WAKE_SPEED = 35;

/**
 * Agitacion por encima de la cual nadie duerme. Durante el vaciado la agitacion
 * no es cero (da sacudida), y con un tope demasiado bajo las bolas quedarian
 * dormidas mientras el bombo aun sacude.
 */
const WAKE_AGITATION = 0.25;

/**
 * Una normal tiene que apuntar claramente hacia arriba para contar como apoyo.
 * Un roce casi lateral no sostiene contra la gravedad.
 */
const CONTACT_SUPPORT_EPS = 0.1;

export interface Ball {
  id: string;
  label: string;
  /** Version abreviada que entra en la bola segun su radio. Vacia si no entra. */
  displayLabel: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Velocidad angular (rad/s). */
  spin: number;
  /** Cuanto lleva quieta, en segundos de reloj. Llega a SLEEP_DELAY y se congela. */
  still: number;
  /** Algo la sostiene ahora mismo. Solo con apoyo una bola puede dormirse. */
  supported: boolean;
  /**
   * Retirada de la simulacion: no participa mas del solver ni de la rejilla.
   *
   * Se marca cuando la bola EMPIEZA a salir, no cuando termina: su lugar tiene
   * que quedar libre ya para que las demas se reacomoden mientras la animacion
   * la saca del bombo. El renderer la sigue dibujando con `ejectProgressOf`
   * hasta que el progreso llega a 1.
   */
  gone: boolean;
  /** Congelada de verdad: la integracion y el solver la saltean. */
  sleeping: boolean;
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

/**
 * Restriccion de contacto persistente entre frames. Es la pieza que permite el
 * warm starting: guarda los impulsos normal y tangencial acumulados del paso
 * anterior y los vuelve a aplicar al principio del siguiente. Sin esto, una pila
 * re-resuelve desde cero en cada frame y no alcanza a soportar su propio peso.
 */
interface Contact {
  a: number;
  b: number;
  wall: boolean;
  nx: number;
  ny: number;
  /** Brazo de palanca del punto de contacto respecto del centro de cada bola. */
  rax: number;
  ray: number;
  rbx: number;
  rby: number;
  /** Velocidad de la superficie del muro en el punto de contacto. */
  wx: number;
  wy: number;
  /** Impulsos acumulados (warm starting), normal y tangencial. */
  pn: number;
  pt: number;
  friction: number;
  /** Velocidad normal objetivo del contacto (restitucion; 0 en impactos lentos). */
  targetVn: number;
  /** Masas inversas y rigideces efectivas, recalculadas una vez por subpaso. */
  invMa: number;
  invMb: number;
  invIa: number;
  invIb: number;
  kn: number;
  kt: number;
  frame: number;
}

export interface World {
  cx: number;
  cy: number;
  R: number;
  balls: Ball[];
  /** Tope de bolas: la rejilla y los buffers se dimensionan con esto. */
  maxBalls: number;
  agitation: number;
  spinRate: number;
  spinPhase: number;
  grid: Grid;
  contacts: Map<number, Contact>;
  contactList: Contact[];
  pool: Contact[];
  frame: number;
  /** Masas inversas por indice de bola (0 = dormida o estatica). */
  invMass: Float64Array;
  invI: Float64Array;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
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

function makeContact(): Contact {
  return {
    a: 0,
    b: 0,
    wall: false,
    nx: 0,
    ny: 1,
    rax: 0,
    ray: 0,
    rbx: 0,
    rby: 0,
    wx: 0,
    wy: 0,
    pn: 0,
    pt: 0,
    friction: 0,
    targetVn: 0,
    invMa: 0,
    invMb: 0,
    invIa: 0,
    invIb: 0,
    kn: 0,
    kt: 0,
    frame: 0,
  };
}

export function createWorld(cx: number, cy: number, R: number, maxBalls = 200): World {
  const capacity = Math.max(1, maxBalls);
  return {
    cx,
    cy,
    R,
    balls: [],
    maxBalls,
    agitation: 0,
    spinRate: 4.6,
    spinPhase: 0,
    grid: makeGrid(R, capacity),
    contacts: new Map<number, Contact>(),
    contactList: [],
    pool: [],
    frame: 0,
    invMass: new Float64Array(capacity),
    invI: new Float64Array(capacity),
  };
}

function clearContacts(world: World): void {
  world.contacts.clear();
  world.pool.length = 0;
  world.contactList.length = 0;
}

/**
 * Reubica el bombo y reconstruye la rejilla, que depende del radio. El buffer de
 * items se dimensiona con maxBalls: si usara balls.length, un resize antes de
 * poblar dejaria casi todas las bolas fuera de la rejilla.
 */
export function resizeWorld(world: World, cx: number, cy: number, R: number): void {
  world.cx = cx;
  world.cy = cy;
  world.R = R;
  world.grid = makeGrid(R, Math.max(1, world.maxBalls));
  clearContacts(world);
}

/** Radio uniforme para que `count` bolas entren en el bombo sin saturarlo. */
export function ballRadiusFor(count: number, R: number): number {
  if (count <= 0) return MAX_BALL_R;
  return clamp(R * Math.sqrt(PACKING / count), MIN_BALL_R, MAX_BALL_R);
}

/** Reticula hexagonal dentro del circulo: densidad alta, sin posiciones repetidas. */
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
 * Cuanto mas chica la bola, mas corta la etiqueta. Con muchas participantes un
 * nombre completo no entra ni se lee en un stream, asi que caemos a iniciales;
 * si tampoco entra, la bola va sin texto.
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

function newBall(
  item: ParticipantItem,
  r: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  hue: number,
  spawnAt: number,
): Ball {
  return {
    id: item.id,
    label: item.label,
    displayLabel: displayLabelFor(item.label, r),
    x,
    y,
    vx,
    vy,
    spin: 0,
    still: 0,
    supported: false,
    gone: false,
    sleeping: false,
    r,
    hue,
    spawnAt,
  };
}

export function populate(world: World, items: readonly ParticipantItem[], rand: RandomSource): void {
  clearContacts(world);
  const n = items.length;
  if (n === 0) {
    world.balls = [];
    return;
  }

  // Si la reticula no alcanza para todos, achicamos las bolas en vez de reciclar
  // posiciones: dos bolas naciendo en el mismo punto producen un solapamiento que
  // el solver tarda segundos en digerir.
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
    balls[i] = newBall(
      items[i]!,
      r,
      clamp(spot.x + (rand() - 0.5) * jitter, world.cx - maxD, world.cx + maxD),
      clamp(spot.y + (rand() - 0.5) * jitter, world.cy - maxD, world.cy + maxD),
      (rand() - 0.5) * 240,
      120 + rand() * 260,
      (i * 137.508) % 360,
      0,
    );
  }

  world.balls = balls;
}

export const SPAWN_DURATION = 0.35;

/**
 * Inserta una bola suelta sin reconstruir el bombo ni tocar las demas. Se usa
 * cuando alguien se anota por chat mientras la tombola esta en reposo.
 *
 * El radio se recalcula segun cuantos hay para que el conjunto siga entrando; si
 * las bolas existentes tenian otro radio, se ajustan todas de golpe (solo pasa
 * mientras la tombola esta quieta, asi que no se nota).
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
  const changed = world.balls.length > 0 && Math.abs(world.balls[0]!.r - target) > 0.5;
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

  const ball = newBall(
    item,
    target,
    clamp(x, world.cx - maxD, world.cx + maxD),
    clamp(y, world.cy - maxD, world.cy + maxD),
    (rand() - 0.5) * 160,
    -120 - rand() * 180,
    (world.balls.length * 137.508) % 360,
    changed ? clock - SPAWN_DURATION : clock,
  );

  world.balls.push(ball);
  return world.balls.length - 1;
}

/** 0..1 de la animacion de entrada de la bola. 1 = ya aparecio. */
export function spawnProgressOf(ball: Ball, clock: number): number {
  const t = (clock - ball.spawnAt) / SPAWN_DURATION;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

// --- Rejilla espacial ------------------------------------------------------

function cellIndex(b: Ball, world: World, g: Grid): number {
  const rawX = ((b.x - world.cx + world.R) / g.cellSize) | 0;
  const rawY = ((b.y - world.cy + world.R) / g.cellSize) | 0;
  const x = rawX < 0 ? 0 : rawX >= g.cols ? g.cols - 1 : rawX;
  const y = rawY < 0 ? 0 : rawY >= g.cols ? g.cols - 1 : rawY;
  return y * g.cols + x;
}

function buildGrid(world: World): void {
  const g = world.grid;
  const cells = g.cols * g.cols;
  g.counts.fill(0);

  for (const b of world.balls) {
    if (b.gone) continue;
    g.counts[cellIndex(b, world, g)] += 1;
  }

  let sum = 0;
  for (let c = 0; c < cells; c++) {
    sum += g.counts[c]!;
    g.counts[c] = sum;
  }
  g.counts[cells] = sum;

  for (let i = world.balls.length - 1; i >= 0; i--) {
    const ball = world.balls[i]!;
    if (ball.gone) continue;
    const c = cellIndex(ball, world, g);
    g.counts[c]! -= 1;
    g.items[g.counts[c]!] = i;
  }
}

// Vecindario 3x3 completo. Con el tamano de celda (2 * MAX_BALL_R) alcanza para
// no perder ningun par que pueda tocarse. El filtro `j > i` resuelve cada par
// una sola vez.
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

// --- Contactos -------------------------------------------------------------

function contactFor(world: World, key: number): Contact {
  const existing = world.contacts.get(key);
  if (existing) {
    existing.frame = world.frame;
    return existing;
  }
  const c = world.pool.pop() ?? makeContact();
  c.frame = world.frame;
  c.pn = 0;
  c.pt = 0;
  world.contacts.set(key, c);
  return c;
}

/** Despierta a una bola dormida si el otro cuerpo la golpea de verdad. */
function maybeWake(a: Ball, b: Ball): void {
  if (a.sleeping === b.sleeping) return;
  const sleeper = a.sleeping ? a : b;
  const other = a.sleeping ? b : a;
  const rel = Math.hypot(other.vx - sleeper.vx, other.vy - sleeper.vy);
  if (rel > WAKE_SPEED) {
    sleeper.sleeping = false;
    sleeper.still = 0;
  }
}

/**
 * Reune los contactos del subpaso. La geometria se congela aca: el solver y el
 * warm starting corren sobre estos datos y recien despues se integran las
 * posiciones.
 */
function gatherContacts(world: World, omega: number): void {
  buildGrid(world);
  world.contactList.length = 0;

  const g = world.grid;
  const cols = g.cols;
  const balls = world.balls;
  const wallKeyBase = world.maxBalls * world.maxBalls;
  const ballKeyMul = world.maxBalls;

  for (let i = 0; i < balls.length; i++) {
    const a = balls[i]!;
    if (a.gone) continue;

    const rawX = ((a.x - world.cx + world.R) / g.cellSize) | 0;
    const rawY = ((a.y - world.cy + world.R) / g.cellSize) | 0;

    for (let n = 0; n < NEIGHBORS.length; n++) {
      const ox = NEIGHBORS[n]![0];
      const oy = NEIGHBORS[n]![1];
      const gx = rawX + ox;
      const gy = rawY + oy;
      if (gx < 0 || gy < 0 || gx >= cols || gy >= cols) continue;

      const cell = gy * cols + gx;
      const start = g.counts[cell]!;
      const end = g.counts[cell + 1]!;
      for (let k = start; k < end; k++) {
        const j = g.items[k]!;
        if (j <= i) continue;
        const b = balls[j]!;
        if (b.gone) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const rsum = a.r + b.r;
        const reach = rsum + CONTACT_MARGIN;
        const d2 = dx * dx + dy * dy;
        if (d2 > reach * reach) continue;

        let nx: number;
        let ny: number;
        let d: number;
        if (d2 < 1e-12) {
          nx = 1;
          ny = 0;
          d = 0;
        } else {
          d = Math.sqrt(d2);
          nx = dx / d;
          ny = dy / d;
        }

        maybeWake(a, b);

        const c = contactFor(world, i * ballKeyMul + j);
        c.wall = false;
        c.a = i;
        c.b = j;
        c.nx = nx;
        c.ny = ny;
        c.rax = nx * a.r;
        c.ray = ny * a.r;
        c.rbx = -nx * b.r;
        c.rby = -ny * b.r;
        c.wx = 0;
        c.wy = 0;
        c.friction = MU_BALL;
        c.targetVn = d - rsum;
        world.contactList.push(c);
      }
    }
  }

  // Muro: la normal apunta hacia el centro (hacia adentro). La bola esta afuera
  // de ese plano cuando d > R - r.
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i]!;
    if (b.gone) continue;

    const dx = b.x - world.cx;
    const dy = b.y - world.cy;
    const d = Math.hypot(dx, dy);
    const limit = world.R - b.r;
    if (d < limit - CONTACT_MARGIN) continue;

    let nx: number;
    let ny: number;
    if (d < 1e-9) {
      nx = 0;
      ny = -1;
    } else {
      nx = -dx / d;
      ny = -dy / d;
    }

    const c = contactFor(world, wallKeyBase + i);
    c.wall = true;
    c.a = -1;
    c.b = i;
    c.nx = nx;
    c.ny = ny;
    c.rax = 0;
    c.ray = 0;
    c.rbx = -nx * b.r;
    c.rby = -ny * b.r;

    // Velocidad de la superficie del muro en el punto de contacto: omega x r.
    const cpx = b.x + c.rbx;
    const cpy = b.y + c.rby;
    c.wx = -omega * (cpy - world.cy);
    c.wy = omega * (cpx - world.cx);
    c.friction = MU_WALL;
    c.targetVn = limit - d;

    world.contactList.push(c);
  }
}

/**
 * Precalcula masas inversas, rigideces efectivas y la velocidad normal objetivo
 * (restitucion) de cada contacto. Se hace una vez por subpaso: durante las
 * iteraciones del solver ninguna de esas cantidades cambia.
 */
function prepareStep(world: World): void {
  const balls = world.balls;
  const capacity = world.invMass.length;

  for (let i = 0; i < balls.length && i < capacity; i++) {
    const b = balls[i]!;
    if (b.gone || b.sleeping) {
      world.invMass[i] = 0;
      world.invI[i] = 0;
      continue;
    }
    const r2 = b.r * b.r;
    const invM = 1 / r2;
    world.invMass[i] = invM;
    // Disco solido: I = (1/2) m r^2 => invI = 2 / (m r^2).
    world.invI[i] = (2 * invM) / r2;
  }

  const list = world.contactList;
  for (let k = 0; k < list.length; k++) {
    const c = list[k]!;
    const invMb = world.invMass[c.b]!;
    const invIb = world.invI[c.b]!;
    const invMa = c.wall ? 0 : world.invMass[c.a]!;
    const invIa = c.wall ? 0 : world.invI[c.a]!;

    c.invMa = invMa;
    c.invMb = invMb;
    c.invIa = invIa;
    c.invIb = invIb;
    c.kn = invMa + invMb;
    c.kt =
      invMa +
      invMb +
      invIa * (c.rax * c.rax + c.ray * c.ray) +
      invIb * (c.rbx * c.rbx + c.rby * c.rby);

    // Un contacto con una bola dormida es estatico: no se hereda impulso,
    // porque al despertar la bola esos impulsos ya no corresponden a nada. El
    // muro no entra aca: es siempre estatico, pero su contacto SI acumula, que
    // es lo que sostiene la pila.
    if (invMb === 0 || (!c.wall && invMa === 0)) {
      c.pn = 0;
      c.pt = 0;
    }

    const impact = contactApproach(c, balls);
    const e = c.wall ? WALL_RESTITUTION : BALL_RESTITUTION;
    let restBias = 0;
    if (impact > 0) {
      restBias =
        impact >= REST_VELOCITY ? e * impact : (e * impact * impact) / REST_VELOCITY;
    }
    c.targetVn = restBias;
  }
}

/** Velocidad normal de aproximacion (positiva = se acercan). */
function contactApproach(c: Contact, balls: Ball[]): number {
  const B = balls[c.b]!;
  const bvx = B.vx - B.spin * c.rby;
  const bvy = B.vy + B.spin * c.rbx;
  let avx = 0;
  let avy = 0;
  if (!c.wall && c.invMa > 0) {
    const A = balls[c.a]!;
    avx = A.vx - A.spin * c.ray;
    avy = A.vy + A.spin * c.rax;
  }
  const wallVx = c.wall ? c.wx : 0;
  const wallVy = c.wall ? c.wy : 0;
  const rvx = bvx - avx - wallVx;
  const rvy = bvy - avy - wallVy;
  return -(rvx * c.nx + rvy * c.ny);
}

/**
 * Warm starting: vuelve a aplicar los impulsos acumulados del paso anterior,
 * repartidos entre los dos cuerpos. Es lo que hace que una pila de 200 bolas
 * herede el apoyo en vez de re-converger desde cero en cada frame.
 */
function warmStart(world: World): void {
  const balls = world.balls;
  const list = world.contactList;
  for (let k = 0; k < list.length; k++) {
    const c = list[k]!;
    if (c.pn === 0 && c.pt === 0) continue;
    if (c.invMa + c.invMb === 0) continue;

    const tx = -c.ny;
    const ty = c.nx;
    const px = c.pn * c.nx + c.pt * tx;
    const py = c.pn * c.ny + c.pt * ty;
    applyPair(c, balls, px, py);
  }
}

function applyPair(c: Contact, balls: Ball[], px: number, py: number): void {
  const B = balls[c.b]!;
  B.vx += px * c.invMb;
  B.vy += py * c.invMb;
  B.spin += c.invIb * (c.rbx * py - c.rby * px);

  if (c.invMa > 0) {
    const A = balls[c.a]!;
    A.vx -= px * c.invMa;
    A.vy -= py * c.invMa;
    A.spin += c.invIa * (c.rax * -py - c.ray * -px);
  }
}

function solveAll(world: World): void {
  const balls = world.balls;
  const list = world.contactList;

  for (let k = 0; k < list.length; k++) {
    const c = list[k]!;
    if (c.kn <= 0) continue;

    const B = balls[c.b]!;

    // --- Normal ---
    let bvx = B.vx - B.spin * c.rby;
    let bvy = B.vy + B.spin * c.rbx;
    let avx = 0;
    let avy = 0;
    if (c.invMa > 0) {
      const A = balls[c.a]!;
      avx = A.vx - A.spin * c.ray;
      avy = A.vy + A.spin * c.rax;
    }
    const wvx = c.wall ? c.wx : 0;
    const wvy = c.wall ? c.wy : 0;
    let rvx = bvx - avx - wvx;
    let rvy = bvy - avy - wvy;
    const vn = rvx * c.nx + rvy * c.ny;

    let dPn = (c.targetVn - vn) / c.kn;
    let newPn = c.pn + dPn;
    if (newPn < 0) newPn = 0;
    dPn = newPn - c.pn;
    c.pn = newPn;
    if (dPn !== 0) applyPair(c, balls, dPn * c.nx, dPn * c.ny);

    // --- Tangencial (friccion de Coulomb) ---
    if (c.kt <= 0 || c.pn <= 0) continue;

    bvx = B.vx - B.spin * c.rby;
    bvy = B.vy + B.spin * c.rbx;
    avx = 0;
    avy = 0;
    if (c.invMa > 0) {
      const A = balls[c.a]!;
      avx = A.vx - A.spin * c.ray;
      avy = A.vy + A.spin * c.rax;
    }
    rvx = bvx - avx - wvx;
    rvy = bvy - avy - wvy;
    const tx = -c.ny;
    const ty = c.nx;
    const vt = rvx * tx + rvy * ty;

    let dPt = -vt / c.kt;
    const maxPt = c.friction * c.pn;
    let newPt = c.pt + dPt;
    if (newPt > maxPt) newPt = maxPt;
    else if (newPt < -maxPt) newPt = -maxPt;
    dPt = newPt - c.pt;
    c.pt = newPt;
    if (dPt !== 0) applyPair(c, balls, dPt * tx, dPt * ty);
  }
}

function integratePositions(world: World, h: number): void {
  const { balls, cx, cy, R } = world;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i]!;
    if (b.gone || b.sleeping) continue;

    b.x += b.vx * h;
    b.y += b.vy * h;

    // Red de seguridad: el solver ya empuja hacia adentro, pero una posicion
    // fuera del bombo en un frame no puede llegar nunca al render.
    const dx = b.x - cx;
    const dy = b.y - cy;
    const d = Math.hypot(dx, dy);
    const limit = R - b.r;
    if (d > limit && d > 1e-6) {
      b.x = cx + (dx / d) * limit;
      b.y = cy + (dy / d) * limit;
    }
  }
}

/**
 * Resuelve la penetracion moviendo posiciones. Corre despues de integrar y no
 * toca velocidades, asi que no puede inyectar energia. Con warm starting la
 * penetracion de una pila es chica y esta pasada casi no hace nada: ese es el
 * objetivo, no es un parche de ultima instancia.
 */
function correctPositions(world: World): void {
  const balls = world.balls;
  const { cx, cy, R } = world;
  const list = world.contactList;

  for (let iter = 0; iter < POSITION_ITERATIONS; iter++) {
    for (let k = 0; k < list.length; k++) {
      const c = list[k]!;

      if (c.wall) {
        const b = balls[c.b]!;
        if (b.sleeping) continue;
        const dx = b.x - cx;
        const dy = b.y - cy;
        const d = Math.hypot(dx, dy);
        const limit = R - b.r;
        const pen = d - limit;
        if (pen > SLOP && d > 1e-6) {
          const push = POSITION_CORRECTION * (pen - SLOP);
          b.x -= (dx / d) * push;
          b.y -= (dy / d) * push;
        }
        continue;
      }

      const a = balls[c.a]!;
      const b = balls[c.b]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const rsum = a.r + b.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rsum * rsum) continue;

      const d = Math.sqrt(d2) || 0.0001;
      const pen = rsum - d;
      if (pen <= SLOP) continue;

      const nx = d2 < 1e-12 ? 1 : dx / d;
      const ny = d2 < 1e-12 ? 0 : dy / d;
      // Peso por masa inversa: una bola dormida no se mueve, la otra absorbe
      // toda la correccion.
      const ia = a.sleeping ? 0 : 1 / (a.r * a.r);
      const ib = b.sleeping ? 0 : 1 / (b.r * b.r);
      const total = ia + ib;
      if (total <= 0) continue;
      const push = POSITION_CORRECTION * (pen - SLOP);
      a.x -= nx * push * (ib / total);
      a.y -= ny * push * (ib / total);
      b.x += nx * push * (ia / total);
      b.y += ny * push * (ia / total);
    }
  }

  // La correccion entre bolas puede empujar alguna contra el muro: un ajuste
  // final garantiza que ninguna quede fuera.
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i]!;
    if (b.gone || b.sleeping) continue;
    const dx = b.x - cx;
    const dy = b.y - cy;
    const d = Math.hypot(dx, dy);
    const limit = R - b.r;
    if (d > limit && d > 1e-6) {
      b.x = cx + (dx / d) * limit;
      b.y = cy + (dy / d) * limit;
    }
  }
}

/**
 * Marca que bolas estan sostenidas. La geometria del contacto alcanza: una
 * normal que apunta hacia arriba significa que el otro cuerpo la empuja contra
 * la gravedad. No se exige impulso: un contacto con una bola dormida no acumula
 * (es estatico), y sin apoyo esa bola de arriba no dormiria nunca. Una bola que
 * cae rapido tambien puede rozar y quedar marcada, pero no duerme porque su
 * velocidad supera el umbral.
 */
function markSupported(world: World): void {
  const list = world.contactList;
  const balls = world.balls;
  for (let k = 0; k < list.length; k++) {
    const c = list[k]!;
    if (c.wall) {
      if (c.ny < -CONTACT_SUPPORT_EPS) balls[c.b]!.supported = true;
    } else {
      if (c.ny > CONTACT_SUPPORT_EPS) balls[c.a]!.supported = true;
      if (c.ny < -CONTACT_SUPPORT_EPS) balls[c.b]!.supported = true;
    }
  }
}

/** Descarta los contactos que no reaparecieron en este subpaso y los recicla. */
function cleanupContacts(world: World): void {
  const frame = world.frame;
  for (const [key, c] of world.contacts) {
    if (c.frame === frame) continue;
    world.contacts.delete(key);
    if (world.pool.length < world.maxBalls * 4) world.pool.push(c);
  }
}

// --- Integracion temporal --------------------------------------------------

function applyForces(world: World, h: number): void {
  const dragK = Math.max(0, 1 - DRAG * h);
  const spinDragK = Math.max(0, 1 - SPIN_DRAG * h);
  const flowOmega = world.spinRate * world.agitation * AIR_COUPLING;
  const flowK = flowOmega !== 0 ? 1 - Math.exp(-AIR_RATE * h) : 0;
  const spinK = flowOmega !== 0 ? 1 - Math.exp(-AIR_SPIN_RATE * h) : 0;

  const { balls, cx, cy } = world;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i]!;
    if (b.gone || b.sleeping) continue;

    b.vy += GRAVITY * h;
    b.vx *= dragK;
    b.vy *= dragK;
    b.spin *= spinDragK;

    // Aire arrastrado por el tambor. La corriente principal esta en la base y
    // se prolonga por el flanco izquierdo (el lado ascendente) para que las
    // bolas no pierdan el impulso al salir del fondo. En la base solo empuja en
    // horizontal: sin componente vertical no puede sostener una bola en el aire.
    // En el flanco izquierdo si se usa la tangente completa, que ahi apunta
    // hacia arriba, y se apaga antes de llegar a la parte de arriba.
    if (flowK > 0) {
      const dx = b.x - cx;
      const dy = b.y - cy;
      const bottom = smoothstep(AIR_BOTTOM_START * world.R, AIR_BOTTOM_FULL * world.R, dy);
      const left =
        smoothstep(AIR_LEFT_START * world.R, AIR_LEFT_FULL * world.R, -dx) *
        smoothstep(-AIR_LEFT_TOP_FADE * world.R, -AIR_LEFT_TOP_START * world.R, dy);
      const coupling = Math.max(bottom, left);
      if (coupling > 0) {
        const targetVx = -flowOmega * dy;
        const targetVy = flowOmega * dx * left;
        b.vx += (targetVx - b.vx) * flowK * coupling;
        b.vy += (targetVy - b.vy) * flowK * coupling;
        b.spin += (flowOmega - b.spin) * spinK * coupling;
      }
    }

    const speed = Math.hypot(b.vx, b.vy);
    if (speed > MAX_SPEED) {
      const k = MAX_SPEED / speed;
      b.vx *= k;
      b.vy *= k;
    }
  }
}

function step(world: World, h: number, omega: number): void {
  applyForces(world, h);
  world.frame++;
  gatherContacts(world, omega);
  prepareStep(world);
  warmStart(world);
  for (let s = 0; s < SOLVER_ITERATIONS; s++) solveAll(world);
  integratePositions(world, h);
  correctPositions(world);
  markSupported(world);
  cleanupContacts(world);
}

export function advanceWorld(world: World, dt: number, _rand: RandomSource): void {
  if (!(dt > 0)) return;

  world.spinPhase += world.spinRate * world.agitation * dt;
  const omega = world.spinRate * world.agitation;
  const spinning = world.agitation > WAKE_AGITATION;
  const balls = world.balls;

  for (let i = 0; i < balls.length; i++) {
    const b = balls[i]!;
    if (b.gone) continue;
    b.supported = false;
    // Mientras el bombo gira de verdad, nada duerme: la agitacion despierta.
    if (spinning && b.sleeping) {
      b.sleeping = false;
      b.still = 0;
    }
  }

  let remaining = Math.min(dt, MAX_FRAME_DT);
  while (remaining > 1e-9) {
    const h = Math.min(FIXED_DT, remaining);
    step(world, h, omega);
    remaining -= h;
  }

  if (spinning) return;

  // Reposo. Solo duerme lo que esta apoyado y por debajo del umbral; el flag
  // `supported` es lo que evita congelar una bola que cae lento.
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i]!;
    if (b.gone) continue;
    const speed2 = b.vx * b.vx + b.vy * b.vy;
    if (!b.supported || speed2 > SLEEP_SPEED * SLEEP_SPEED || Math.abs(b.spin) > SLEEP_SPIN) {
      b.still = 0;
      b.sleeping = false;
      continue;
    }
    b.still += dt;
    if (b.still >= SLEEP_DELAY) {
      b.vx = 0;
      b.vy = 0;
      b.spin = 0;
      b.sleeping = true;
    }
  }
}

/**
 * Golpe manual al bombo: empuja todas las bolas en la direccion dada y las
 * despierta. La direccion apunta desde el punto del golpe hacia el centro, asi
 * que las bolas del lado golpeado son las que salen despedidas. Las del lado
 * opuesto reciben una fraccion (SHAKE_FAR) para que el conjunto se sienta como
 * un golpe, no como un teletransporte.
 */
export function shakeWorld(world: World, dirX: number, dirY: number, strength: number): void {
  const len = Math.hypot(dirX, dirY);
  if (len < 1e-6 || !(strength > 0)) return;

  const nx = dirX / len;
  const ny = dirY / len;

  for (let i = 0; i < world.balls.length; i++) {
    const b = world.balls[i]!;
    if (b.gone) continue;

    b.sleeping = false;
    b.still = 0;

    const ox = b.x - world.cx;
    const oy = b.y - world.cy;
    const rl = Math.hypot(ox, oy) || 1;
    // +1 si la bola esta del lado hacia donde empuja; -1 si esta del golpe.
    const facing = (ox * nx + oy * ny) / rl;
    // Al cuadrado para concentrar la energia en el punto del golpe.
    const near = (1 - facing) * 0.5;
    const kick = strength * (SHAKE_FAR + (1 - SHAKE_FAR) * near * near);

    b.vx += nx * kick;
    b.vy += ny * kick;
  }
}

/**
 * Util para tests: separa posicionalmente bolas solapadas y las mete dentro del
 * bombo, sin tocar velocidades. Resuelve solapamientos profundos sin inyectar
 * energia (no hay cambio de velocidad).
 */
export function resolveCollisionsNow(world: World): void {
  const balls = world.balls;
  for (let iter = 0; iter < SOLVER_ITERATIONS; iter++) {
    buildGrid(world);
    const g = world.grid;
    const cols = g.cols;

    for (let i = 0; i < balls.length; i++) {
      const a = balls[i]!;
      if (a.gone) continue;
      const rawX = ((a.x - world.cx + world.R) / g.cellSize) | 0;
      const rawY = ((a.y - world.cy + world.R) / g.cellSize) | 0;

      for (let n = 0; n < NEIGHBORS.length; n++) {
        const gx = rawX + NEIGHBORS[n]![0];
        const gy = rawY + NEIGHBORS[n]![1];
        if (gx < 0 || gy < 0 || gx >= cols || gy >= cols) continue;
        const cell = gy * cols + gx;
        for (let k = g.counts[cell]!; k < g.counts[cell + 1]!; k++) {
          const j = g.items[k]!;
          if (j <= i) continue;
          const b = balls[j]!;
          if (b.gone) continue;

          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const rsum = a.r + b.r;
          const d2 = dx * dx + dy * dy;
          if (d2 >= rsum * rsum) continue;

          const d = Math.sqrt(d2) || 0.0001;
          const nx = d2 < 1e-12 ? 1 : dx / d;
          const ny = d2 < 1e-12 ? 0 : dy / d;
          const overlap = rsum - d;
          const ma = a.r * a.r;
          const mb = b.r * b.r;
          const total = ma + mb;
          a.x -= nx * overlap * (mb / total);
          a.y -= ny * overlap * (mb / total);
          b.x += nx * overlap * (ma / total);
          b.y += ny * overlap * (ma / total);
        }
      }
    }

    for (const b of balls) {
      if (b.gone) continue;
      const dx = b.x - world.cx;
      const dy = b.y - world.cy;
      const d = Math.hypot(dx, dy);
      const limit = world.R - b.r;
      if (d > limit && d > 1e-6) {
        b.x = world.cx + (dx / d) * limit;
        b.y = world.cy + (dy / d) * limit;
      }
    }
  }
}

export function kineticEnergy(world: World): number {
  let total = 0;
  for (const b of world.balls) {
    if (b.gone) continue;
    const m = b.r * b.r;
    // Traslacional + rotacional (0.5 * I * w^2 con I = (1/2) m r^2).
    total += 0.5 * m * (b.vx * b.vx + b.vy * b.vy) + 0.25 * m * b.r * b.r * b.spin * b.spin;
  }
  return total;
}
