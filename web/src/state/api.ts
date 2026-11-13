import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentActionsResponse,
  BudgetResponse,
  CompareResponse,
  CostsResponse,
  HabitsInboxResponse,
  HabitsResponse,
  HistoryRange,
  InboxLevel,
  IngestHealth,
  MonthsResponse,
  PriceRates,
  PricesResponse,
  RankingResponse,
  ReconcileResponse,
  ReportResponse,
  RoomFilesResponse,
  RuleId,
  RulesResponse,
  SessionsResponse,
  SimulatorResponse,
  TasksResponse,
  TranscriptResponse,
  WhatIfResponse,
} from '@shared/contract';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'Sin conexión con el servidor');
  }
  if (!response.ok) throw new ApiError(response.status, `El servidor respondió ${response.status}`);
  return (await response.json()) as T;
}

/** Mensaje para el usuario: nombra el problema y como salir de el */
export function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    // Vite responde 500/502/504 cuando el server de :4317 no esta arriba.
    if ([0, 500, 502, 503, 504].includes(error.status)) {
      return 'No se pudo leer del servidor. ¿Está corriendo npm run dev?';
    }
    if (error.status === 404) return 'El servidor no tiene este dato.';
    return `El servidor respondió con un error (${error.status}).`;
  }
  return 'La respuesta del servidor no se pudo leer.';
}

const withCursor = (path: string, cursor: string | null): string =>
  cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path;

/** enabled = false en modo demo: el historial vive en el servidor */
async function sendJson<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Sin conexión con el servidor');
  }
  if (!response.ok) throw new ApiError(response.status, `El servidor respondió ${response.status}`);
  return (await response.json()) as T;
}

/** ajusta el mes actual al gasto real (USD); desde ese momento se suma lo nuevo */
export function useSetBudgetBaseline() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (amountUsd: number) => sendJson<BudgetResponse>('PUT', '/api/budget/baseline', { amountUsd }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['history'] }),
  });
}

export function useClearBudgetBaseline() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => sendJson<BudgetResponse>('DELETE', '/api/budget/baseline'),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['history'] }),
  });
}

/**
 * Las rutas del presupuesto responden el BudgetResponse del mes que tocaron: se deja en cache al instante
 * (el calendario no espera el refetch) y el resto del historial se invalida.
 */
