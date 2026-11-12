// Precios oficiales en USD por millon de tokens (skill claude-api, 2026-06).
// Modelo sin precio => costo null. No se inventan precios para nada mas (web search no se suma).

import type { ModelFamily } from '@shared/contract';

export interface Price {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** precio de toda la llamada cuando su prompt (entrada + cache) supera longAbove tokens */
  longAbove?: number;
  long?: Price;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

function price(input: number, output: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number): Price {
  return { input, output, cacheWrite5m, cacheWrite1h, cacheRead };
}

const OPUS_4X = price(5, 25, 6.25, 10, 0.5);

// La doc oficial no dice sobre que se miden los 100K: se asume el prompt completo (entrada + lectura y escritura
// de cache) y el tramo alto sobre toda la llamada.
const HAIKU_5_5: Price = {
  ...price(0.1, 0.5, 0.125, 0.2, 0.01),
  longAbove: 100_000,
  long: price(0.5, 2.5, 0.625, 1, 0.05),
};

const PRICES: ReadonlyArray<readonly [string, Price]> = [
  ['claude-fable-5-1', price(10, 50, 12.5, 20, 0.25)],
  ['claude-mythos-5-1', price(10, 50, 12.5, 20, 0.25)],
  ['claude-fable-5', price(10, 50, 12.5, 20, 1.0)],
  ['claude-opus-5-5', price(4, 20, 5, 8, 0.2)],
  ['claude-opus-5', OPUS_4X],
  ['claude-opus-4-8', OPUS_4X],
  ['claude-opus-4-7', OPUS_4X],
  ['claude-opus-4-6', OPUS_4X],
  ['claude-sonnet-5-5', price(2, 10, 2.5, 4, 0.1)],
  ['claude-sonnet-5', price(2, 10, 2.5, 4, 0.2)],
  ['claude-sonnet-4-6', price(3, 15, 3.75, 6, 0.3)],
  ['claude-haiku-5-5', HAIKU_5_5],
  ['claude-haiku-4-5', price(1, 5, 1.25, 2, 0.1)],
];

/** prefijos ordenados del mas largo al mas corto: claude-opus-5-5 gana sobre claude-opus-5 */
const BY_LENGTH = [...PRICES].sort((a, b) => b[0].length - a[0].length);

/** unicos modelos donde speed 'fast' tiene precio conocido (x2) */
const FAST_MODELS = new Set(['claude-opus-5', 'claude-opus-5-5', 'claude-opus-4-8']);

export interface PriceMatch {
  key: string;
  price: Price;
}

export function findPrice(model: string): PriceMatch | null {
  for (const [key, p] of BY_LENGTH) {
    if (!model.startsWith(key)) continue;
    // "claude-opus-4-6" no debe casar con un hipotetico "claude-opus-4-60"
    const rest = model.slice(key.length);
    if (/^\d/.test(rest)) continue;
    // "-7" en "claude-opus-5-7" es otra version, sin precio conocido; "-20251001" es una fecha y vale
    const digits = /^-(\d+)/.exec(rest)?.[1];
    if (digits !== undefined && digits.length !== 8) continue;
    return { key, price: p };
  }
  return null;
}

const FAMILIES: readonly ModelFamily[] = ['fable', 'opus', 'sonnet', 'haiku'];

/** familia del modelo por su id; lo que no es de las cuatro conocidas es 'other' (no se adivina) */
export function modelFamily(model: string | null | undefined): ModelFamily {
  const name = /^claude-([a-z]+)-/.exec(model ?? '')?.[1];
  return FAMILIES.find((f) => f === name) ?? 'other';
}

export function costUsd(model: string, t: UsageTokens, speed?: string | null): number | null {
  const match = findPrice(model);
  if (!match) return null;
  let multiplier = 1;
  if (speed === 'fast') {
    if (!FAST_MODELS.has(match.key)) return null;
    multiplier = 2;
  }
  const base = match.price;
  const promptTokens = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  const p = base.long && base.longAbove !== undefined && promptTokens > base.longAbove ? base.long : base;
  const usd =
    (t.input * p.input +
      t.output * p.output +
      t.cacheWrite5m * p.cacheWrite5m +
      t.cacheWrite1h * p.cacheWrite1h +
      t.cacheRead * p.cacheRead) /
    1_000_000;
  return usd * multiplier;
}
