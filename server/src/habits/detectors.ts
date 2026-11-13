import type { HabitEvidence, HabitFinding, ModelFamily } from '@shared/contract';
import { baseName } from '../ingest/labels';
import { costUsd, resolvePrice, type Price, type UsageTokens } from '../ingest/pricing';
import * as copy from './copy';
import { WAIT_TOOLS } from './facts';
import type {
  ActionStatRow,
  AgentRow,
  CtxRow,
  DayCostRow,
  DiscardRow,
  ErrorGroupRow,
  EventRow,
  FileActionRow,
  LongOutputRow,
  PauseRow,
  RunCostRow,
  StreakRow,
  TailRow,
  UsageAggRow,
} from './facts';

// Detectores puros: reciben hechos ya agregados (facts.ts) y devuelven hallazgos sin datos de la sala.
// Tokens estimados = ceil(caracteres / 4) (se marcan estimated); precios reales de ingest/pricing.ts.

export const LIMITS = {
  repeatedReads: 3,
  repeatedReadsWarning: 5,
  fullReadLines: 400,
  fullReadChars: 40_000,
  fullReadWarning: 3,
  /** tramo razonable de una lectura parcial */
  readChunkLines: 200,
  bigContext: 150_000,
  hugeContext: 300_000,
  compactCalls: 30,
  compactRecent: 10,
  compactAvgCtx: 120_000,
  /** contexto que queda tras compactar (para estimar el ahorro) */
  compactTarget: 30_000,
  sameErrors: 3,
  expensiveActions: 8,
  expensiveLookupShare: 0.8,
  expensiveMaxEdits: 1,
  expensiveMinUsd: 0.2,
  lowCacheCalls: 10,
  lowCacheHit: 0.5,
  cachePauseMs: 5 * 60_000,
  expiredCalls: 3,
  longOutput: 8_000,
  longOutputKeep: 4_000,
  longOutputCount: 3,
  idleMs: 10 * 60_000,
  idleActions: 15,
  dupChars: 500,
  /** fallos seguidos para la alerta viva de errores */
  errorsInARow: 2,
} as const;

/** modelo de referencia para el ahorro de un subagente caro que solo lee */
export const CHEAPER_MODEL = 'claude-sonnet-5';

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const WAIT: ReadonlySet<string> = new Set(WAIT_TOOLS);
/** su trabajo es leer y juzgar: que casi solo lean no es un modelo mal elegido */
const JUDGE_ROLES: ReadonlySet<string> = new Set(['reviewer', 'planner', 'security']);

/** parte del ahorro que sale de un conjunto de llamadas de un agente (ver callClaim) */
export interface Claim {
  key: string;
  usd: number;
}

/** hallazgo sin los datos de la sala ni el nombre del agente (los pone el servicio) */
export interface Draft extends Omit<HabitFinding, 'roomTitle' | 'projectName' | 'agentName' | 'detectedAt' | 'live'> {
  /** ultimo dato que lo sostiene (epoch ms): sale como detectedAt */
  at: number;
  /**
   * llamadas que sostienen su ahorro: si dos tipos reclaman las mismas, los totales cuentan solo el mayor
   * (cada hallazgo conserva el suyo). Lo que no se reclama suma directo. No sale en la API.
   */
  claims?: readonly Claim[];
  /** archivos (ruta tal cual) o herramientas: al juntar hallazgos se cuentan los distintos. No sale en la API */
  subjects?: readonly string[];
}

export function familyOf(model: string | null | undefined): ModelFamily {
  const m = /^(?:claude-)?(fable|opus|sonnet|haiku)(?:-|$)/.exec(model ?? '');
  switch (m?.[1]) {
    case 'fable':
      return 'fable';
    case 'opus':
      return 'opus';
    case 'sonnet':
      return 'sonnet';
    case 'haiku':
      return 'haiku';
    default:
      return 'other';
  }
}

const FAMILY_LABEL: Readonly<Record<ModelFamily, string>> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  other: 'otro modelo',
};

const perToken = (usdPerMTok: number): number => usdPerMTok / 1_000_000;
const estTokens = (chars: number): number => Math.ceil(chars / 4);
/** redondeo a millonesimas: JSON estable sin perder ahorros chicos */
export const money = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

function priceOf(model: string | null): Price | null {
  return model ? (resolvePrice(model)?.price ?? null) : null;
}

/** agrupa conservando el orden de llegada */
export function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** suma de `tokens x precio` por modelo; null si ningun modelo tiene precio */
function pricedSum<T>(rows: readonly T[], model: (r: T) => string | null, usd: (r: T, p: Price) => number): number | null {
  let total: number | null = null;
  for (const r of rows) {
    const p = priceOf(model(r));
    if (p) total = (total ?? 0) + usd(r, p);
  }
  return total === null ? null : money(total);
}

// ---- Libro de agentes: fila + uso agregado de la ventana ----

export interface AgentStats {
  row: AgentRow;
  /** modelo con el que se estiman los ahorros: el del agente o el que mas llamadas tuvo */
  model: string | null;
  price: Price | null;
  usage: UsageAggRow[];
  calls: number;
  pricedCalls: number;
  /** solo lo que tiene precio */
  cost: number;
  tokens: UsageTokens;
  lastUsage: number | null;
}

