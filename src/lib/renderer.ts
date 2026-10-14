import { ejectProgressOf, type DrumState } from './drum-machine';
import { spawnProgressOf } from './physics';

const TAU = Math.PI * 2;
const FONT_STACK = "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";

/**
 * Colores.
 *
 * Las bolas iban con el angulo aureo a plena saturacion: 57 globos neon en
 * pantalla se leen como un juguete de feria. Ahora la paleta es de baja
 * saturacion para que el bombo se vea sobrio, y el unico color fuerte de la
 * pantalla es el ganador. Ese contraste es lo que hace legible el reveal.
 */
const BALL_SAT = 44;
const BALL_LIGHT = 60;
const BALL_RIM_SAT = 38;
const BALL_RIM_LIGHT = 33;

const WINNER_HUE = 43;
const WINNER_SAT = 84;
const WINNER_LIGHT = 61;
const WINNER_RIM_SAT = 70;
const WINNER_RIM_LIGHT = 30;

/**
 * Radio minimo para estampar un nombre dentro de una bola. Por debajo el texto
 * es ilegible en un stream y solo mete ruido.
 *
 * El ancho real de las bolas sale de `ballRadiusFor`: con el layout actual
 * (R ~335 en 1080p) da ~31px para 57 participantes y ~17px para 200. El
 * acortado de las etiquetas segun el radio lo resuelve `displayLabelFor`, asi que
 * este umbral solo tiene que cortar las bolas realmente diminutas.
 */
const MIN_LABEL_R = 14;

let shadeGrad: CanvasGradient | null = null;
let specGrad: CanvasGradient | null = null;
let rimLightGrad: CanvasGradient | null = null;

export interface RenderOptions {
  width: number;
  height: number;
  showLabels: boolean;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * `font` forma parte del drawing state del canvas: `ctx.restore()` lo revierte
 * al valor del `save()`. Por eso NO se puede memoizar el valor pedido entre
 * bolas, porque entre dos llamadas el restore ya lo deshizo y la asignacion se
 * salteoaria: el texto caeria al default de 10px. Se asigna siempre.
 */
function setFont(ctx: CanvasRenderingContext2D, weight: number, size: number): void {
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
}

/**
 * Los degradados viven en un circulo de radio 1 y se pintan con `ctx.scale(r, r)`.
 * Asi un solo juego sirve para todas las radios, y sobre todo para la del ganador,
 * que crece x2.5 durante el reveal: si se calcularan en el radio real de cada bola
 * habria que recrearlos en cada frame y el brillo se deformaria al agrandarse.
 *
 * Son aditivas de color (luz y sombra), no dependen del tono de la bola, asi que
 * se comparten entre todas.
 */
function ensureGradients(ctx: CanvasRenderingContext2D): void {
  if (shadeGrad && specGrad && rimLightGrad) return;

  shadeGrad = ctx.createLinearGradient(0, -1, 0, 1);
  shadeGrad.addColorStop(0, 'rgba(255,255,255,0.12)');
  shadeGrad.addColorStop(0.42, 'rgba(0,0,0,0)');
  shadeGrad.addColorStop(1, 'rgba(0,0,0,0.36)');

  specGrad = ctx.createRadialGradient(-0.34, -0.4, 0.02, 0, 0, 1.02);
  specGrad.addColorStop(0, 'rgba(255,255,255,0.55)');
  specGrad.addColorStop(0.4, 'rgba(255,255,255,0.1)');
  specGrad.addColorStop(1, 'rgba(255,255,255,0)');

  // Luz de borde en la mitad de abajo: separa la bola del fondo y simula que
  // el vidrio devuelve la luz de la escena.
  rimLightGrad = ctx.createRadialGradient(0, 0.2, 0.7, 0, 0, 1);
  rimLightGrad.addColorStop(0, 'rgba(255,255,255,0)');
  rimLightGrad.addColorStop(1, 'rgba(255,255,255,0.2)');
}

/**
 * El bombo: un globo de vidrio, no un disco de color plano. El brillo alto a la
 * izquierda y la luz de borde inferior son los que venden el volumen.
 */
function drawGlass(ctx: CanvasRenderingContext2D, state: DrumState): void {
  const { cx, cy, R, spinPhase } = state.world;

  const glow = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.2);
  glow.addColorStop(0, 'rgba(140,180,255,0.2)');
  glow.addColorStop(0.6, 'rgba(120,160,240,0.07)');
  glow.addColorStop(1, 'rgba(120,160,240,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.2, 0, TAU);
  ctx.fill();

  const inner = ctx.createRadialGradient(cx, cy - R * 0.34, R * 0.04, cx, cy, R);
  inner.addColorStop(0, 'rgba(190,214,255,0.1)');
  inner.addColorStop(0.65, 'rgba(96,132,220,0.045)');
  inner.addColorStop(1, 'rgba(72,104,190,0.03)');
  ctx.fillStyle = inner;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.clip();

  // Barras de alambre girando con el bombo: dan la sensacion de que el
  // interior se mueve, no solo las pelotas.
  ctx.lineWidth = Math.max(1, R * 0.008);
  for (let i = 0; i < 6; i++) {
    const a = spinPhase + (i / 6) * TAU;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R * 0.08, cy + Math.sin(a) * R * 0.08);
    ctx.lineTo(cx + Math.cos(a) * R * 0.99, cy + Math.sin(a) * R * 0.99);
    ctx.strokeStyle = 'rgba(214,230,255,0.05)';
    ctx.stroke();
  }

