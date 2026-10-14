import { ejectProgressOf, type DrumState } from './drum-machine';
import { spawnProgressOf } from './physics';

const TAU = Math.PI * 2;
const FONT_STACK = "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";

let highlightGrad: CanvasGradient | null = null;
let shadeGrad: CanvasGradient | null = null;
let gradRadius = 0;

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
 * saltearia: el texto caeria al default de 10px. Se asigna siempre.
 */
function setFont(ctx: CanvasRenderingContext2D, weight: number, size: number): void {
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
}

/** Los degradados viven en el espacio del usuario: se crean con la identidad
 *  de transformación y se pintan bajo un translate por bola. */
function ensureBallGradients(ctx: CanvasRenderingContext2D, r: number): void {
  if (gradRadius === r && highlightGrad && shadeGrad) return;
  gradRadius = r;

  highlightGrad = ctx.createRadialGradient(-r * 0.32, -r * 0.36, r * 0.05, 0, 0, r);
  highlightGrad.addColorStop(0, 'rgba(255,255,255,0.62)');
  highlightGrad.addColorStop(0.42, 'rgba(255,255,255,0.14)');
  highlightGrad.addColorStop(1, 'rgba(255,255,255,0)');

  shadeGrad = ctx.createLinearGradient(0, -r, 0, r);
  shadeGrad.addColorStop(0, 'rgba(0,0,0,0)');
  shadeGrad.addColorStop(0.62, 'rgba(0,0,0,0)');
  shadeGrad.addColorStop(1, 'rgba(0,0,0,0.34)');
}

function drawGlass(ctx: CanvasRenderingContext2D, state: DrumState): void {
  const { cx, cy, R, spinPhase } = state.world;

  const glow = ctx.createRadialGradient(cx, cy, R * 0.94, cx, cy, R * 1.14);
  glow.addColorStop(0, 'rgba(150,195,255,0.18)');
  glow.addColorStop(1, 'rgba(150,195,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.14, 0, TAU);
  ctx.fill();

  const inner = ctx.createRadialGradient(cx, cy - R * 0.3, R * 0.05, cx, cy, R);
  inner.addColorStop(0, 'rgba(255,255,255,0.06)');
  inner.addColorStop(1, 'rgba(110,150,255,0.028)');
  ctx.fillStyle = inner;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.clip();
  ctx.lineWidth = Math.max(1, R * 0.018);
  for (let i = 0; i < 5; i++) {
    const a = spinPhase + (i / 5) * TAU;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R * 0.1, cy + Math.sin(a) * R * 0.1);
    ctx.lineTo(cx + Math.cos(a) * R * 0.97, cy + Math.sin(a) * R * 0.97);
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.stroke();
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.strokeStyle = 'rgba(195,222,255,0.45)';
  ctx.lineWidth = Math.max(2, R * 0.013);
  ctx.stroke();
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
  ctx.fillStyle = active ? 'rgba(255,214,120,0.30)' : 'rgba(150,180,230,0.16)';
  ctx.fill();
  ctx.strokeStyle = active ? 'rgba(255,226,150,0.85)' : 'rgba(170,200,245,0.5)';
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
  ctx.fillStyle = 'rgba(8,12,24,0.9)';
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
): void {
  ctx.save();
  ctx.translate(x, y);

  ctx.fillStyle = `hsl(${hue} 76% 53%)`;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();

  ctx.fillStyle = shadeGrad!;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();

  ctx.fillStyle = highlightGrad!;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = `hsl(${hue} 72% 26%)`;
  ctx.lineWidth = Math.max(1, r * 0.07);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.stroke();

  if (showLabel && r >= 14) drawLabel(ctx, r, label);
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
      r = ball.r * (1 + 3.1 * reveal);
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

    // La bola usa siempre su etiqueta corta: el nombre completo y legible sale
    // en el elemento DOM de abajo, mucho mas grande.
    drawBall(ctx, x, y, r, ball.hue, ball.displayLabel, opts.showLabels);
    ctx.globalAlpha = 1;
  }
}

export function renderDrum(ctx: CanvasRenderingContext2D, state: DrumState, opts: RenderOptions): void {
  ctx.clearRect(0, 0, opts.width, opts.height);

  const sample = state.world.balls[0];
  ensureBallGradients(ctx, sample ? sample.r : 28);

  drawGlass(ctx, state);
  drawChute(ctx, state, state.phase === 'ejecting');
  drawBalls(ctx, state, opts);
}

export function resetRendererCache(): void {
  highlightGrad = null;
  shadeGrad = null;
  gradRadius = 0;
}