export type AgentBook = Map<string, AgentStats>;

export function buildBook(agents: readonly AgentRow[], usage: readonly UsageAggRow[]): AgentBook {
  const byAgent = groupBy(usage, (u) => u.agent_id);
  const book: AgentBook = new Map();
  for (const row of agents) {
    const rows = byAgent.get(row.agent_id) ?? [];
    const tokens: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    let calls = 0;
    let unpriced = 0;
    let cost = 0;
    let last: number | null = null;
    let top: UsageAggRow | null = null;
    for (const u of rows) {
      tokens.input += u.input;
      tokens.output += u.output;
      tokens.cacheRead += u.cache_read;
      tokens.cacheWrite5m += u.cw5;
      tokens.cacheWrite1h += u.cw1h;
      calls += u.calls;
      unpriced += u.unpriced_calls;
      cost += u.cost;
      last = Math.max(last ?? u.last_ts, u.last_ts);
      if (!top || u.calls > top.calls) top = u;
    }
    const model = row.model ?? top?.model ?? null;
    book.set(row.agent_id, {
      row,
      model,
      price: priceOf(model),
      usage: rows,
      calls,
      pricedCalls: calls - unpriced,
      cost,
      tokens,
      lastUsage: last,
    });
  }
  return book;
}

function avgCallCost(a: AgentStats): number | null {
  return a.pricedCalls > 0 ? a.cost / a.pricedCalls : null;
}

function base(a: AgentStats): Pick<Draft, 'roomId' | 'agentId'> {
  return { roomId: a.row.session_id, agentId: a.row.agent_id };
}

function who(a: AgentStats): copy.Who {
  return { isLead: a.row.kind === 'lead', role: a.row.role };
}

// ---- Detectores ----

export function normPath(p: string): string {
  return p.trim().replace(/\\/g, '/').toLowerCase();
}

/**
 * llave de las llamadas repetidas de un agente: las lecturas de un archivo van por archivo (asi coinciden
 * repeated_read, full_read y un bucle o un error repetido de Read); lo demas, por herramienta + input
 */
function callClaim(agentId: string, tool: string, inputHash: string, target: string | null): string {
  return tool === 'Read' && target ? `read:${agentId}:${normPath(target)}` : `call:${agentId}:${tool}:${inputHash}`;
}

/** hay algun momento de `sorted` en (from, to] */
function anyBetween(sorted: readonly number[], from: number, to: number): boolean {
  const i = lowerBound(sorted, from + 1);
  const t = sorted[i];
  return t !== undefined && t <= to;
}

function editOk(a: FileActionRow): boolean {
  return EDIT_TOOLS.has(a.tool) && a.ended_at !== null && a.is_error === 0 && a.denied === null;
}

interface ReadRun {
  file: string;
  path: string;
  count: number;
  chars: Array<number | null>;
  last: number;
}

/**
 * Mismo agente, mismo archivo, 3+ lecturas sin una edicion exitosa del archivo entre medio, de cualquier
 * agente de la sesion (el lead que relee lo que edito un subagente hace bien). Una compactacion del agente
 * corta la racha (releer despues de /compact es lo correcto) y las lecturas parciales solo se juntan si piden
 * el mismo tramo (mismo input), porque leer por tramos es lo recomendado.
 */
