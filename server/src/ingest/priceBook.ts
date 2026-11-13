import { createHash } from 'node:crypto';
import type { PriceRow, PricesResponse } from '@shared/contract';
import type { Db } from '../db/connection';
import {
  baseModelId,
  findPrice,
  quote,
  resolvePrice,
  setPriceBook,
  tablePrices,
  usdWith,
  type FlatPrice,
  type UsageTokens,
} from './pricing';

/** precios que fijo el usuario: { modeloBase: FlatPrice } (tabla settings; no se reconstruye) */
const OVERRIDES_KEY = 'price_overrides';
/** huella de los precios con los que se cotizo la tabla usage por ultima vez */
const HASH_KEY = 'pricing_hash';
/** prefijo de las filas de usage que salen del cost-state (gasto que no esta en los transcripts) */
export const HIDDEN_PREFIX = 'cs:';
/** margen para decir que un precio de la tabla reproduce el costo que calculo Claude Code */
const LEARN_TOLERANCE = 0.01;
/** por debajo de esto el redondeo pesa mas que el precio */
const LEARN_MIN_USD = 0.01;
/** tope de cada tarifa que escribe el usuario (USD por millon de tokens) */
export const PRICE_MAX = 10_000;

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

const RATE_KEYS = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const;

/** las cinco tarifas, todas numeros entre 0 y PRICE_MAX; null si falta alguna o no es valida */
export function parseFlatPrice(v: unknown): FlatPrice | null {
  if (!isRecord(v)) return null;
  const out: Partial<FlatPrice> = {};
  for (const k of RATE_KEYS) {
    const n = v[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > PRICE_MAX) return null;
    out[k] = n;
  }
  return out as FlatPrice;
}

/** uso de un modelo dentro del cost-state de Claude Code */
function costStateTokens(u: Rec): UsageTokens {
  const total = num(u.cacheCreationInputTokens);
  const e5 = num(u.cacheCreationEphemeral5mInputTokens);
  const e1 = num(u.cacheCreationEphemeral1hInputTokens);
  return {
    input: Math.round(num(u.inputTokens)),
    output: Math.round(num(u.outputTokens)),
    cacheRead: Math.round(num(u.cacheReadInputTokens)),
    cacheWrite5m: Math.round(e5 + Math.max(0, total - (e5 + e1))),
    cacheWrite1h: Math.round(e1),
  };
}

interface CostState {
  at: number | null;
  unknownCost: boolean;
  models: Array<{ model: string; tokens: UsageTokens; costUsd: number }>;
}

function parseCostState(json: string | null): CostState | null {
  if (!json) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(v) || !isRecord(v.modelUsage)) return null;
  const models: CostState['models'] = [];
  for (const [model, u] of Object.entries(v.modelUsage)) {
    if (!isRecord(u)) continue;
    models.push({ model, tokens: costStateTokens(u), costUsd: num(u.costUSD) });
  }
  return { at: typeof v.at === 'number' ? v.at : null, unknownCost: v.unknownCost === true, models };
}

interface UsageRow {
  message_id: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  speed: string | null;
  cost_usd: number | null;
  cost_est: number;
}

/**
 * Precios con los que se cotiza todo: carga los del usuario y los aprendidos, recotiza la tabla usage cuando
 * cambian (sin releer transcripts) y suma como filas propias el gasto que Claude Code hace por debajo y no
 * escribe en los transcripts (su cost-state lo trae por modelo).
 */
export class PriceBook {
  private custom = new Map<string, FlatPrice>();
  private learned = new Map<string, { key: string; at: number }>();
  /** un precio cambio y la tabla usage todavia no se recotizo */
  private dirty = false;

  private readonly getSetting;
  private readonly putSetting;
  private readonly learnedRows;
  private readonly putLearned;
  private readonly usageRows;
  private readonly setCost;
  private readonly costState;
  private readonly costStateSessions;
  private readonly hasReal;
  private readonly putHidden;
  private readonly delHidden;
  private readonly hiddenModels;
  private readonly seenModels;

