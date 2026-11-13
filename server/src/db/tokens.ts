import type { TokenBreakdown } from '@shared/contract';

/** columnas agregadas sobre la tabla usage (alias: input, output, cache_read, cache_write, cost, unpriced, estimated) */
export const TOKEN_SUM_SQL = `
  COALESCE(SUM(input), 0) AS input,
  COALESCE(SUM(output), 0) AS output,
  COALESCE(SUM(cache_read), 0) AS cache_read,
  COALESCE(SUM(cache_write_5m + cache_write_1h), 0) AS cache_write,
  COALESCE(SUM(cost_usd), 0) AS cost,
  COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN input + output + cache_read + cache_write_5m + cache_write_1h ELSE 0 END), 0) AS unpriced,
  COALESCE(SUM(CASE WHEN cost_est = 1 THEN cost_usd ELSE 0 END), 0) AS estimated`;

export interface TokenSumRow {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** suma solo de lo que tiene precio */
  cost: number;
  /** tokens de modelos sin precio conocido */
  unpriced: number;
  /** parte de `cost` cotizada con un precio estimado (aprendido de Claude Code o de la familia) */
  estimated: number;
}

export const ZERO_SUM: TokenSumRow = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, unpriced: 0, estimated: 0 };

export function toBreakdown(row: TokenSumRow | undefined): TokenBreakdown {
  const r = row ?? ZERO_SUM;
  return {
    input: r.input,
    output: r.output,
    cacheRead: r.cache_read,
    cacheWrite: r.cache_write,
    total: r.input + r.output + r.cache_read + r.cache_write,
  };
}

/** costo de un agente o tarea: null si hubo tokens de modelos sin precio */
export function strictCost(row: TokenSumRow | undefined): number | null {
  const r = row ?? ZERO_SUM;
  return r.unpriced > 0 ? null : r.cost;
}