export function repeatedReads(
  rows: readonly FileActionRow[],
  compacts: ReadonlyMap<string, readonly number[]>,
  book: AgentBook,
): Draft[] {
  const out: Draft[] = [];
  // sesion + archivo -> inicios de las ediciones exitosas, en orden
  const edits = new Map<string, number[]>();
  for (const r of rows) {
    const session = book.get(r.agent_id)?.row.session_id;
    if (session === undefined || !editOk(r)) continue;
    const key = `${session}\u0000${normPath(r.target)}`;
    const list = edits.get(key);
    if (list) list.push(r.started_at);
    else edits.set(key, [r.started_at]);
  }
  for (const list of edits.values()) list.sort((x, y) => x - y);

  for (const [agentId, list] of groupBy(rows, (r) => r.agent_id)) {
    const a = book.get(agentId);
    if (!a) continue;
    const cuts = compacts.get(agentId) ?? [];
    // archivo -> tramo pedido ('' = lectura completa) -> racha actual
    const open = new Map<string, Map<string, ReadRun>>();
    const flagged = new Map<string, { file: string; path: string; max: number; extraTokens: number; known: boolean; last: number }>();
    const close = (target: string): void => {
      for (const run of open.get(target)?.values() ?? []) {
        if (run.count < LIMITS.repeatedReads) continue;
        const f = flagged.get(target) ?? { file: run.file, path: run.path, max: 0, extraTokens: 0, known: false, last: 0 };
        f.max = Math.max(f.max, run.count);
        f.last = Math.max(f.last, run.last);
        for (const c of run.chars.slice(1)) {
          if (c === null) continue;
          f.extraTokens += estTokens(c);
          f.known = true;
        }
        flagged.set(target, f);
      }
      open.delete(target);
    };
    let cut = 0;
    for (const act of list) {
      while (cut < cuts.length && (cuts[cut] ?? Infinity) <= act.started_at) {
        for (const t of [...open.keys()]) close(t);
        cut++;
      }
      const target = normPath(act.target);
      if (act.tool !== 'Read') {
        if (editOk(act)) close(target);
        continue;
      }
      if (act.is_error === 1) continue;
      const prev = open.get(target);
      if (prev) {
        const last = Math.max(...[...prev.values()].map((r) => r.last));
        const sessionEdits = edits.get(`${a.row.session_id}\u0000${target}`);
        if (sessionEdits && anyBetween(sessionEdits, last, act.started_at)) close(target);
      }
      const span = act.read_partial === 1 ? (act.input_hash ?? `t${act.started_at}`) : '';
      let runs = open.get(target);
      if (!runs) {
        runs = new Map();
        open.set(target, runs);
      }
      const run = runs.get(span) ?? { file: baseName(act.target), path: act.target, count: 0, chars: [], last: 0 };
      run.count++;
      run.chars.push(act.result_chars);
      run.last = act.started_at;
      runs.set(span, run);
    }
    for (const t of [...open.keys()]) close(t);

    for (const [target, f] of flagged) {
      const evidence: HabitEvidence[] = [{ label: 'Lecturas sin editar', value: f.max, unit: 'count' }];
      if (f.known) evidence.push({ label: 'Tokens releídos', value: f.extraTokens, unit: 'tokens', estimated: true });
      const savingsUsd = a.price && f.known ? money(f.extraTokens * perToken(a.price.cacheWrite5m)) : null;
      out.push({
        id: `repeated_read:${agentId}:${target}`,
        kind: 'repeated_read',
        severity: f.max >= LIMITS.repeatedReadsWarning ? 'warning' : 'info',
        ...base(a),
        ...copy.repeatedReadCopy(f.file, f.max, who(a)),
        evidence,
        savingsUsd,
        at: f.last,
        claims: savingsUsd !== null ? [{ key: `read:${agentId}:${target}`, usd: savingsUsd }] : [],
        subjects: [f.path],
      });
    }
  }
  return out;
}

/** Read sin offset/limit de un archivo largo (> 400 lineas, o > 40.000 caracteres si no se sabe) */
export function fullReads(rows: readonly FileActionRow[], book: AgentBook): Draft[] {
  const out: Draft[] = [];
  const long = rows.filter(
    (r) =>
      r.tool === 'Read' &&
      r.read_partial === 0 &&
      r.is_error === 0 &&
      ((r.result_lines ?? 0) > LIMITS.fullReadLines ||
        (r.result_lines === null && (r.result_chars ?? 0) > LIMITS.fullReadChars)),
  );
  for (const [agentId, list] of groupBy(long, (r) => r.agent_id)) {
    const a = book.get(agentId);
    if (!a) continue;
    const files = [...new Set(list.map((r) => baseName(r.target)))];
    let maxLines: number | null = null;
    let tokens = 0;
    let saved = 0;
    // tokens de sobra por archivo: cada archivo reclama sus propias lecturas
    const savedBy = new Map<string, number>();
    for (const r of list) {
      const t = estTokens(r.result_chars ?? 0);
      tokens += t;
      if (r.result_lines !== null) {
        maxLines = Math.max(maxLines ?? 0, r.result_lines);
        const s = t * (1 - LIMITS.readChunkLines / r.result_lines);
        saved += s;
        const key = normPath(r.target);
        savedBy.set(key, (savedBy.get(key) ?? 0) + s);
      }
    }
    const evidence: HabitEvidence[] = [{ label: 'Lecturas completas', value: list.length, unit: 'count' }];
    if (maxLines !== null) evidence.push({ label: 'Archivo más largo', value: maxLines, unit: 'lines' });
    evidence.push({ label: 'Tokens leídos', value: tokens, unit: 'tokens', estimated: true });
    const price = a.price;
    out.push({
      id: `full_read:${agentId}`,
      kind: 'full_read',
      severity: list.length >= LIMITS.fullReadWarning ? 'warning' : 'info',
      ...base(a),
      ...copy.fullReadCopy(files, list.length, maxLines, who(a)),
      evidence,
      savingsUsd: price && maxLines !== null ? money(saved * perToken(price.cacheWrite5m)) : null,
      at: Math.max(...list.map((r) => r.started_at)),
      claims: price
        ? [...savedBy].map(([file, s]) => ({ key: `read:${agentId}:${file}`, usd: s * perToken(price.cacheWrite5m) }))
        : [],
      subjects: [...new Set(list.map((r) => r.target))],
    });
  }
  return out;
}

