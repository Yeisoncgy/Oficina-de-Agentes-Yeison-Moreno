// Contexto de un agente: cuanto cuesta su proxima llamada solo por volver a mandar lo que ya tiene. Logica pura.
import type { AgentContext } from '@shared/contract';

export interface NextCall {
  tokens: number;
  /** la cache sigue viva: releer el contexto se cobra a precio de lectura */
  warm: boolean;
  /** piso del costo de la proxima llamada; null si el modelo no tiene precio */
  usd: number | null;
  /** lo que costaria con la cache vencida (para avisar antes de dejarla vencer) */
  coldUsd: number | null;
  /** ms que le quedan a la cache; 0 si ya vencio */
  leftMs: number;
}

export function nextCall(context: AgentContext | null | undefined, nowMs: number): NextCall | null {
  if (!context || context.tokens <= 0) return null;
  const expires = context.cacheExpiresAt ? Date.parse(context.cacheExpiresAt) : Number.NaN;
  const leftMs = Number.isNaN(expires) ? 0 : Math.max(0, expires - nowMs);
  const warm = leftMs > 0;
  return { tokens: context.tokens, warm, usd: warm ? context.warmUsd : context.coldUsd, coldUsd: context.coldUsd, leftMs };
}

/** contexto grande: cada llamada relee mucho. Mismos cortes que el detector de habitos (150 mil y 300 mil) */
export function contextTone(tokens: number): 'ok' | 'warn' | 'high' {
  if (tokens >= 300_000) return 'high';
  if (tokens >= 150_000) return 'warn';
  return 'ok';
}