  constructor(private readonly db: Db) {
    this.getSetting = db.prepare<[string], { value: string }>(`SELECT value FROM settings WHERE key = ?`);
    this.putSetting = db.prepare<[string, string]>(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    this.learnedRows = db.prepare<[], { model: string; price_key: string; at: number }>(
      `SELECT model, price_key, at FROM learned_prices`,
    );
    this.putLearned = db.prepare<[string, string, number, string]>(`
      INSERT INTO learned_prices (model, price_key, at, session_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET price_key = excluded.price_key, at = excluded.at, session_id = excluded.session_id`);
    this.usageRows = db.prepare<[], UsageRow>(`
      SELECT message_id, model, input, output, cache_read, cache_write_5m, cache_write_1h, speed, cost_usd, cost_est
      FROM usage WHERE message_id NOT LIKE '${HIDDEN_PREFIX}%'`);
    this.setCost = db.prepare<[number | null, number, string]>(
      `UPDATE usage SET cost_usd = ?, cost_est = ? WHERE message_id = ?`,
    );
    this.costState = db.prepare<[string], { cost_state_json: string | null; last_activity_at: number | null }>(
      `SELECT cost_state_json, last_activity_at FROM sessions WHERE session_id = ?`,
    );
    this.costStateSessions = db.prepare<[], { session_id: string }>(
      `SELECT session_id FROM sessions WHERE cost_state_json IS NOT NULL`,
    );
    // el modelo puede venir con fecha en un lado y sin ella en el otro: se compara por su id base
    this.hasReal = db.prepare<[string, string], { one: number }>(`
      SELECT 1 AS one FROM usage
      WHERE session_id = ? AND message_id NOT LIKE '${HIDDEN_PREFIX}%' AND model LIKE ? || '%' LIMIT 1`);
    this.putHidden = db.prepare(`
      INSERT INTO usage (message_id, agent_id, session_id, ts, model, input, output, cache_read,
                         cache_write_5m, cache_write_1h, speed, cost_usd, cost_est)
      VALUES (@id, @agent, @session, @ts, @model, @input, @output, @cacheRead, @cacheWrite5m, @cacheWrite1h, NULL, @cost, 0)
      ON CONFLICT(message_id) DO UPDATE SET
        ts = excluded.ts, input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
        cache_write_5m = excluded.cache_write_5m, cache_write_1h = excluded.cache_write_1h, cost_usd = excluded.cost_usd`);
    this.delHidden = db.prepare<[string]>(`DELETE FROM usage WHERE message_id = ?`);
    this.hiddenModels = db.prepare<[string], { message_id: string }>(
      `SELECT message_id FROM usage WHERE session_id = ? AND message_id LIKE '${HIDDEN_PREFIX}%'`,
    );
    this.seenModels = db.prepare<[], { model: string; tokens: number; cost: number; calls: number; hidden: number }>(`
      SELECT model, SUM(input + output + cache_read + cache_write_5m + cache_write_1h) AS tokens,
             COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS calls,
             MIN(message_id LIKE '${HIDDEN_PREFIX}%') AS hidden
      FROM usage GROUP BY model`);
    this.load();
  }

  /** lee de la DB los precios del usuario y los aprendidos y los deja activos para cotizar */
  load(): void {
    const custom = new Map<string, FlatPrice>();
    try {
      const raw: unknown = JSON.parse(this.getSetting.get(OVERRIDES_KEY)?.value ?? '{}');
      if (isRecord(raw)) {
        for (const [model, p] of Object.entries(raw)) {
          const price = parseFlatPrice(p);
          if (price) custom.set(model, price);
        }
      }
    } catch {
      // valor corrupto: sin precios propios
    }
    const learned = new Map<string, { key: string; at: number }>();
    for (const r of this.learnedRows.all()) learned.set(r.model, { key: r.price_key, at: r.at });
    this.custom = custom;
    this.learned = learned;
    setPriceBook(custom, new Map([...learned].map(([m, v]) => [m, v.key])));
  }

  private hash(): string {
    const body = JSON.stringify({
      table: tablePrices(),
      custom: [...this.custom].sort(([a], [b]) => a.localeCompare(b)),
      learned: [...this.learned].sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => [m, v.key]),
    });
    return createHash('sha1').update(body).digest('hex');
  }