/** contexto por llamada (input + cache) sobre 150 k: warning; sobre 300 k: critical */
export function bigContexts(book: AgentBook): Draft[] {
  const out: Draft[] = [];
  for (const a of book.values()) {
    const over = a.usage.filter((u) => u.over_calls > 0);
    if (over.length === 0) continue;
    const maxCtx = Math.max(...over.map((u) => u.max_ctx));
    const overCalls = over.reduce((s, u) => s + u.over_calls, 0);
    out.push({
      id: `big_context:${a.row.agent_id}`,
      kind: 'big_context',
      severity: maxCtx > LIMITS.hugeContext ? 'critical' : 'warning',
      ...base(a),
      ...copy.bigContextCopy(maxCtx, a.row.kind === 'lead'),
      evidence: [
        { label: 'Contexto máximo', value: maxCtx, unit: 'tokens' },
        { label: 'Llamadas sobre 150 k', value: overCalls, unit: 'count' },
      ],
      savingsUsd: pricedSum(over, (u) => u.model, (u, p) => u.over_ctx * perToken(p.cacheRead)),
      at: Math.max(...over.map((u) => u.last_ts)),
    });
  }
  return out;
}

export interface LeadCompactState {
  sessionId: string;
  /** la sesion sigue abierta: en una cerrada no hay nada que compactar ni un ahorro por venir */
  open: boolean;
  /** llamadas del lead desde su ultima compactacion */
  calls: number;
  /** contexto de las ultimas llamadas, la mas reciente primero */
  recent: readonly CtxRow[];
}

/** lead de una sesion abierta con 30+ llamadas desde la ultima compactacion y contexto promedio reciente > 120 k */
export function needsCompact(leads: readonly LeadCompactState[]): Draft[] {
  const out: Draft[] = [];
  for (const l of leads) {
    const recent = l.recent.slice(0, LIMITS.compactRecent);
    const last = recent[0];
    if (!l.open || l.calls < LIMITS.compactCalls || !last) continue;
    const avg = Math.round(recent.reduce((s, r) => s + r.ctx, 0) / recent.length);
    if (avg <= LIMITS.compactAvgCtx) continue;
    const price = priceOf(last.model);
    out.push({
      id: `needs_compact:${l.sessionId}`,
      kind: 'needs_compact',
      severity: 'warning',
      roomId: l.sessionId,
      agentId: l.sessionId,
      ...copy.needsCompactCopy(l.calls, avg),
      evidence: [
        { label: 'Llamadas desde la última compactación', value: l.calls, unit: 'count' },
        { label: 'Contexto promedio reciente', value: avg, unit: 'tokens' },
      ],
      // lo que se dejaria de releer en las proximas 10 llamadas
      savingsUsd: price
        ? money(LIMITS.compactRecent * Math.max(0, avg - LIMITS.compactTarget) * perToken(price.cacheRead))
        : null,
      at: last.ts,
    });
  }
  return out;
}

/**
 * Racha maxima de acciones identicas (misma herramienta + mismo input) >= umbral de la regla
 * loop_repeats. Con la regla encendida el hallazgo es critico y lleva su ruleId (no se repite como 'rule').
 * Las herramientas de espera (BashOutput, TaskOutput, Monitor) se repiten a proposito y no cuentan.
 */
export function loops(streaks: readonly StreakRow[], book: AgentBook, threshold: number, ruleOn: boolean): Draft[] {
  const out: Draft[] = [];
  for (const [agentId, list] of groupBy(streaks.filter((s) => !WAIT.has(s.tool)), (s) => s.agent_id)) {
    const a = book.get(agentId);
    if (!a) continue;
    const best = list.reduce((b, s) => (s.n > b.n || (s.n === b.n && s.last_ts > b.last_ts) ? s : b));
    if (best.n < threshold) continue;
    const avg = avgCallCost(a);
    const savingsUsd = avg !== null ? money((best.n - 1) * avg) : null;
    out.push({
      id: `loop:${agentId}`,
      kind: 'loop',
      ...(ruleOn ? { ruleId: 'loop_repeats' as const } : {}),
      severity: ruleOn ? 'critical' : 'warning',
      ...base(a),
      ...copy.loopCopy(best.tool, best.n, who(a)),
      evidence: [
        { label: 'Repeticiones seguidas', value: best.n, unit: 'count' },
        { label: 'Umbral', value: threshold, unit: 'count' },
      ],
      savingsUsd,
      at: best.last_ts,
      claims: savingsUsd !== null ? [{ key: callClaim(agentId, best.tool, best.input_hash, best.target), usd: savingsUsd }] : [],
      subjects: [best.tool],
    });
  }
  return out;
}

/** la misma herramienta fallo 3+ veces con el mismo error (sin contar rechazos del usuario) */
export function sameErrors(groups: readonly ErrorGroupRow[], book: AgentBook): Draft[] {
  const out: Draft[] = [];
  for (const g of groups) {
    const a = book.get(g.agent_id);
    if (!a || g.n < LIMITS.sameErrors) continue;
    const avg = avgCallCost(a);
    const savingsUsd = avg !== null ? money((g.n - 1) * avg) : null;
    // con un solo input es la misma llamada repetida: la reclama igual que un bucle de esa llamada
    const claim = g.inputs === 1 && g.input_hash !== null ? callClaim(g.agent_id, g.tool, g.input_hash, g.target) : null;
    out.push({
      id: `same_error:${g.agent_id}:${g.tool}:${g.result_hash}`,
      kind: 'same_error',
      severity: 'warning',
      ...base(a),
      ...copy.sameErrorCopy(g.tool, g.n, who(a)),
      evidence: [{ label: 'Fallos con el mismo error', value: g.n, unit: 'count' }],
      savingsUsd,
      at: g.last_ts,
      claims: savingsUsd !== null && claim !== null ? [{ key: claim, usd: savingsUsd }] : [],
      subjects: [g.tool],
    });
  }
  return out;
}

