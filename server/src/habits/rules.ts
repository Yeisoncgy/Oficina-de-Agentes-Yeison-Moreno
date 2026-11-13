import { RULE_MIN_SAMPLES, type RuleConfig, type RuleId, type RulesResponse } from '@shared/contract';
import type { Db } from '../db/connection';
import { groupBy, launchesPerTurn, turnSegments, type TurnSpan } from './detectors';
import { CalibrationFacts } from './facts';
import { RULE_IDS, RuleSettings, type RuleSettingsValue } from './ruleSettings';

export const RULE_WINDOW_DAYS = 30;

/** lo que queda del presupuesto del mes (state/budgetWatch.ts); estructural para no depender del orden */
export interface RuleBudgetCaps {
  remainingUsd: number;
  perDayUsd: number | null;
}

/** parte de lo que queda del mes que puede llevarse una sola corrida de flujo o un solo agente */
export const WORKFLOW_SHARE = 0.25;
export const AGENT_SHARE = 0.1;

/**
 * Tope de una regla en USD segun lo que queda del presupuesto: una sesion no deberia pasar en un dia del
 * recomendado por dia, una corrida de flujo del 25 % de lo que queda y un agente del 10 %. null = no aplica.
 */
export function budgetCapOf(id: RuleId, caps: RuleBudgetCaps | null): number | null {
  if (!caps) return null;
  switch (id) {
    case 'session_day_cost':
      return caps.perDayUsd ?? caps.remainingUsd;
    case 'workflow_cost':
      return caps.remainingUsd * WORKFLOW_SHARE;
    case 'agent_cost':
      return caps.remainingUsd * AGENT_SHARE;
    default:
      return null;
  }
}
/** la calibracion se rehace cuando tiene mas de esto */
const RECALIBRATE_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface RuleDef {
  label: string;
  unit: 'usd' | 'count';
  /** minimo: la calibracion nunca baja de aqui y con pocas muestras se usa tal cual */
  floor: number;
  /**
   * rango del umbral vigente (ya redondeado): un valor a mano fuera de aqui se rechaza, y uno guardado antes
   * o uno calibrado se recorta. Mas grande es un error de tipeo; mas chico dispara con cualquier cosa
   */
  min: number;
  max: number;
}

const MAX_USD = 100_000;
const MAX_COUNT = 10_000;

export const RULE_DEFS: Readonly<Record<RuleId, RuleDef>> = {
  agent_cost: { label: 'Costo de un agente', unit: 'usd', floor: 0.5, min: 0.01, max: MAX_USD },
  session_day_cost: { label: 'Costo de una sesión en el día', unit: 'usd', floor: 5, min: 0.01, max: MAX_USD },
  workflow_cost: { label: 'Costo de una corrida de flujo', unit: 'usd', floor: 2, min: 0.01, max: MAX_USD },
  turns_without_compact: { label: 'Turnos sin compactar', unit: 'count', floor: 30, min: 1, max: MAX_COUNT },
  subagents_per_turn: { label: 'Subagentes por turno', unit: 'count', floor: 4, min: 1, max: MAX_COUNT },
  // con 1 cualquier accion seria un bucle; mas de 50 no se alcanza a ver en la cola que miran las alertas
  loop_repeats: { label: 'Repeticiones seguidas', unit: 'count', floor: 3, min: 2, max: 50 },
};

/** percentil 90 por rango mas cercano (siempre es una muestra real); null sin muestras */
export function p90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1] ?? null;
}

/** usd a centavos, conteos a enteros (minimo 1) */
export function normalize(id: RuleId, v: number): number {
  return RULE_DEFS[id].unit === 'count' ? Math.max(1, Math.round(v)) : Math.round(v * 100) / 100;
}

/** el valor ya redondeado cae en el rango de la regla */
export function inRange(id: RuleId, normalized: number): boolean {
  const def = RULE_DEFS[id];
  return normalized >= def.min && normalized <= def.max;
}

function clamp(id: RuleId, v: number): number {
  const def = RULE_DEFS[id];
  return Math.min(def.max, Math.max(def.min, v));
}

interface Calibration {
  at: number;
  byId: Map<RuleId, { p90: number | null; samples: number }>;
}

/**
 * Reglas de aviso. Umbral = p90 de los ultimos 30 dias, nunca bajo el piso; con menos de
 * RULE_MIN_SAMPLES muestras, el piso. En las reglas de costo manda ademas lo que queda del presupuesto del
 * mes (budgetCapOf): el historial de un mes caro no puede subir el umbral por encima de lo que queda por
 * gastar. El usuario puede fijar un valor o apagar la regla (tabla settings).
 * Solo avisan: la app nunca actua sobre una sesion.
 */
export class RulesService {
  private readonly facts: CalibrationFacts;
  private readonly store: RuleSettings;
  private settings: RuleSettingsValue;
  private cal: Calibration | null = null;

  constructor(
    db: Db,
    private readonly clock: () => number,
    /** lo que queda del mes; sin el las reglas de costo solo usan la calibracion */
    private readonly caps: (() => RuleBudgetCaps | null) | null = null,
  ) {
    this.facts = new CalibrationFacts(db);
    this.store = new RuleSettings(db);
    this.settings = this.store.read();
  }

  list(): RulesResponse {
    const cal = this.calibration();
    return {
      rules: RULE_IDS.map((id) => this.config(id, cal)),
      notifyBrowser: this.settings.notifyBrowser,
      ...(this.system ? this.system() : {}),
      windowDays: RULE_WINDOW_DAYS,
      calibratedAt: new Date(cal.at).toISOString(),
    };
  }

