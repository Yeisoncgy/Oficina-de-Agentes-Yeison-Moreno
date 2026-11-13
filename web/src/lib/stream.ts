import type { OfficeSnapshot } from '@shared/contract';
import type { ConnectionState } from '@/state/store';

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 10_000;
/** fallos seguidos antes de declarar "Sin conexion" (antes se muestra "Reconectando") */
export const OFFLINE_AFTER_FAILURES = 2;
/** el server manda ping cada 15 s: tres pings perdidos = conexion muerta aunque el socket no lo diga */
export const STREAM_SILENCE_MS = 45_000;

/** 1 s, 2 s, 4 s, 8 s, 10 s, 10 s... */
export function backoffDelay(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (n - 1));
}

export function connectionAfterFailure(failures: number): ConnectionState {
  return failures >= OFFLINE_AFTER_FAILURES ? 'offline' : 'connecting';
}

export function isDemoMode(search: string): boolean {
  const value = new URLSearchParams(search).get('demo');
  return value === '1' || value === 'true';
}

export function isSnapshot(value: unknown): value is OfficeSnapshot {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.generatedAt === 'string' && Array.isArray(o.rooms) && typeof o.today === 'object' && o.today !== null
  );
}

export function parseSnapshot(raw: unknown): OfficeSnapshot | null {
  if (typeof raw !== 'string') return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isSnapshot(value) ? value : null;
  } catch {
    return null;
  }
}

/** ?lite=1: vista ligera, los mismos datos sin la oficina 3D */
export function isLiteMode(search: string): boolean {
  const value = new URLSearchParams(search).get('lite');
  return value !== null && value !== '0' && value !== 'false';
}