/**
 * subagente en Fable/Opus que casi solo lee y busca: el ahorro es su costo con precios de Sonnet 5. Los de
 * revision, planificacion y seguridad (y el tipo Plan) no cuentan: leer y juzgar es su trabajo.
 */
export function expensiveModels(stats: readonly ActionStatRow[], book: AgentBook): Draft[] {
  const out: Draft[] = [];
  for (const s of stats) {
    const a = book.get(s.agent_id);
    if (!a || a.row.kind !== 'subagent') continue;
    if (JUDGE_ROLES.has(a.row.role ?? '') || a.row.agent_type === 'Plan') continue;
    const family = familyOf(a.model);
    if (family !== 'fable' && family !== 'opus') continue;
    const share = s.n > 0 ? s.lookups / s.n : 0;
    if (
      s.n < LIMITS.expensiveActions ||
      share < LIMITS.expensiveLookupShare ||
      s.edits > LIMITS.expensiveMaxEdits ||
      a.cost < LIMITS.expensiveMinUsd
    ) {
      continue;
    }
    const cheaper = costUsd(CHEAPER_MODEL, a.tokens);
    out.push({
      id: `expensive_model:${s.agent_id}`,
      kind: 'expensive_model',
      severity: 'warning',
      ...base(a),
      ...copy.expensiveModelCopy(FAMILY_LABEL[family], share),
      evidence: [
        { label: 'Acciones', value: s.n, unit: 'count' },
        { label: 'Lectura y búsqueda', value: share, unit: 'pct' },
        { label: 'Costo del agente', value: money(a.cost), unit: 'usd' },
      ],
      savingsUsd: cheaper !== null && a.pricedCalls === a.calls ? money(Math.max(0, a.cost - cheaper)) : null,
      at: Math.max(s.last_ts, a.lastUsage ?? 0),
    });
  }
  return out;
}

/**
 * Poca cache: 10+ llamadas con aciertos < 50 % (cache_read / todo el input), o 3+ llamadas tras una
 * pausa de mas de 5 min que reescribieron mas de la mitad del contexto (cache vencida).
 */
export function lowCache(book: AgentBook, pauses: readonly PauseRow[]): Draft[] {
  const out: Draft[] = [];
  const pausesBy = groupBy(pauses, (p) => p.agent_id);
  for (const a of book.values()) {
    const t = a.tokens;
    const write = t.cacheWrite5m + t.cacheWrite1h;
    const denom = t.input + t.cacheRead + write;
    const hit = denom > 0 ? t.cacheRead / denom : null;
    const low = a.calls >= LIMITS.lowCacheCalls && hit !== null && hit < LIMITS.lowCacheHit;
    const expiredRows = pausesBy.get(a.row.agent_id) ?? [];
    const expired = expiredRows.reduce((s, p) => s + p.n, 0);
    if (!low && expired < LIMITS.expiredCalls) continue;
    const evidence: HabitEvidence[] = [];
    if (hit !== null) evidence.push({ label: 'Aciertos de cache', value: hit, unit: 'pct' });
    if (expired > 0) evidence.push({ label: 'Llamadas tras pausas de más de 5 min', value: expired, unit: 'count' });
    const savingsUsd = low
      ? pricedSum(a.usage, (u) => u.model, (u, p) => (u.cw5 + u.cw1h) * perToken(p.cacheWrite5m - p.cacheRead))
      : pricedSum(expiredRows, (r) => r.model, (r, p) => r.cache_write * perToken(p.cacheWrite5m - p.cacheRead));
    out.push({
      id: `low_cache:${a.row.agent_id}`,
      kind: 'low_cache',
      severity: 'warning',
      ...base(a),
      ...copy.lowCacheCopy(low ? hit : null, expired, who(a)),
      evidence,
      savingsUsd,
      at: low ? (a.lastUsage ?? 0) : Math.max(...expiredRows.map((r) => r.last_ts)),
    });
  }
  return out;
}

/**
 * 3+ llamadas de mas de 8 k tokens de salida sin editar un archivo ni lanzar un encargo o un flujo en esa
 * misma respuesta. La salida incluye el razonamiento, que no se puede separar
 */