function useBudgetMutation<V>(request: (vars: V) => Promise<BudgetResponse>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (data) => {
      client.setQueryData(['history', 'budget', data.month], data);
      void client.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

/** monto del presupuesto mensual (USD) */
export function useSetBudgetAmount() {
  return useBudgetMutation((amountUsd: number) => sendJson<BudgetResponse>('PUT', '/api/budget/amount', { amountUsd }));
}

/** vuelve al monto por defecto (BUDGET_DEFAULT_USD) */
export function useClearBudgetAmount() {
  return useBudgetMutation<void>(() => sendJson<BudgetResponse>('DELETE', '/api/budget/amount'));
}

/** marca o desmarca un dia libre entre semana ('YYYY-MM-DD') */
export function useSetDayOff() {
  return useBudgetMutation((vars: { date: string; off: boolean }) =>
    sendJson<BudgetResponse>('PUT', '/api/budget/days-off', vars),
  );
}

export function useBudget(month: string, enabled = true) {
  return useQuery({
    queryKey: ['history', 'budget', month],
    queryFn: ({ signal }) =>
      getJson<BudgetResponse>(`/api/history/budget?month=${encodeURIComponent(month)}`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    enabled,
  });
}

export function useRanking(range: HistoryRange, enabled = true) {
  return useQuery({
    queryKey: ['history', 'ranking', range],
    queryFn: ({ signal }) =>
      getJson<RankingResponse>(`/api/history/ranking?range=${encodeURIComponent(range)}`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    enabled,
  });
}

/** filtros de la pestana Tareas y de la lista de turnos de una sala; los vacios no viajan */
export interface TaskQuery {
  q?: string;
  project?: string;
  room?: string;
  kind?: 'lead' | 'subagent' | '';
  outcome?: string;
  minUsd?: string;
  range?: HistoryRange | '';
}

export function taskQueryString(filters: TaskQuery, cursor: string | null): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === 'string' && value.trim() !== '') params.set(key, value.trim());
  }
  if (cursor) params.set('cursor', cursor);
  const text = params.toString();
  return text ? `/api/history/tasks?${text}` : '/api/history/tasks';
}

export function useTasks(enabled = true, filters: TaskQuery = {}) {
  return useInfiniteQuery({
    queryKey: ['history', 'tasks', filters],
    queryFn: ({ pageParam, signal }) => getJson<TasksResponse>(taskQueryString(filters, pageParam), signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export type HabitsRange = HabitsResponse['range'];
export type CompareRange = CompareResponse['range'];

/** En vivo se refresca mas seguido: son los hallazgos de lo que se ve en la oficina */
export function useHabits(range: HabitsRange, enabled = true) {
  return useQuery({
    queryKey: ['history', 'habits', range],
    queryFn: ({ signal }) => getJson<HabitsResponse>(`/api/habits?range=${encodeURIComponent(range)}`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: range === 'live' ? 15_000 : 60_000,
    enabled,
  });
}

const INBOX_KEY = ['history', 'habits', 'inbox'] as const;

/** Bandeja: alertas (criticas) y avisos vivos con el texto listo para pegar; mismo ritmo que En vivo */
export function useHabitsInbox(enabled = true) {
  return useQuery({
    queryKey: INBOX_KEY,
    queryFn: ({ signal }) => getJson<HabitsInboxResponse>('/api/habits/inbox', signal),
    refetchInterval: 15_000,
    enabled,
  });
}

/**
 * Las rutas de la bandeja responden la bandeja completa: se deja en cache al instante y se invalida el
 * historial, porque la lista En vivo ya no trae lo descartado
 */
function useInboxMutation<V>(request: (vars: V) => Promise<HabitsInboxResponse>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (data) => {
      client.setQueryData(INBOX_KEY, data);
      void client.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

/** descarta lo copiado hasta que salga algo nuevo */
export function useDismissInbox() {
  return useInboxMutation((vars: { level: InboxLevel; keys: string[] }) =>
    sendJson<HabitsInboxResponse>('POST', '/api/habits/inbox/dismiss', vars),
  );
}

/** deshacer: esas llaves vuelven a la lista */
export function useRestoreInbox() {
  return useInboxMutation((vars: { keys: string[] }) =>
    sendJson<HabitsInboxResponse>('POST', '/api/habits/inbox/restore', vars),
  );
}

export function useCosts(range: HistoryRange, enabled = true) {
  return useQuery({
    queryKey: ['history', 'costs', range],
    queryFn: ({ signal }) => getJson<CostsResponse>(`/api/history/costs?range=${encodeURIComponent(range)}`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    enabled,
  });
}

export function useCompare(range: CompareRange, enabled = true) {
  return useQuery({
    queryKey: ['history', 'compare', range],
    queryFn: ({ signal }) => getJson<CompareResponse>(`/api/history/compare?range=${encodeURIComponent(range)}`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    enabled,
  });
}

export function useSimulator(enabled = true) {
  return useQuery({
    queryKey: ['history', 'simulator'],
    queryFn: ({ signal }) => getJson<SimulatorResponse>('/api/history/simulator', signal),
    refetchInterval: 60_000,
    enabled,
  });
}

export function useRules(enabled = true) {
  return useQuery({
    queryKey: ['rules'],
    queryFn: ({ signal }) => getJson<RulesResponse>('/api/rules', signal),
    enabled,
  });
}

/**
 * Las rutas de reglas responden el RulesResponse completo: se deja en cache y se invalida el historial,
 * porque el simulador (presupuesto por workflow) y los hallazgos 'rule' dependen de los umbrales.
 */
function useRulesMutation<V>(request: (vars: V) => Promise<RulesResponse>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (data) => {
      client.setQueryData(['rules'], data);
      void client.invalidateQueries({ queryKey: ['history'] });
    },
  });
}

/** value null = volver al valor calibrado */
export function useUpdateRule() {
  return useRulesMutation((vars: { id: RuleId; value?: number | null; enabled?: boolean }) => {
    const { id, ...patch } = vars;
    return sendJson<RulesResponse>('PUT', `/api/rules/${encodeURIComponent(id)}`, patch);
  });
}

export function useSetRulesNotify() {
  return useRulesMutation((enabled: boolean) => sendJson<RulesResponse>('PUT', '/api/rules/notify', { enabled }));
}

export const TRANSCRIPT_REFRESH_MS = 5_000;

/**
 * Pagina 0 = lo mas reciente; nextCursor pide lo anterior.
 * Mientras el agente trabaja (y el panel esta abierto) se refresca cada 5 s.
 */
export function useTranscript(agentId: string, options: { enabled: boolean; live: boolean }) {
  return useInfiniteQuery({
    queryKey: ['transcript', agentId],
    queryFn: ({ pageParam, signal }) =>
      getJson<TranscriptResponse>(
        withCursor(`/api/agents/${encodeURIComponent(agentId)}/transcript`, pageParam),
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: options.enabled,
    refetchInterval: options.live ? TRANSCRIPT_REFRESH_MS : false,
    refetchIntervalInBackground: false,
  });
}

// ---- Paneles nuevos: precios, conciliacion, meses, sesiones, "y si", informe, linea de tiempo, archivos, salud ----

export function usePrices(enabled = true) {
  return useQuery({
    queryKey: ['prices'],
    queryFn: ({ signal }) => getJson<PricesResponse>('/api/prices', signal),
    enabled,
  });
}

/** un precio nuevo recotiza todo el historial: se invalida todo lo que muestre dinero */
function usePricesMutation<V>(request: (vars: V) => Promise<PricesResponse>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (data) => {
      client.setQueryData(['prices'], data);
      void client.invalidateQueries({ queryKey: ['history'] });
      void client.invalidateQueries({ queryKey: ['rules'] });
    },
  });
}

export function useSetPrice() {
  return usePricesMutation((vars: { model: string; price: PriceRates }) =>
    sendJson<PricesResponse>('PUT', `/api/prices/${encodeURIComponent(vars.model)}`, vars.price),
  );
}

export function useClearPrice() {
  return usePricesMutation((model: string) => sendJson<PricesResponse>('DELETE', `/api/prices/${encodeURIComponent(model)}`));
}

export function useReconcile(enabled = true) {
  return useQuery({
    queryKey: ['history', 'reconcile'],
    queryFn: ({ signal }) => getJson<ReconcileResponse>('/api/history/reconcile', signal),
    enabled,
  });
}

export function useMonths(enabled = true) {
  return useQuery({
    queryKey: ['history', 'months'],
    queryFn: ({ signal }) => getJson<MonthsResponse>('/api/history/months', signal),
    enabled,
  });
}

export function useSessions(range: HistoryRange, enabled = true) {
  return useQuery({
    queryKey: ['history', 'sessions', range],
    queryFn: ({ signal }) => getJson<SessionsResponse>(`/api/history/sessions?range=${encodeURIComponent(range)}`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    enabled,
  });
}

export function useWhatIf(range: WhatIfResponse['range'], enabled = true) {
  return useQuery({
    queryKey: ['history', 'whatif', range],
    queryFn: ({ signal }) => getJson<WhatIfResponse>(`/api/history/whatif?range=${encodeURIComponent(range)}`, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useReport(range: ReportResponse['range'], enabled = true) {
  return useQuery({
    queryKey: ['history', 'report', range],
    queryFn: ({ signal }) => getJson<ReportResponse>(`/api/history/report?range=${encodeURIComponent(range)}`, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** tope mensual de un proyecto; amountUsd null lo quita */
export function useSetProjectBudget() {
  return useBudgetMutation((vars: { project: string; amountUsd: number | null }) =>
    sendJson<BudgetResponse>('PUT', '/api/budget/projects', vars),
  );
}

export function useAgentActions(agentId: string, options: { enabled: boolean; live: boolean }) {
  return useInfiniteQuery({
    queryKey: ['agent-actions', agentId],
    queryFn: ({ pageParam, signal }) =>
      getJson<AgentActionsResponse>(withCursor(`/api/agents/${encodeURIComponent(agentId)}/actions`, pageParam), signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: options.enabled,
    refetchInterval: options.live ? TRANSCRIPT_REFRESH_MS : false,
    refetchIntervalInBackground: false,
  });
}

export function useRoomFiles(roomId: string, options: { enabled: boolean; live: boolean }) {
  return useQuery({
    queryKey: ['room-files', roomId],
    queryFn: ({ signal }) => getJson<RoomFilesResponse>(`/api/rooms/${encodeURIComponent(roomId)}/files`, signal),
    enabled: options.enabled,
    refetchInterval: options.live ? 15_000 : false,
  });
}

export function useIngestHealth(enabled = true) {
  return useQuery({
    queryKey: ['health', 'ingest'],
    queryFn: ({ signal }) => getJson<IngestHealth>('/api/health/ingest', signal),
    refetchInterval: 10_000,
    enabled,
  });
}

/** avisos del sistema y servidor en segundo plano; responde las reglas completas */
export function useSetSystem() {
  return useRulesMutation((vars: { notifyDesktop?: boolean; keepAlive?: boolean }) =>
    sendJson<RulesResponse>('PUT', '/api/settings/system', vars),
  );
}

export function useShutdown() {
  return useMutation({ mutationFn: () => sendJson<{ ok: boolean }>('POST', '/api/shutdown') });
}