  /**
   * al arrancar: aprende de los cost-state ya guardados, suma el gasto oculto y recotiza si los precios
   * cambiaron desde la ultima vez (tabla del codigo, precios del usuario o aprendidos). Devuelve las filas
   * que cambiaron de costo.
   */
  start(): number {
    const sessions = this.costStateSessions.all().map((s) => s.session_id);
    this.onCostStates(sessions, false);
    if (this.getSetting.get(HASH_KEY)?.value === this.hash() && !this.dirty) return 0;
    return this.reprice();
  }

  /** sesiones cuyo cost-state se acaba de leer: precio aprendido + gasto oculto. Recotiza si algo cambio */
  onCostStates(sessionIds: readonly string[], repriceIfDirty = true): number {
    if (sessionIds.length === 0) return 0;
    this.db.transaction(() => {
      for (const id of sessionIds) {
        const row = this.costState.get(id);
        const state = parseCostState(row?.cost_state_json ?? null);
        if (!state) continue;
        this.learn(id, state, row?.last_activity_at ?? null);
        this.syncHidden(id, state, row?.last_activity_at ?? null);
      }
    })();
    return repriceIfDirty && this.dirty ? this.reprice() : 0;
  }

  /**
   * Modelo que la tabla no trae: si el costo que calculo Claude Code coincide con el precio de algun modelo de
   * la tabla, ese precio se usa (marcado como estimado). Gana la muestra mas reciente.
   */
  private learn(sessionId: string, state: CostState, fallbackAt: number | null): void {
    if (state.unknownCost) return;
    const at = state.at ?? fallbackAt ?? 0;
    for (const m of state.models) {
      if (m.costUsd < LEARN_MIN_USD || findPrice(m.model)) continue;
      const base = baseModelId(m.model);
      if (this.custom.has(base)) continue;
      const prev = this.learned.get(base);
      if (prev && prev.at > at) continue;
      const match = tablePrices().find(([, price]) => {
        const est = usdWith(price, m.tokens);
        return Math.abs(est - m.costUsd) / m.costUsd < LEARN_TOLERANCE;
      });
      if (!match) continue;
      if (prev?.key === match[0] && prev.at === at) continue;
      this.putLearned.run(base, match[0], at, sessionId);
      if (prev?.key !== match[0]) this.dirty = true;
      this.learned.set(base, { key: match[0], at });
    }
    if (this.dirty) setPriceBook(this.custom, new Map([...this.learned].map(([m, v]) => [m, v.key])));
  }

  /**
   * Gasto que no esta en los transcripts: un modelo que aparece en el cost-state de la sesion y del que no hay
   * ni una llamada leida (p.ej. el Haiku que Claude Code usa para resumir paginas y buscar en la web). Entra
   * como una fila de usage con el costo que dio Claude Code, a nombre del agente `cs:<sesion>`.
   */
  private syncHidden(sessionId: string, state: CostState, fallbackAt: number | null): void {
    const keep = new Set<string>();
    const ts = state.at ?? fallbackAt;
    for (const m of state.models) {
      if (ts === null || m.costUsd <= 0 || m.model === '<synthetic>') continue;
      if (this.hasReal.get(sessionId, baseModelId(m.model))) continue;
      const id = `${HIDDEN_PREFIX}${sessionId}:${m.model}`;
      keep.add(id);
      this.putHidden.run({
        id,
        agent: `${HIDDEN_PREFIX}${sessionId}`,
        session: sessionId,
        ts,
        model: m.model,
        ...m.tokens,
        cost: m.costUsd,
      });
    }
    for (const r of this.hiddenModels.all(sessionId)) if (!keep.has(r.message_id)) this.delHidden.run(r.message_id);
  }

