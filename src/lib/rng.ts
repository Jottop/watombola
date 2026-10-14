const UINT32_RANGE = 0x1_0000_0000;

export type RandomSource = () => number;

const cryptoRandom: RandomSource = () => {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0]! / UINT32_RANGE;
};

/**
 * Entero uniforme en [0, maxExclusive) usando rejection sampling para evitar
 * el sesgo que introduce el modulo cuando maxExclusive no divide 2^32.
 */
export function randomInt(maxExclusive: number, rand: RandomSource = cryptoRandom): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError(`randomInt espera un entero > 0, recibio ${maxExclusive}`);
  }
  const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
  let draw = Math.floor(rand() * UINT32_RANGE);
  while (draw >= limit) draw = Math.floor(rand() * UINT32_RANGE);
  return draw % maxExclusive;
}

export function randomFloat(rand: RandomSource = cryptoRandom): number {
  return rand();
}

export function randomRange(min: number, max: number, rand: RandomSource = cryptoRandom): number {
  return min + rand() * (max - min);
}

/** Fisher-Yates. Devuelve una copia, no muta la entrada. */
export function shuffle<T>(items: readonly T[], rand: RandomSource = cryptoRandom): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1, rand);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** PRNG determinista (mulberry32) para tests y para simular una tómbola reproducible. */
export function seededRandom(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };
}

export { cryptoRandom };
