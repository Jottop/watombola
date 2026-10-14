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

/**
 * Iteraciones del solver por subpaso. A 200 bolas y 1/120 son 12 pasadas por
 * frame y eso se nota: subir de 6 a 8 multiplica el costo por casi un tercio.
 *
 * El limite real es que un solver de impulsos secuenciales SIN warm starting no
 * puede absorber el peso de una pila de 200 bolas: se queda vibrando con ~97
 * px/s de residuo. Medido: con la correccion posicional desactivada el residuo
 * cae a 0.7 px/s, asi que toda esa energia viene de ahi.
 *
 * Las 6 iteraciones son el punto donde el solapamiento visible deja de mejorar:
 * con 200 bolas baja a ~25% del radio, contra ~48% con 3.
 */
const SOLVER_ITERATIONS = 6;

/**
 * Solapamiento tolerado antes de corregir la posicion.
 *
 * Subirlo (se probo con 1.5px) reduce el jitter pero deja las bolasVisiblemente
 * traspasadas: 56% del radio con 200 bolas, contra 25% con 0.05px. El jitter
 * residual es preferible a que se vea como se cruzan.
 */
const CONTACT_SLOP = 0.05;
const CORRECTION = 0.8;

/**
 * Modelo de bola solida: la masa es proporcional al area y el momento de
 * inercia I = (2/5) m r^2 = (2/5) r^4.
 *
 * La velocidad del punto de contacto de una bola es `v + spin * r * t`. Cuando
 * un impulso jt se aplica en el contacto, `v` cambia en `jt/m` y `spin` en
 * `5 jt / (2 r^3)`, asi que el contacto cambia en `(7/2) jt / r^2`. De ahi sale
 * el 2/7 que usa `wallFriction`: el impulso exacto que mata el deslizamiento.
 */
const SPIN_TO_SLIP = 7 / 2;

/**
 * Respuesta angular de un impulso tangencial. Con I = (2/5) m r^2, un impulso
 * `jt` en el contacto produce `spin += SPIN_FROM_TANGENTIAL * jt / (m * r)`.
 */
const SPIN_FROM_TANGENTIAL = 2.5;

/** Aplica un impulso tangencial `jt` sobre la tangente `t` en el punto de contacto. */
function applyTangential(b: Ball, tx: number, ty: number, jt: number): void {
  const m = b.r * b.r;
  b.vx += (jt / m) * tx;
  b.vy += (jt / m) * ty;
  b.spin += (SPIN_FROM_TANGENTIAL * jt) / (m * b.r);
}

/**
 * Restitucion por debajo de REST_VELOCITY.
 *
 * Sin esto una pila asentada se autoalimenta: la correccion posicional separa
 * dos bolas, la gravedad las vuelve a acercar, el choque las separa otra vez, y
 * el conjunto queda vibrando para siempre con velocidades de 50 px/s que nunca
 * bajan de SLEEP_SPEED.
 *
 * La caida es lineal, no un corte: un corte duro deja un escalon que el solver
 * sigue empujando. Con esta curva el restitucion tiende a 0 en el impacto mas
 * leve, que es justo donde tiene que estar.
 */
const REST_VELOCITY = 120;

function restitutionFor(impact: number, e: number): number {
  if (impact >= REST_VELOCITY) return e;
  if (impact <= 0) return 0;
  return e * (impact / REST_VELOCITY);
}

/** Rozamiento de rodadura: frena siempre en contra del movimiento. */
const ROLLING_RESISTANCE = 0.55;

/** Friccion de Coulomb en los contactos, bola-muro y bola-bola. */
const MU_WALL = 0.5;
const MU_BALL = 0.22;

/**
 * Cuanto del giro del tambor se traslada a las bolas. 1 seria arrastre
 * perfecto; menos de 1 porque el muro es liso y las bolas tambien patinan.
 */
const DRUM_COUPLE = 0.7;

