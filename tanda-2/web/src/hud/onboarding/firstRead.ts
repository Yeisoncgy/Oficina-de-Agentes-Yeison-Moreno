import { useQuery, type QueryStatus } from '@tanstack/react-query';
import { getJson } from '@/state/api';
import { useOfficeStore } from '@/state/store';

// Lectura del historial al arrancar el server (backfill). La primera vez puede tardar: mientras tanto la
// oficina se ve vacia y "Sin agentes trabajando hoy" confunde, asi que el HUD muestra el avance.

/** forma de GET /api/health (server/src/routes/office.ts) */
export interface HealthResponse {
  ok: boolean;
  backfill: 'pendiente' | 'en curso' | 'listo' | 'error';
  filesTotal: number;
  filesDone: number;
  sseClients: number;
}

export const FIRST_READ_POLL_MS = 2_000;
export const FIRST_READ_ERROR_POLL_MS = 10_000;

export interface FirstReadView {
  done: number;
  total: number;
  /** 0-1; null mientras el server todavia cuenta los archivos */
  ratio: number | null;
  /** "120 de 480 archivos" · "Buscando archivos…" */
  text: string;
}

const countFmt = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

function reading(health: HealthResponse | undefined): boolean {
  return health?.backfill === 'pendiente' || health?.backfill === 'en curso';
}

/** null = no hay lectura en curso (termino, fallo o todavia no hay respuesta) */
export function firstReadView(health: HealthResponse | undefined): FirstReadView | null {
  if (!health || !reading(health)) return null;
  const total = Math.max(0, Math.floor(health.filesTotal));
  const done = Math.min(Math.max(0, Math.floor(health.filesDone)), total);
  if (total === 0) return { done: 0, total: 0, ratio: null, text: 'Buscando archivos…' };
  return { done, total, ratio: done / total, text: `${countFmt.format(done)} de ${countFmt.format(total)} archivos` };
}

/** cada 2 s mientras el server lee; si /api/health falla, cada 10 s; al terminar la lectura, nunca */
export function firstReadPollMs(status: QueryStatus, data: HealthResponse | undefined): number | false {
  if (status === 'error') return FIRST_READ_ERROR_POLL_MS;
  return data === undefined || reading(data) ? FIRST_READ_POLL_MS : false;
}

/**
 * Pregunta solo con el SSE vivo: con el server caido no hay a quien preguntar. Al volver el SSE pregunta de
 * nuevo (staleTime 0), porque un server reiniciado relee el historial. Apagado en demo
 */
export function useFirstRead(enabled: boolean): FirstReadView | null {
  const live = useOfficeStore((s) => s.connection === 'live');
  const query = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => getJson<HealthResponse>('/api/health', signal),
    enabled: enabled && live,
    staleTime: 0,
    retry: false,
    refetchInterval: (q) => firstReadPollMs(q.state.status, q.state.data),
  });
  return enabled ? firstReadView(query.data) : null;
}