export function longOutputs(rows: readonly LongOutputRow[], book: AgentBook): Draft[] {
  const out: Draft[] = [];
  for (const [agentId, list] of groupBy(rows, (r) => r.agent_id)) {
    const a = book.get(agentId);
    const n = list.reduce((s, r) => s + r.n, 0);
    if (!a || n < LIMITS.longOutputCount) continue;
    out.push({
      id: `long_output:${agentId}`,
      kind: 'long_output',
      severity: 'info',
      ...base(a),
      ...copy.longOutputCopy(n, who(a)),
      evidence: [
        { label: 'Respuestas largas', value: n, unit: 'count' },
        { label: 'Salida de sobra', value: list.reduce((s, r) => s + r.extra, 0), unit: 'tokens' },
      ],
      savingsUsd: pricedSum(list, (r) => r.model, (r, p) => r.extra * perToken(p.output)),
      at: Math.max(...list.map((r) => r.last_ts)),
    });
  }
  return out;
}

/** agente de Desarrollo con 10+ min y 15+ acciones sin ninguna edicion exitosa */
export function idleNoChanges(stats: readonly ActionStatRow[], book: AgentBook): Draft[] {
  const out: Draft[] = [];
  for (const s of stats) {
    const a = book.get(s.agent_id);
    if (!a || a.row.kind !== 'subagent') continue;
    if (a.row.role !== 'builder' && a.row.agent_type !== 'tr-builder') continue;
    const start = a.row.started_at;
    const end = a.row.ended_at ?? a.row.last_activity_at;
    if (start === null || end === null || end - start < LIMITS.idleMs) continue;
    if (s.n < LIMITS.idleActions || s.edits > 0) continue;
    const minutes = Math.floor((end - start) / 60_000);
    const family = familyOf(a.model);
    out.push({
      id: `idle_no_changes:${s.agent_id}`,
      kind: 'idle_no_changes',
      severity: 'warning',
      ...base(a),
      ...copy.idleCopy(minutes, s.n, { label: FAMILY_LABEL[family], expensive: family === 'fable' || family === 'opus' }),
      evidence: [
        { label: 'Tiempo trabajando', value: minutes, unit: 'minutes' },
        { label: 'Acciones', value: s.n, unit: 'count' },
        { label: 'Ediciones', value: 0, unit: 'count' },
      ],
      savingsUsd: null,
      at: end,
    });
  }
  return out;
}

