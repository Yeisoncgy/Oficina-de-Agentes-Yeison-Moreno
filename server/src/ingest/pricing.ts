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

// ---- Libro de precios: ningun modelo de una familia conocida queda en 0 USD ----
// Orden: precio que fijo el usuario > tabla oficial > precio aprendido del cost-state de Claude Code >
// el modelo mas nuevo de la misma familia. Los dos ultimos son estimaciones (la UI los marca).

/** table: tabla oficial · custom: lo fijo el usuario · learned: del cost-state de Claude Code · family: el mas nuevo de su familia */
export type PriceSource = 'table' | 'custom' | 'learned' | 'family';

export interface ResolvedPrice extends PriceMatch {
  source: PriceSource;
  /** learned y family: el monto es una estimacion */
  estimated: boolean;
}

/** las cinco tarifas planas (sin tramo largo) que puede fijar el usuario */
export interface FlatPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** id sin fecha ni sufijo de contexto: "claude-opus-5-5-20260101[1m]" -> "claude-opus-5-5" */
export function baseModelId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

let customPrices: ReadonlyMap<string, FlatPrice> = new Map();
/** modelo base -> llave de la tabla cuyo precio reprodujo el costo que calculo Claude Code */
let learnedPrices: ReadonlyMap<string, string> = new Map();

/** carga los precios del usuario y los aprendidos (server/src/ingest/priceBook.ts los lee de la DB) */
export function setPriceBook(custom: ReadonlyMap<string, FlatPrice>, learned: ReadonlyMap<string, string>): void {
  customPrices = custom;
  learnedPrices = learned;
}

export function tablePrices(): ReadonlyArray<readonly [string, Price]> {
  return PRICES;
}

function versionOf(key: string): number[] {
  return key.split('-').slice(2).map((n) => Number(n) || 0);
}

/** el modelo mas nuevo de la tabla dentro de una familia; null si la familia no esta en la tabla */
export function newestOfFamily(family: ModelFamily): PriceMatch | null {
  let best: PriceMatch | null = null;
  let bestV: number[] = [];
  for (const [key, price] of PRICES) {
    if (modelFamily(key) !== family) continue;
    const v = versionOf(key);
    const newer = v[0] !== bestV[0] ? (v[0] ?? 0) > (bestV[0] ?? -1) : (v[1] ?? 0) > (bestV[1] ?? -1);
    if (!best || newer) {
      best = { key, price };
      bestV = v;
    }
  }
  return best;
}

/** precio con el que se cotiza un modelo; null solo si su familia no se conoce */
export function resolvePrice(model: string): ResolvedPrice | null {
  const base = baseModelId(model);
  const custom = customPrices.get(base);
  if (custom) return { key: base, price: { ...custom }, source: 'custom', estimated: false };
  const exact = findPrice(model);
  if (exact) return { ...exact, source: 'table', estimated: false };
  const learnedKey = learnedPrices.get(base);
  const learned = learnedKey ? PRICES.find(([k]) => k === learnedKey) : undefined;
  if (learned) return { key: learned[0], price: learned[1], source: 'learned', estimated: true };
  const family = modelFamily(model);
  if (family === 'other') return null;
  const newest = newestOfFamily(family);
  return newest ? { ...newest, source: 'family', estimated: true } : null;
}

export function usdWith(p: Price, t: UsageTokens): number {
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheWrite5m * p.cacheWrite5m +
      t.cacheWrite1h * p.cacheWrite1h +
      t.cacheRead * p.cacheRead) /
    1_000_000
  );
}

/** tarifa que aplica a una llamada: el tramo largo si su prompt lo supera */
export function tierOf(base: Price, t: UsageTokens): Price {
  const promptTokens = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  return base.long && base.longAbove !== undefined && promptTokens > base.longAbove ? base.long : base;
}

export interface Quote {
  usd: number;
  estimated: boolean;
  source: PriceSource;
}

/** costo de una llamada con su fuente; null si el modelo no tiene precio ni familia conocida */
export function quote(model: string, t: UsageTokens, speed?: string | null): Quote | null {
  const match = resolvePrice(model);
  if (!match) return null;
  let multiplier = 1;
  if (speed === 'fast') {
    if (!FAST_MODELS.has(match.key)) return null;
    multiplier = 2;
  }
  return { usd: usdWith(tierOf(match.price, t), t) * multiplier, estimated: match.estimated, source: match.source };
}

export function costUsd(model: string, t: UsageTokens, speed?: string | null): number | null {
  return quote(model, t, speed)?.usd ?? null;
}
