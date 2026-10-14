import { describe, expect, it } from 'vitest';
import { Confetti } from '../src/lib/confetti';

function fakeCtx() {
  const calls = { clearRect: 0, fillRect: 0 };
  const partial = {
    clearRect: () => {
      calls.clearRect++;
    },
    fillRect: () => {
      calls.fillRect++;
    },
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    globalAlpha: 1,
    fillStyle: '',
  };
  // Solo nos interesan las dos llamadas que mide el test.
  return { ctx: partial as unknown as CanvasRenderingContext2D, calls };
}

describe('Confetti', () => {
  it('dibuja particulas al hacer burst', () => {
    const confetti = new Confetti();
    const { ctx, calls } = fakeCtx();

    confetti.burst(100, 100, 40);
    expect(confetti.active).toBe(true);

    confetti.draw(ctx, 1920, 1080);
    expect(calls.clearRect).toBe(1);
    expect(calls.fillRect).toBe(40);
  });

  it('limpia el canvas aunque no tenga particulas', () => {
    // Este es el contrato que evita el confeti congelado: el overlay puede
    // llamar a draw() siempre y nunca queda el frame anterior pegado.
    const { ctx, calls } = fakeCtx();

    new Confetti().draw(ctx, 1920, 1080);

    expect(calls.clearRect).toBe(1);
    expect(calls.fillRect).toBe(0);
  });

  it('clear() vacia y el siguiente draw limpia el canvas', () => {
    const confetti = new Confetti();
    const { ctx, calls } = fakeCtx();

    confetti.burst(100, 100, 20);
    confetti.draw(ctx, 1920, 1080);
    expect(calls.fillRect).toBe(20);

    // Reiniciar a mitad de la animacion.
    confetti.clear();
    expect(confetti.active).toBe(false);

    confetti.draw(ctx, 1920, 1080);
    expect(calls.clearRect).toBe(2);
    expect(calls.fillRect).toBe(20);
  });

  it('las particulas mueren solas y el draw las borra', () => {
    const confetti = new Confetti();
    const { ctx, calls } = fakeCtx();

    confetti.burst(100, 100, 5);
    confetti.update(10);

    expect(confetti.active).toBe(false);
    confetti.draw(ctx, 1920, 1080);
    expect(calls.clearRect).toBe(1);
    expect(calls.fillRect).toBe(0);
  });

  it('update no rompe con dt enorme', () => {
    const confetti = new Confetti();
    confetti.burst(100, 100, 10);
    confetti.update(50);
    expect(confetti.active).toBe(false);
  });
});
