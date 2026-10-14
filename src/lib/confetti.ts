export interface ConfettiOptions {
  gravity?: number;
  drag?: number;
}

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vrot: number;
  color: string;
  life: number;
  maxLife: number;
}

const COLORS = [
  'hsl(48 96% 62%)',
  'hsl(160 78% 52%)',
  'hsl(205 92% 60%)',
  'hsl(330 88% 64%)',
  'hsl(12 94% 62%)',
  'hsl(275 84% 68%)',
  'hsl(0 0% 100%)',
  'hsl(88 78% 58%)',
];

export class Confetti {
  private pieces: Piece[] = [];
  private readonly gravity: number;
  private readonly drag: number;

  constructor(opts: ConfettiOptions = {}) {
    this.gravity = opts.gravity ?? 1500;
    this.drag = opts.drag ?? 0.72;
  }

  get active(): boolean {
    return this.pieces.length > 0;
  }

  clear(): void {
    this.pieces.length = 0;
  }

  burst(x: number, y: number, amount = 160): void {
    for (let i = 0; i < amount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 320 + Math.random() * 1150;
      const maxLife = 1.5 + Math.random() * 1.6;
      this.pieces.push({
        x: x + (Math.random() - 0.5) * 60,
        y: y + (Math.random() - 0.5) * 40,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 420,
        w: 7 + Math.random() * 9,
        h: 10 + Math.random() * 14,
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 13,
        color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
        life: maxLife,
        maxLife,
      });
    }
  }

  update(dt: number): void {
    const damping = Math.max(0, 1 - this.drag * dt);
    for (const p of this.pieces) {
      p.vy += this.gravity * dt;
      p.vx *= damping;
      p.vy *= damping;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vrot * dt;
      p.life -= dt;
    }
    this.pieces = this.pieces.filter((p) => p.life > 0);
  }

  /**
   * Siempre limpia antes de dibujar, incluso sin partículas. Quien llame
   * tiene que poder saltarse el draw cuando no hay nada y aun así no dejar
   * restos del frame anterior pegados en el canvas.
   */
  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.clearRect(0, 0, width, height);
    for (const p of this.pieces) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.min(1, p.life / (p.maxLife * 0.45));
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}