  /** ajustes del sistema que viajan con las reglas (avisos del sistema y servidor en segundo plano) */
  private system: (() => { notifyDesktop: boolean; keepAlive: boolean }) | null = null;

  setSystemSource(source: () => { notifyDesktop: boolean; keepAlive: boolean }): void {
    this.system = source;
  }

  /** umbral vigente; null = regla apagada */
  value(id: RuleId): number | null {
    if (this.settings.disabled.includes(id)) return null;
    return this.config(id, this.calibration()).value;
  }

  /** value null = volver al calibrado; un valor fuera de rango (ya redondeado) lanza RangeError */
  update(id: RuleId, patch: { value?: number | null; enabled?: boolean }): RulesResponse {
    const overrides = { ...this.settings.overrides };
    let disabled = [...this.settings.disabled];
    if (patch.value === null) {
      delete overrides[id];
    } else if (patch.value !== undefined) {
      if (!Number.isFinite(patch.value) || patch.value <= 0) throw new RangeError(`valor invalido para ${id}`);
      const value = normalize(id, patch.value);
      if (!inRange(id, value)) throw new RangeError(`valor fuera de rango para ${id}`);
      overrides[id] = value;
    }
    if (patch.enabled !== undefined) {
      disabled = disabled.filter((d) => d !== id);
      if (!patch.enabled) disabled.push(id);
    }
    this.save({ ...this.settings, overrides, disabled });
    return this.list();
  }

  setNotify(enabled: boolean): RulesResponse {
    this.save({ ...this.settings, notifyBrowser: enabled });
    return this.list();
  }

  notifyBrowser(): boolean {
    return this.settings.notifyBrowser;
  }

  /**
   * olvida la calibracion guardada: la siguiente consulta la recalcula. Se llama al terminar el backfill,
   * porque durante la relectura inicial los recalculos de alertas calibran con pocos datos.
   */
  recalibrate(): void {
    this.cal = null;
  }

  private save(next: RuleSettingsValue): void {
    this.store.write(next);
    this.settings = next;
  }

  private config(id: RuleId, cal: Calibration): RuleConfig {
    const def = RULE_DEFS[id];
    const c = cal.byId.get(id) ?? { p90: null, samples: 0 };
    const calibrated = c.samples >= RULE_MIN_SAMPLES ? c.p90 : null;
    const custom = this.settings.overrides[id];
    const rawCap = def.unit === 'usd' ? budgetCapOf(id, this.caps?.() ?? null) : null;
    const budgetCap = rawCap === null ? null : clamp(id, Math.max(def.floor, normalize(id, rawCap)));
    let value: number;
    let source: RuleConfig['source'];
    if (custom !== undefined) {
      // un valor guardado antes de existir el rango (p.ej. loop_repeats = 1) se recorta al leer
      value = clamp(id, custom);
      source = 'custom';
    } else if (calibrated !== null) {
      value = clamp(id, Math.max(calibrated, def.floor));
      source = 'calibrated';
    } else {
      value = def.floor;
      source = 'floor';
    }
    if (source !== 'custom' && budgetCap !== null && budgetCap < value) {
      value = budgetCap;
      source = 'budget';
    }
    return {
      id,
      label: def.label,
      unit: def.unit,
      value,
      source,
      calibratedValue: calibrated,
      ...(budgetCap !== null ? { budgetCapUsd: budgetCap } : {}),
      samples: c.samples,
      floor: def.floor,
      enabled: !this.settings.disabled.includes(id),
    };
  }

  private calibration(): Calibration {
    const now = this.clock();
    if (this.cal && now >= this.cal.at && now - this.cal.at <= RECALIBRATE_MS) return this.cal;
    const samples = this.samples(now - RULE_WINDOW_DAYS * DAY_MS);
    const byId = new Map<RuleId, { p90: number | null; samples: number }>();
    for (const id of RULE_IDS) {
      const list = samples[id];
      const p = p90(list);
      byId.set(id, { p90: p === null ? null : normalize(id, p), samples: list.length });
    }
    this.cal = { at: now, byId };
    return this.cal;
  }

  private samples(since: number): Record<RuleId, number[]> {
    const turns = groupBy(this.facts.leadTurns(since), (t) => t.session_id);
    const compacts = groupBy(this.facts.compacts(since), (c) => c.session_id);
    const launches = groupBy(this.facts.leadLaunches(since), (l) => l.session_id);
    const turnsBetweenCompacts: number[] = [];
    const launchesByTurn: number[] = [];
    for (const [sessionId, rows] of turns) {
      const spans: TurnSpan[] = rows.map((t) => ({ start: t.started_at, end: t.ended_at }));
      const cuts = (compacts.get(sessionId) ?? []).map((c) => c.ts);
      for (const seg of turnSegments(spans, cuts)) turnsBetweenCompacts.push(seg.length);
      const starts = (launches.get(sessionId) ?? []).map((l) => l.started_at);
      for (const n of launchesPerTurn(spans, starts)) if (n >= 1) launchesByTurn.push(n);
    }
    return {
      agent_cost: this.facts.agentCosts(since),
      session_day_cost: this.facts.sessionDayCosts(since),
      workflow_cost: this.facts.workflowCosts(since),
      turns_without_compact: turnsBetweenCompacts,
      subagents_per_turn: launchesByTurn,
      loop_repeats: this.facts.maxStreaks(since),
    };
  }
}
