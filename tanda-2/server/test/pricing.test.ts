import { describe, expect, it } from 'vitest';
import { costUsd, findPrice, modelFamily } from '../src/ingest/pricing';

const ONE_M = 1_000_000;
const tokens = (t: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h', number>>) => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  ...t,
});

describe('findPrice', () => {
  it('elige el prefijo mas largo', () => {
    expect(findPrice('claude-opus-5-5')?.key).toBe('claude-opus-5-5');
    expect(findPrice('claude-opus-5')?.key).toBe('claude-opus-5');
    expect(findPrice('claude-fable-5-1')?.key).toBe('claude-fable-5-1');
    expect(findPrice('claude-fable-5')?.key).toBe('claude-fable-5');
    expect(findPrice('claude-mythos-5-1')?.key).toBe('claude-mythos-5-1');
  });

  it('acepta sufijo de fecha', () => {
    expect(findPrice('claude-haiku-4-5-20251001')?.key).toBe('claude-haiku-4-5');
    expect(findPrice('claude-opus-5-20260101')?.key).toBe('claude-opus-5');
  });

  it('modelo desconocido no tiene precio', () => {
    expect(findPrice('claude-desconocido-9')).toBeNull();
    expect(findPrice('<synthetic>')).toBeNull();
    expect(findPrice('claude-opus-4-60')).toBeNull();
    expect(costUsd('claude-desconocido-9', tokens({ input: 100 }))).toBeNull();
  });

  it('una version menor desconocida no toma el precio de la familia', () => {
    expect(findPrice('claude-sonnet-5-7')).toBeNull();
    expect(findPrice('claude-opus-5-7')).toBeNull();
    expect(findPrice('claude-haiku-4-5-1')).toBeNull();
    expect(findPrice('claude-fable-5-12')).toBeNull();
    expect(costUsd('claude-sonnet-5-7', tokens({ input: ONE_M }))).toBeNull();
    // un sufijo numerico que no es fecha de 8 digitos tampoco se adivina
    expect(findPrice('claude-sonnet-5-2026')).toBeNull();
  });

  it('las versiones conocidas con fecha siguen teniendo precio', () => {
    expect(findPrice('claude-sonnet-5-20260301')?.key).toBe('claude-sonnet-5');
    expect(findPrice('claude-sonnet-5-5-20260301')?.key).toBe('claude-sonnet-5-5');
    expect(findPrice('claude-opus-5-5-20260101')?.key).toBe('claude-opus-5-5');
    expect(findPrice('claude-fable-5-1-20260601')?.key).toBe('claude-fable-5-1');
    expect(findPrice('claude-sonnet-4-6[1m]')?.key).toBe('claude-sonnet-4-6');
  });
});

describe('modelFamily', () => {
  it('familia por el id, other si no es conocida', () => {
    expect(modelFamily('claude-fable-5-1')).toBe('fable');
    expect(modelFamily('claude-opus-5-5-20260101')).toBe('opus');
    expect(modelFamily('claude-sonnet-5-5')).toBe('sonnet');
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelFamily('claude-mythos-5-1')).toBe('other');
    expect(modelFamily('<synthetic>')).toBe('other');
    expect(modelFamily(null)).toBe('other');
  });
});

describe('costUsd', () => {
  it('suma las cinco tarifas por millon', () => {
    // opus 5.5: 4 / 20 / 5 / 8 / 0.20
    const cost = costUsd('claude-opus-5-5', tokens({ input: 10, output: 50, cacheWrite5m: 400, cacheWrite1h: 600, cacheRead: 2000 }));
    expect(cost).toBeCloseTo((10 * 4 + 50 * 20 + 400 * 5 + 600 * 8 + 2000 * 0.2) / ONE_M, 12);
  });

  it('distingue fable 5.1 de fable 5 en cache read', () => {
    expect(costUsd('claude-fable-5-1', tokens({ cacheRead: ONE_M }))).toBeCloseTo(0.25, 12);
    expect(costUsd('claude-fable-5', tokens({ cacheRead: ONE_M }))).toBeCloseTo(1, 12);
  });

  it('tabla de cada familia', () => {
    expect(costUsd('claude-opus-4-8', tokens({ input: ONE_M, output: ONE_M }))).toBeCloseTo(5 + 25, 9);
    expect(costUsd('claude-opus-4-6', tokens({ cacheWrite1h: ONE_M }))).toBeCloseTo(10, 9);
    expect(costUsd('claude-sonnet-5', tokens({ input: ONE_M, cacheWrite5m: ONE_M }))).toBeCloseTo(2 + 2.5, 9);
    expect(costUsd('claude-sonnet-4-6', tokens({ output: ONE_M, cacheRead: ONE_M }))).toBeCloseTo(15 + 0.3, 9);
    expect(costUsd('claude-haiku-4-5-20251001', tokens({ input: ONE_M, output: ONE_M }))).toBeCloseTo(1 + 5, 9);
  });

  it('haiku 5.5: tramo de 100K por llamada sobre el prompt completo', () => {
    expect(costUsd('claude-haiku-5-5', tokens({ input: 100_000, output: ONE_M }))).toBeCloseTo(0.01 + 0.5, 9);
    expect(costUsd('claude-haiku-5-5', tokens({ input: ONE_M, output: ONE_M }))).toBeCloseTo(0.5 + 2.5, 9);
    expect(costUsd('claude-haiku-5-5', tokens({ input: 1, cacheRead: 100_000 }))).toBeCloseTo((1 * 0.5 + 100_000 * 0.05) / ONE_M, 12);
    expect(costUsd('claude-haiku-5-5', tokens({ cacheWrite5m: ONE_M }))).toBeCloseTo(0.625, 9);
    expect(costUsd('claude-haiku-5-5', tokens({ cacheWrite1h: 1000, cacheRead: 1000 }))).toBeCloseTo((1000 * 0.2 + 1000 * 0.01) / ONE_M, 12);
    expect(costUsd('claude-haiku-5-5', tokens({ input: 1 }), 'fast')).toBeNull();
  });

  it('fast duplica solo en opus 5, opus 5.5 y opus 4.8', () => {
    const t = tokens({ input: ONE_M });
    expect(costUsd('claude-opus-5-5', t, 'fast')).toBeCloseTo(8, 9);
    expect(costUsd('claude-opus-5', t, 'fast')).toBeCloseTo(10, 9);
    expect(costUsd('claude-opus-5', t, 'standard')).toBeCloseTo(5, 9);
    expect(costUsd('claude-opus-4-8', t, 'fast')).toBeCloseTo(10, 9);
    expect(costUsd('claude-sonnet-5', t, 'fast')).toBeNull();
    expect(costUsd('claude-opus-4-7', t, 'fast')).toBeNull();
  });
});