/**
 * Umbral de reposo. El valor alto (90 px/s) parece un error y NO LO ES.
 *
 * El residuo de una pila asentada anda en ~40-100 px/s: es el jitter del solver,
 * no movimiento real. Con un umbral "razonable" de 7 px/s ninguna bola llega
 * nunca a dormir y el bombo queda con shimmer eterno. Con 90, la pila se
 * congela.
 *
 * Lo que hace seguro ese umbral tan alto es `supported`: una bola solo duerme
 * si algo la esta sosteniendo con un impulso capaz de cancelar su peso. Una
 * bola que cae lento va por debajo del umbral igual que una asentada, pero no
 * recibe impulsos de apoyo, asi que nunca se congela en el aire.
 */
const SLEEP_SPEED = 90;
const SLEEP_SPIN = 0.6;
const SLEEP_DELAY = 0.22;

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
  /** Velocidad angular (rad/s) en el sentido antihorario. */
  spin: number;
  /** Cuanto lleva quieta, en segundos de reloj. Llega a SLEEP_DELAY y se congela. */
  still: number;
  /**
   * Algo la esta sosteniendo ahora mismo: un impulso normal al menos capaz de
   * cancelar su peso en un subpaso. Lo recalcula el solver en cada paso.
   *
   * Sin esto no hay forma de distinguir "una bola que ya se asento" de "una
   * bola que cae muy lento": las dos estan por debajo de SLEEP_SPEED, pero
   * dormir la segunda la dejaria flotando en el aire del bombo.
   */
  supported: boolean;
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
      spin: 0,
      still: 0,
      supported: false,
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
    spin: 0,
    still: 0,
    supported: false,
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

/**
 * Sacudida residual.
 *
 * Antes esto era TODO el movimiento del bombo: impulsos aleatorios en cada
 * direccion, que se ven como un temblor sin causa. Ahora el giro lo produce la
 * friccion contra el muro (`wallFriction`) y el arrastre de la gravedad; lo que
 * queda aca es solo ruido pequeno, para desempatar bolas que quedaron
 * trabadas en una posicion simetrica.
 */
function shake(world: World, rand: RandomSource): void {
  const power = SHAKE_STRENGTH * world.agitation;
  for (const b of world.balls) {
    const angle = rand() * TAU;
    const mag = power * (0.4 + rand() * 0.9) * 0.22;
    b.vx += Math.cos(angle) * mag;
    b.vy += Math.sin(angle) * mag;
    b.still = 0;
  }
}