  const sheen = ctx.createRadialGradient(
    cx - R * 0.44,
    cy - R * 0.5,
    R * 0.02,
    cx - R * 0.44,
    cy - R * 0.5,
    R * 0.8,
  );
  sheen.addColorStop(0, 'rgba(255,255,255,0.14)');
  sheen.addColorStop(0.55, 'rgba(255,255,255,0.04)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  ctx.restore();

  // Borde: un trazo claro arriba y otro oscuro abajo, para que la circunferencia
  // tenga grosor optico en vez de verse como una linea de alambre.
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.strokeStyle = 'rgba(198,220,255,0.5)';
  ctx.lineWidth = Math.max(2, R * 0.014);
  ctx.stroke();

  const underEdge = ctx.createLinearGradient(0, cy - R, 0, cy + R);
  underEdge.addColorStop(0, 'rgba(255,255,255,0)');
  underEdge.addColorStop(0.5, 'rgba(255,255,255,0)');
  underEdge.addColorStop(1, 'rgba(8,14,34,0.55)');
  ctx.strokeStyle = underEdge;
  ctx.lineWidth = Math.max(1, R * 0.03);
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.997, 0, TAU);
  ctx.stroke();
}

/** Base y sombra en el piso: lo que hace que el bombo se apoye en algo. */
function drawPedestal(ctx: CanvasRenderingContext2D, state: DrumState): void {
  const { cx, cy, R } = state.world;
  const baseY = cy + R;

  const shadow = ctx.createRadialGradient(cx, baseY + R * 0.09, R * 0.05, cx, baseY + R * 0.09, R * 1.15);
  shadow.addColorStop(0, 'rgba(4,8,22,0.55)');
  shadow.addColorStop(0.55, 'rgba(4,8,22,0.22)');
  shadow.addColorStop(1, 'rgba(4,8,22,0)');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.ellipse(cx, baseY + R * 0.09, R * 1.15, R * 0.16, 0, 0, TAU);
  ctx.fill();

  const w = R * 1.06;
  const h = R * 0.085;
  const x = cx - w / 2;
  const y = baseY - h * 0.42;

  ctx.save();
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, h * 0.42);
  } else {
    ctx.rect(x, y, w, h);
  }
  const plate = ctx.createLinearGradient(0, y, 0, y + h);
  plate.addColorStop(0, 'rgba(148,178,236,0.4)');
  plate.addColorStop(0.35, 'rgba(58,76,120,0.55)');
  plate.addColorStop(1, 'rgba(18,26,52,0.75)');
  ctx.fillStyle = plate;
  ctx.fill();
  ctx.strokeStyle = 'rgba(190,214,255,0.42)';
  ctx.lineWidth = Math.max(1, R * 0.004);
  ctx.stroke();
  ctx.restore();
}

function drawChute(ctx: CanvasRenderingContext2D, state: DrumState, active: boolean): void {
  const { cx, cy, R } = state.world;
  const w = R * 0.36;
  const h = R * 0.15;
  const x = cx - w / 2;
  const y = cy - R - h * 0.3;

  ctx.save();
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, h * 0.45);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.fillStyle = active ? 'rgba(255,206,110,0.28)' : 'rgba(120,148,205,0.14)';
  ctx.fill();
  ctx.strokeStyle = active ? 'rgba(255,222,148,0.85)' : 'rgba(150,178,226,0.42)';
  ctx.lineWidth = Math.max(1.5, R * 0.008);
  ctx.stroke();
  ctx.restore();
}