function record(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function parseData(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return record(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** servidores MCP cargados en la sesion sin ninguna herramienta `mcp__<server>__*` usada */
export function mcpUnused(events: readonly EventRow[], used: ReadonlyMap<string, ReadonlySet<string>>): Draft[] {
  const out: Draft[] = [];
  const loaded = events.filter((e) => e.kind === 'mcp_loaded');
  for (const [sessionId, list] of groupBy(loaded, (e) => e.session_id)) {
    const tools = new Map<string, number>();
    for (const e of list) {
      const servers = parseData(e.data).servers;
      if (!Array.isArray(servers)) continue;
      for (const s of servers) {
        const { name, tools: n } = record(s);
        if (typeof name !== 'string' || name.length === 0) continue;
        tools.set(name, Math.max(tools.get(name) ?? 0, typeof n === 'number' ? n : 0));
      }
    }
    const usedHere = used.get(sessionId);
    const unused = [...tools.keys()].filter((name) => !usedHere?.has(name)).sort();
    if (unused.length === 0) continue;
    out.push({
      id: `mcp_unused:${sessionId}`,
      kind: 'mcp_unused',
      severity: 'info',
      roomId: sessionId,
      agentId: null,
      ...copy.mcpUnusedCopy(unused),
      evidence: [
        { label: 'Servidores sin uso', value: unused.length, unit: 'count' },
        { label: 'Herramientas cargadas', value: unused.reduce((s, name) => s + (tools.get(name) ?? 0), 0), unit: 'count' },
      ],
      savingsUsd: null,
      at: Math.max(...list.map((e) => e.ts)),
    });
  }
  return out;
}

/** servidor de una herramienta `mcp__<server>__<tool>`; null si no es MCP */
export function mcpServerOf(tool: string): string | null {
  return /^mcp__(.+?)__/.exec(tool)?.[1] ?? null;
}

/** texto repetido (500+ caracteres) entre las instrucciones cargadas; se paga en cada llamada de la sesion */
export function dupInstructions(events: readonly EventRow[], book: AgentBook): Draft[] {
  const out: Draft[] = [];
  const usageBySession = groupBy(
    [...book.values()].flatMap((a) => a.usage.map((u) => ({ session: a.row.session_id, u }))),
    (x) => x.session,
  );
  const loads = events.filter((e) => e.kind === 'instructions');
  for (const [sessionId, list] of groupBy(loads, (e) => e.session_id)) {
    let top: { dup: number; files: string[]; ts: number } | null = null;
    for (const e of list) {
      const d = parseData(e.data);
      const dup = typeof d.dupChars === 'number' ? d.dupChars : 0;
      if (top && dup <= top.dup) continue;
      const files = Array.isArray(d.files)
        ? d.files.map((f) => record(f).name).filter((n): n is string => typeof n === 'string' && n.length > 0)
        : [];
      top = { dup, files: [...new Set(files)], ts: e.ts };
    }
    if (!top || top.dup < LIMITS.dupChars) continue;
    const dupTokens = estTokens(top.dup);
    const usage = (usageBySession.get(sessionId) ?? []).map((x) => x.u);
    const calls = usage.reduce((s, u) => s + u.calls, 0);
    out.push({
      id: `dup_instructions:${sessionId}`,
      kind: 'dup_instructions',
      severity: 'info',
      roomId: sessionId,
      agentId: null,
      ...copy.dupInstructionsCopy(dupTokens, top.files),
      evidence: [
        { label: 'Texto repetido', value: top.dup, unit: 'chars' },
        { label: 'Tokens repetidos por llamada', value: dupTokens, unit: 'tokens', estimated: true },
        { label: 'Llamadas de la sesión', value: calls, unit: 'count' },
      ],
      savingsUsd: pricedSum(usage, (u) => u.model, (u, p) => dupTokens * u.calls * perToken(p.cacheRead)),
      at: top.ts,
    });
  }
  return out;
}

/** agentes failed/killed/stopped + intentos de workflow reemplazados, por sesion */
export function discarded(rows: readonly DiscardRow[]): Draft[] {
  const out: Draft[] = [];
  for (const [sessionId, list] of groupBy(rows, (r) => r.session_id)) {
    const cost = money(list.reduce((s, r) => s + r.cost, 0));
    const retries = list.filter((r) => r.reason === 'retry').length;
    const evidence: HabitEvidence[] = [
      { label: 'Agentes descartados', value: list.length, unit: 'count' },
      { label: 'Costo descartado', value: cost, unit: 'usd' },
    ];
    if (retries > 0) evidence.push({ label: 'Reintentos de flujo', value: retries, unit: 'count' });
    out.push({
      id: `discarded:${sessionId}`,
      kind: 'discarded',
      severity: 'warning',
      roomId: sessionId,
      agentId: null,
      ...copy.discardedCopy(list.length, cost),
      evidence,
      savingsUsd: cost,
      at: Math.max(...list.map((r) => r.at)),
    });
  }
  return out;
}

// ---- Reglas (kind 'rule', siempre criticas) ----

/**
 * subagente con costo mayor que el tope. Se mide con el costo de toda su vida (`lifeCosts`), igual que la
 * alerta viva: uno que cruza el inicio de la ventana no mide distinto en los dos lados
 */
export function agentCostRule(book: AgentBook, limit: number, lifeCosts: ReadonlyMap<string, number>): Draft[] {
  const out: Draft[] = [];
  for (const a of book.values()) {
    if (a.row.kind !== 'subagent') continue;
    const cost = lifeCosts.get(a.row.agent_id) ?? a.cost;
    if (cost <= limit) continue;
    out.push({
      id: `rule:agent_cost:${a.row.agent_id}`,
      kind: 'rule',
      ruleId: 'agent_cost',
      severity: 'critical',
      ...base(a),
      ...copy.agentCostCopy(cost, limit),
      evidence: [
        { label: 'Costo del agente', value: money(cost), unit: 'usd' },
        { label: 'Tope', value: limit, unit: 'usd' },
      ],
      savingsUsd: null,
      at: a.lastUsage ?? a.row.last_activity_at ?? 0,
    });
  }
  return out;
}

/** 'YYYY-MM-DD' -> 'DD/MM' */
function dayLabel(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[2]}/${m[1]}` : day;
}

/** sesion que gasto mas que el tope en un dia (hora local) */
export function sessionDayCostRule(rows: readonly DayCostRow[], limit: number): Draft[] {
  return rows
    .filter((r) => r.cost > limit)
    .map((r): Draft => ({
      id: `rule:session_day_cost:${r.session_id}:${r.day}`,
      kind: 'rule',
      ruleId: 'session_day_cost',
      severity: 'critical',
      roomId: r.session_id,
      agentId: null,
      ...copy.sessionDayCostCopy(r.cost, limit, dayLabel(r.day)),
      evidence: [
        { label: 'Costo del día', value: money(r.cost), unit: 'usd' },
        { label: 'Tope', value: limit, unit: 'usd' },
      ],
      savingsUsd: null,
      at: r.last_ts,
    }));
}

/** corrida de Workflow (en curso o con actividad en la ventana) que costo mas que el tope */
export function workflowCostRule(runs: readonly RunCostRow[], limit: number, since: number): Draft[] {
  return runs
    .filter((r) => (r.running === 1 || (r.last_ts ?? 0) >= since) && r.cost > limit)
    .map((r): Draft => ({
      id: `rule:workflow_cost:${r.run_id}`,
      kind: 'rule',
      ruleId: 'workflow_cost',
      severity: 'critical',
      roomId: r.session_id,
      agentId: null,
      ...copy.workflowCostCopy(r.cost, limit, r.name),
      evidence: [
        { label: 'Costo de la corrida', value: money(r.cost), unit: 'usd' },
        { label: 'Tope', value: limit, unit: 'usd' },
      ],
      savingsUsd: null,
      at: r.last_ts ?? 0,
    }));
}

/** turno del lead: prompt -> fin (null = sigue abierto) */
export interface TurnSpan {
  start: number;
  end: number | null;
}

/** tramos de turnos entre compactaciones (ambas listas en orden); los tramos vacios no salen */
export function turnSegments(turns: readonly TurnSpan[], compacts: readonly number[]): TurnSpan[][] {
  const out: TurnSpan[][] = [];
  let cur: TurnSpan[] = [];
  let c = 0;
  for (const t of turns) {
    let cut = false;
    while (c < compacts.length && (compacts[c] ?? Infinity) <= t.start) {
      cut = true;
      c++;
    }
    if (cut && cur.length > 0) {
      out.push(cur);
      cur = [];
    }
    cur.push(t);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** turnos que empezaron despues de la ultima compactacion */
export function turnsSinceCompact(turns: readonly TurnSpan[], compacts: readonly number[]): number {
  const last = compacts.length > 0 ? Math.max(...compacts) : -Infinity;
  return turns.filter((t) => t.start > last).length;
}

/** primer indice con arr[i] >= x (arr en orden) */
function lowerBound(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] ?? Infinity) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** subagentes lanzados dentro de cada turno (launches en orden) */
export function launchesPerTurn(turns: readonly TurnSpan[], launches: readonly number[]): number[] {
  return turns.map((t) => {
    const from = lowerBound(launches, t.start);
    const to = t.end === null ? launches.length : lowerBound(launches, t.end + 1);
    return Math.max(0, to - from);
  });
}

/** sesion con un tramo de N+ turnos sin compactar que toca la ventana */
export function turnsWithoutCompactRule(
  turns: ReadonlyMap<string, readonly TurnSpan[]>,
  compacts: ReadonlyMap<string, readonly number[]>,
  since: number,
  limit: number,
): Draft[] {
  const out: Draft[] = [];
  for (const [sessionId, list] of turns) {
    let worst: TurnSpan[] | null = null;
    for (const seg of turnSegments(list, compacts.get(sessionId) ?? [])) {
      if (!seg.some((t) => t.start >= since || t.end === null)) continue;
      if (!worst || seg.length > worst.length) worst = seg;
    }
    if (!worst || worst.length < limit) continue;
    out.push({
      id: `rule:turns_without_compact:${sessionId}`,
      kind: 'rule',
      ruleId: 'turns_without_compact',
      severity: 'critical',
      roomId: sessionId,
      agentId: sessionId,
      ...copy.turnsWithoutCompactCopy(worst.length),
      evidence: [
        { label: 'Turnos sin compactar', value: worst.length, unit: 'count' },
        { label: 'Tope', value: limit, unit: 'count' },
      ],
      savingsUsd: null,
      at: worst[worst.length - 1]?.start ?? 0,
    });
  }
  return out;
}

/** sesion con algun turno del lead que lanzo mas subagentes que el tope */
export function subagentsPerTurnRule(
  turns: ReadonlyMap<string, readonly TurnSpan[]>,
  launches: ReadonlyMap<string, readonly number[]>,
  since: number,
  limit: number,
): Draft[] {
  const out: Draft[] = [];
  for (const [sessionId, list] of turns) {
    const inWindow = list.filter((t) => t.start >= since || t.end === null);
    const counts = launchesPerTurn(inWindow, launches.get(sessionId) ?? []);
    const max = Math.max(0, ...counts);
    if (max <= limit) continue;
    const at = inWindow[counts.indexOf(max)]?.start ?? 0;
    out.push({
      id: `rule:subagents_per_turn:${sessionId}`,
      kind: 'rule',
      ruleId: 'subagents_per_turn',
      severity: 'critical',
      roomId: sessionId,
      agentId: sessionId,
      ...copy.subagentsPerTurnCopy(max, limit),
      evidence: [
        { label: 'Subagentes en un turno', value: max, unit: 'count' },
        { label: 'Turnos sobre el tope', value: counts.filter((n) => n > limit).length, unit: 'count' },
        { label: 'Tope', value: limit, unit: 'count' },
      ],
      savingsUsd: null,
      at,
    });
  }
  return out;
}

// ---- Rachas al final (alertas vivas) ----

/**
 * la ultima accion y cuantas seguidas la repiten (misma herramienta + input), la mas reciente primero. Esperar
 * a un proceso en segundo plano (BashOutput, TaskOutput, Monitor) no es un bucle
 */
export function tailRepeat(tail: readonly TailRow[]): { tool: string; n: number } | null {
  const first = tail[0];
  if (!first || first.input_hash === null || WAIT.has(first.tool)) return null;
  let n = 0;
  for (const a of tail) {
    if (a.tool !== first.tool || a.input_hash !== first.input_hash) break;
    n++;
  }
  return { tool: first.tool, n };
}

/** fallos seguidos al final (sin rechazos del usuario); las acciones aun abiertas no cortan la racha */
export function tailErrors(tail: readonly TailRow[]): number {
  let n = 0;
  let i = 0;
  while (i < tail.length && tail[i]?.ended_at === null) i++;
  for (; i < tail.length; i++) {
    const a = tail[i];
    if (!a || a.is_error !== 1 || a.denied !== null) break;
    n++;
  }
  return n;
}