function integrate(world: World, dt: number): void {
  const dragK = Math.max(0, 1 - DRAG * dt);

  for (const b of world.balls) {
    b.vy += GRAVITY * dt;
    b.vx *= dragK;
    b.vy *= dragK;
    // El giro se frena un poco mas fuerte que el translational: una bola que
    // rueda sin rodar se nota.
    b.spin *= Math.max(0, 1 - DRAG * 1.6 * dt);

    const speed = Math.hypot(b.vx, b.vy);
    if (speed > MAX_SPEED) {
      const k = MAX_SPEED / speed;
      b.vx *= k;
      b.vy *= k;
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Rozamiento de rodadura: oppone la velocidad del punto de contacto y
    // topa el impulso para no pasarse de signo (si no, una bola lenta
    // oscilaria en vez de frenar).
    const contactSpeed = Math.hypot(b.vx, b.vy) + Math.abs(b.spin) * b.r;
    if (contactSpeed > 1e-6) {
      const decel = ROLLING_RESISTANCE * GRAVITY * dt;
      const k = Math.max(0, 1 - decel / contactSpeed);
      b.vx *= k;
      b.vy *= k;
      b.spin *= k;
    }
  }
}

/**
 * El bombo girando arrastra a las bolas por friccion contra el muro.
 *
 * La velocidad del punto de contacto de la bola es `v + spin*r*t`; la del muro
 * es `omega*R*t`. La diferencia es el deslizamiento. Aplicamos el impulso que
 * lo anula, topeado por Coulomb para que la bola no se quede pegada al muro:
 * si el tope entra, la bola patina, que es lo que hace de verdad.
 *
 * `omega` es la velocidad angular real del tambor. Si el arrastre fuera perfecto
 * las bolas pegarian al muro y la centrifuga las manteria arriba, que no es lo
 * que hace una tombola real: aqui manda la gravedad y las bolas caen en cascada.
 */
function wallFriction(b: Ball, tx: number, ty: number, omega: number, R: number): void {
  const m = b.r * b.r;
  const slip = b.vx * tx + b.vy * ty + b.spin * b.r - omega * R;

  let jt = -(m * slip) / SPIN_TO_SLIP;

  // Carga normal aproximada: la componente de gravedad que el muro sostiene,
  // con un piso para que siempre haya algo de agarre en el tope.
  const cap = MU_WALL * m * GRAVITY * 0.35;
  if (jt > cap) jt = cap;
  else if (jt < -cap) jt = -cap;

  applyTangential(b, tx, ty, jt);
}

/**
 * Mantiene cada bola dentro del tambor. Se aplica DESPUES de resolver
 * colisiones, porque separar bolas puede empujarlas contra el muro.
 */
function constrainToWalls(world: World, omega: number): void {
  const { balls, cx, cy, R } = world;

  for (const b of balls) {
    const dx = b.x - cx;
    const dy = b.y - cy;
    const d = Math.hypot(dx, dy);
    const limit = R - b.r;
    if (d < 1e-6) continue;

    const nx = dx / d;
    const ny = dy / d;

    // Hay contacto un poco antes de cruzar el muro. Sin esta tolerancia, una
    // bola posada justo en el limite no registra apoyo nunca: el solver la
    // devuelve exactamente a `limit` cada vez, asi que en el paso siguiente
    // todavia no hay nada que resolver y `supported` queda siempre en false.
    const resting = d > limit - CONTACT_SLOP;
    if (!resting) continue;

    if (d > limit) {
      b.x = cx + nx * limit;
      b.y = cy + ny * limit;
    }

    const vn = b.vx * nx + b.vy * ny;
    if (vn > 0) {
      const bounce = restitutionFor(vn, WALL_RESTITUTION);
      // El impulso normal que acaba de recibir es vn*(1+bounce)*m. Si alcanza
      // a sostener el peso de la bola en un subpaso, algo la esta apuntalando.
      if (vn * b.r * b.r >= 0.5 * b.r * b.r * GRAVITY * FIXED_DT) b.supported = true;
      if (d > limit) {
        b.vx -= vn * (1 + bounce) * nx;
        b.vy -= vn * (1 + bounce) * ny;
      }
    } else if (Math.abs(vn) < SLEEP_SPEED) {
      // Apoyada y quieta contra el muro: el contacto la sostiene.
      b.supported = true;
    }

    const tx = -ny;
    const ty = nx;

    // Primero el arrastre del giro, que es lo que hace girar el bombo. El
    // rozamiento puro despues, para las bolas que no estan tocandolo.
    wallFriction(b, tx, ty, omega * DRUM_COUPLE, R);

    if (Math.abs(omega) < 1e-6) {
      // Tambor quieto: rozamiento de Coulomb plano contra el muro.
      const vt = b.vx * tx + b.vy * ty;
      applyTangential(b, tx, ty, -vt * TANGENTIAL_FRICTION * b.r * b.r);
    }
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

  // Choque flojo: el restitucion cae a cero solo, y el tope se alcanza solo con
  // impactos de verdad.
  const bounce = restitutionFor(-vn, BALL_RESTITUTION);
  const impulse = (-(1 + bounce) * vn) / (1 / ma + 1 / mb);

  // El impulso se reparte por la masa efectiva: el que recibe >= la mitad del
  // suyo tiene con que sostenerse, y puede dormir.
  if (impulse * (ma / total) >= 0.5 * ma * GRAVITY * FIXED_DT) a.supported = true;
  if (impulse * (mb / total) >= 0.5 * mb * GRAVITY * FIXED_DT) b.supported = true;

  a.vx -= (nx * impulse) / ma;
  a.vy -= (ny * impulse) / ma;
  b.vx += (nx * impulse) / mb;
  b.vy += (ny * impulse) / mb;

  // Friccion tangencial entre las dos esferas: el punto de contacto de cada una
  // lleva su rotacion, y sin esto el giro de una bola nunca le llega a la
  // otra, asi que se deslizan unas sobre otras sin rodar.
  const tx = -ny;
  const ty = nx;
  // Deslizamiento del contacto de a respecto del contacto de b, en +t.
  const slip = -(rvx * tx + rvy * ty) + a.spin * a.r + b.spin * b.r;

  // Un impulso jt sobre b en +t (y el opuesto sobre a) cambia el deslizamiento
  // en -jt * SPIN_TO_SLIP * (1/ma + 1/mb). De ahi el divisor.
  let jt = slip / (SPIN_TO_SLIP * (1 / ma + 1 / mb));

  // Tope de Coulomb: la friccion tangencial no puede pasar la normal.
  const cap = MU_BALL * impulse;
  if (jt > cap) jt = cap;
  else if (jt < -cap) jt = -cap;

  // Par de reaccion: mismo escalar, sentidos opuestos. Aplicar el mismo signo a
  // las dos las empuja en la misma direccion e inyecta momento de la nada.
  b.vx += (jt / mb) * tx;
  b.vy += (jt / mb) * ty;
  a.vx -= (jt / ma) * tx;
  a.vy -= (jt / ma) * ty;
  // El torque de los dos sale del mismo signo: el contacto esta a +n en a y a
  // -n en b, y las dos fuerzas son opuestas.
  b.spin -= (SPIN_FROM_TANGENTIAL * jt) / (mb * b.r);
  a.spin -= (SPIN_FROM_TANGENTIAL * jt) / (ma * a.r);
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
  const omega = world.spinRate * world.agitation;

  if (world.agitation > 0.001) {
    world.shakeTimer -= dt;
    while (world.shakeTimer <= 0) {
      world.shakeTimer += SHAKE_INTERVAL;
      shake(world, rand);
    }
  } else {
    world.shakeTimer = SHAKE_INTERVAL;
  }

  // El solver recalcula `supported` desde cero en cada paso; el frame arranca
  // limpiandolo para que no contamine lo que quedo del anterior.
  for (const b of world.balls) b.supported = false;

  let remaining = Math.min(dt, 0.25);
  while (remaining > 0) {
    const h = Math.min(FIXED_DT, remaining);
    integrate(world, h);
    for (let s = 0; s < SOLVER_ITERATIONS; s++) {
      resolveCollisions(world);
      constrainToWalls(world, omega);
    }
    remaining -= h;
  }

  if (world.agitation > 0.001) {
    // Mientras el bombo gira nada duerme: la agitacion es la que despierta.
    for (const b of world.balls) b.still = 0;
    return;
  }

  // Reposo. Sin esto la pila del fondo queda vibrando eternamente: el solver
  // corrige posiciones, el choque devuelve velocidad, y nunca converge.
  //
  // La condicion de apoyo es lo que hace que esto sea seguro. Una bola que cae
  // lento va por debajo de SLEEP_SPEED igual que una asentada, asi que sin el
  // flag `supported` se congelaria a media caida y quedaria flotando.
  for (const b of world.balls) {
    if (
      !b.supported ||
      b.vx * b.vx + b.vy * b.vy > SLEEP_SPEED * SLEEP_SPEED ||
      Math.abs(b.spin) > SLEEP_SPIN
    ) {
      b.still = 0;
      continue;
    }
    b.still += dt;
    if (b.still >= SLEEP_DELAY) {
      b.vx = 0;
      b.vy = 0;
      b.spin = 0;
    }
  }
}

/** Util para tests: separa dos bolas que se hayan solapado. */
export function resolveCollisionsNow(world: World): void {
  for (let s = 0; s < SOLVER_ITERATIONS; s++) {
    resolveCollisions(world);
    constrainToWalls(world, 0);
  }
}

export function kineticEnergy(world: World): number {
  let total = 0;
  for (const b of world.balls) {
    const m = b.r * b.r;
    // Traslacional + rotacional (0.5 * I * w^2 con I = (2/5) m r^2).
    total += 0.5 * m * (b.vx * b.vx + b.vy * b.vy) + 0.2 * m * b.r * b.r * b.spin * b.spin;
  }
  return total;
}