function drawLabel(ctx: CanvasRenderingContext2D, r: number, label: string): void {
  if (!label) return;

  const maxWidth = r * 1.78;
  let size = Math.max(9, Math.min(r * 0.44, 40));
  setFont(ctx, 650, size);

  // Antes de recortar con elipsis, achicamos la fuente para que el nombre
  // entre completo: "Valeria O." con puntos suspensivos es peor que
  // "Valeria O." un punto mas chica. Escalamos con un 4% de holgura porque si
  // queda justo al limite, la elipsis posterior desborda por un pixel y
  // termina recortando igual.
  let width = ctx.measureText(label).width;
  if (width > maxWidth) {
    size = Math.max(7.5, (size * maxWidth * 0.96) / width);
    setFont(ctx, 650, size);
    width = ctx.measureText(label).width;
  }

  let text = label;
  if (width > maxWidth) {
    while (text.length > 2 && ctx.measureText(`${text}...`).width > maxWidth) {
      text = text.slice(0, -1);
    }
    text = `${text}...`;
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(8,12,24,0.92)';
  ctx.fillText(text, 0, size * 0.04);
}

function drawBall(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  hue: number,
  label: string,
  showLabel: boolean,
  isWinner: boolean,
): void {
  const sat = isWinner ? WINNER_SAT : BALL_SAT;
  const light = isWinner ? WINNER_LIGHT : BALL_LIGHT;
  const rimSat = isWinner ? WINNER_RIM_SAT : BALL_RIM_SAT;
  const rimLight = isWinner ? WINNER_RIM_LIGHT : BALL_RIM_LIGHT;
  const hueUsed = isWinner ? WINNER_HUE : hue;

  ctx.save();
  ctx.translate(x, y);

  // Cuerpo: se pinta en el circulo unitario y se escala al radio real.
  ctx.save();
  ctx.scale(r, r);
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, TAU);
  ctx.fillStyle = `hsl(${hueUsed} ${sat}% ${light}%)`;
  ctx.fill();

  ctx.fillStyle = shadeGrad!;
  ctx.fill();

  ctx.fillStyle = specGrad!;
  ctx.fill();

  ctx.fillStyle = rimLightGrad!;
  ctx.fill();
  ctx.restore();

  // Contorno en pixeles reales (fuera del escalado, para que el grosor del
  // trazo no crezca con la bola).
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.strokeStyle = `hsl(${hueUsed} ${rimSat}% ${rimLight}%)`;
  ctx.lineWidth = Math.max(1, r * 0.055);
  ctx.stroke();

  // Reflejo puntual: el punto de luz que hace que una bola se lea como bola.
  ctx.beginPath();
  ctx.ellipse(-r * 0.34, -r * 0.42, r * 0.17, r * 0.12, -0.6, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fill();

  if (showLabel && r >= MIN_LABEL_R) drawLabel(ctx, r, label);
  ctx.restore();
}

function drawBalls(ctx: CanvasRenderingContext2D, state: DrumState, opts: RenderOptions): void {
  const { world } = state;
  const chuteX = world.cx;
  const chuteY = world.cy - world.R * 1.02;
  const reveal = state.phase === 'reveal' ? clamp01(state.revealProgress) : 0;
  const winner = state.world.balls[state.winnerIndex] ?? null;
  const winnerId = winner ? winner.id : null;

  // Sin aura ni ningun marcador visual para la ganadora: durante la eyecion
  // todas las bolas se ven identicas y el unico que se distingue es el que
  // queda al final.
  for (let i = 0; i < world.balls.length; i++) {
    const ball = world.balls[i]!;
    const progress = ejectProgressOf(state, i);
    if (progress >= 1) continue;

    const isWinner = ball.id === winnerId;
    let x = ball.x;
    let y = ball.y;
    let r = ball.r;
    let alpha = 1;

    if (progress > 0) {
      const t = easeOutCubic(progress);
      x = lerp(state.ejectFromX[i]!, chuteX, t);
      y = lerp(state.ejectFromY[i]!, chuteY, t) - Math.sin(progress * Math.PI) * world.R * 0.14;
      r = ball.r * (1 - 0.55 * t);
      alpha = 1 - t * t;
      if (alpha <= 0.02) continue;
    }

    if (isWinner && reveal > 0) {
      x = lerp(x, world.cx, reveal);
      y = lerp(y, world.cy, reveal);
      r = ball.r * (1 + 2.5 * reveal);
      alpha = Math.min(1, alpha + reveal);
    }

    ctx.globalAlpha = alpha;

    // Entrada en vivo: la bola crece desde cero cuando alguien se acaba de
    // anotar por el chat.
    const spawn = spawnProgressOf(ball, state.clock);
    if (spawn < 1) {
      const grow = spawn * (2 - spawn);
      r *= grow;
      ctx.globalAlpha = alpha * grow;
      if (r < 2) {
        ctx.globalAlpha = 1;
        continue;
      }
    }

    drawBall(ctx, x, y, r, ball.hue, ball.displayLabel, opts.showLabels, isWinner && reveal > 0.55);
    ctx.globalAlpha = 1;
  }
}

export function renderDrum(ctx: CanvasRenderingContext2D, state: DrumState, opts: RenderOptions): void {
  ctx.clearRect(0, 0, opts.width, opts.height);
  ensureGradients(ctx);

  drawPedestal(ctx, state);
  drawGlass(ctx, state);
  drawChute(ctx, state, state.phase === 'ejecting');
  drawBalls(ctx, state, opts);
}

export function resetRendererCache(): void {
  shadeGrad = null;
  specGrad = null;
  rimLightGrad = null;
}