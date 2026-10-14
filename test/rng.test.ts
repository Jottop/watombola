import { describe, expect, it } from 'vitest';
import { randomInt, seededRandom, shuffle } from '../src/lib/rng';

describe('randomInt', () => {
  it('rechaza rangos invalidos', () => {
    expect(() => randomInt(0)).toThrow(RangeError);
    expect(() => randomInt(-3)).toThrow(RangeError);
    expect(() => randomInt(2.5)).toThrow(RangeError);
  });

  it('devuelve siempre un valor dentro del rango', () => {
    for (let i = 0; i < 2000; i++) {
      const value = randomInt(6);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(6);
    }
  });

  it('no tiene sesgo de modulo', () => {
    // 7 no divide 2^32: sin rejection sampling caeria ~0.4% de diferencia
    const counts = new Array<number>(7).fill(0);
    const rand = seededRandom(42);
    const runs = 70000;
    for (let i = 0; i < runs; i++) counts[randomInt(7, rand)]! += 1;

    const expected = runs / 7;
    for (const count of counts) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.06);
    }
  });
});

describe('shuffle', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];

  it('no muta la entrada', () => {
    const copy = [...input];
    shuffle(input, seededRandom(1));
    expect(input).toEqual(copy);
  });

  it('es una permutacion', () => {
    const out = shuffle(input, seededRandom(9));
    expect([...out].sort((a, b) => a - b)).toEqual(input);
  });

  it('es reproducible con la misma seed', () => {
    expect(shuffle(input, seededRandom(77))).toEqual(shuffle(input, seededRandom(77)));
  });

  it('coloca cada elemento en posiciones equiprobables', () => {
    const firstPositions = new Array<number>(5).fill(0);
    for (let seed = 0; seed < 20000; seed++) {
      firstPositions[shuffle([0, 1, 2, 3, 4], seededRandom(seed)).indexOf(0)]! += 1;
    }
    const expected = 20000 / 5;
    for (const count of firstPositions) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.05);
    }
  });
});