  /** recalcula el costo de cada llamada con los precios vigentes y rehace los totales de las tareas */
  reprice(): number {
    let changed = 0;
    this.db.transaction(() => {
      for (const r of this.usageRows.all()) {
        const q = quote(
          r.model,
          {
            input: r.input,
            output: r.output,
            cacheRead: r.cache_read,
            cacheWrite5m: r.cache_write_5m,
            cacheWrite1h: r.cache_write_1h,
          },
          r.speed,
        );
        const cost = q?.usd ?? null;
        const est = q?.estimated ? 1 : 0;
        if (cost === r.cost_usd && est === r.cost_est) continue;
        this.setCost.run(cost, est, r.message_id);
        changed++;
      }
      if (changed > 0) {
        // tarea del lead: su uso dentro del turno; tarea de un subagente: todo su uso
        this.db.exec(`
          UPDATE tasks SET
            cost_usd = COALESCE((SELECT SUM(u.cost_usd) FROM usage u WHERE u.agent_id = tasks.agent_id
                                 AND (tasks.kind <> 'lead' OR (u.ts >= tasks.started_at AND u.ts <= tasks.ended_at))), 0),
            unpriced_tokens = COALESCE((SELECT SUM(CASE WHEN u.cost_usd IS NULL
                                 THEN u.input + u.output + u.cache_read + u.cache_write_5m + u.cache_write_1h ELSE 0 END)
                                 FROM usage u WHERE u.agent_id = tasks.agent_id
                                 AND (tasks.kind <> 'lead' OR (u.ts >= tasks.started_at AND u.ts <= tasks.ended_at))), 0)`);
      }
      this.putSetting.run(HASH_KEY, this.hash());
    })();
    this.dirty = false;
    return changed;
  }

  /** fija (o quita, con null) el precio de un modelo y recotiza. Devuelve las filas que cambiaron */
  setCustom(model: string, price: FlatPrice | null): number {
    const base = baseModelId(model);
    const next = new Map(this.custom);
    if (price) next.set(base, price);
    else next.delete(base);
    this.putSetting.run(OVERRIDES_KEY, JSON.stringify(Object.fromEntries([...next].sort(([a], [b]) => a.localeCompare(b)))));
    this.load();
    return this.reprice();
  }

  /** modelos vistos en el historial con el precio que se les aplica y de donde sale */
  list(): PricesResponse {
    const byBase = new Map<string, PriceRow>();
    for (const r of this.seenModels.all()) {
      const base = baseModelId(r.model);
      const resolved = resolvePrice(r.model);
      const p = resolved?.price ?? null;
      const cur = byBase.get(base);
      if (cur) {
        cur.tokens += r.tokens;
        cur.costUsd += r.cost;
        cur.calls += r.calls;
        continue;
      }
      byBase.set(base, {
        model: base,
        // solo aparece en el cost-state: su costo lo dio Claude Code, no esta tabla
        source: r.hidden === 1 && !this.custom.has(base) && !findPrice(base) ? 'claude-code' : (resolved?.source ?? 'none'),
        priceOf: resolved && resolved.source !== 'table' && resolved.source !== 'custom' ? resolved.key : null,
        price: p
          ? { input: p.input, output: p.output, cacheWrite5m: p.cacheWrite5m, cacheWrite1h: p.cacheWrite1h, cacheRead: p.cacheRead }
          : null,
        tokens: r.tokens,
        costUsd: r.cost,
        calls: r.calls,
      });
    }
    const rows = [...byBase.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.model.localeCompare(b.model));
    return { rows };
  }
}
