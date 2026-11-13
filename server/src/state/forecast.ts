import { riskOf, type BudgetRisk, type WorkflowForecast, type WorkflowRun } from '@shared/contract';
import type { Db } from '../db/connection';
import { modelFamily } from '../ingest/pricing';
import { CostBaselines, type RuleValues } from './simulator';
import type { RunForecaster } from './workflows';

/** fraccion del tope de la corrida desde la que el riesgo es medio */
export const RUN_RISK_MEDIUM_FROM = 0.7;

function cents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/** riesgo contra el tope de la corrida (no contra el disponible del mes, eso es riskOf): > tope alto, > 70 % medio */
export function runRiskOf(highUsd: number, budgetUsd: number | null): BudgetRisk | null {
  if (budgetUsd === null || !Number.isFinite(budgetUsd)) return null;
  if (highUsd > budgetUsd) return 'high';
  if (highUsd > budgetUsd * RUN_RISK_MEDIUM_FROM) return 'medium';
  return 'low';
}

/**
 * Pronostico en vuelo de una corrida: lo gastado + lo que le falta a cada agente trabajando (p50..p75 de
 * su rol y familia menos lo que ya gasto) + las fases pendientes x agentes promedio por fase vista x
 * p25..p75 general. Sin historial del rol y familia, el agente se estima con la mediana general.
 * Determinista: mismo estado de DB, mismo resultado (el hub compara el JSON del snapshot).
 */
export class WorkflowForecaster implements RunForecaster {
  private readonly baselines: CostBaselines;
  private readonly rules: RuleValues;
  private readonly available: (() => number | null) | null;
  private readonly firstOf;
  private readonly saveFirst;
  private readonly clock: () => number;

  /**
   * `baselines` permite compartir la cache con el simulador; sin el se crea una propia. `available` es lo que
   * queda del presupuesto del mes: con el, el pronostico dice que parte se llevaria la corrida.
   */
  constructor(deps: {
    db: Db;
    clock: () => number;
    rules: RuleValues;
    baselines?: CostBaselines;
    available?: () => number | null;
  }) {
    this.baselines = deps.baselines ?? new CostBaselines(deps.db, deps.clock);
    this.rules = deps.rules;
    this.available = deps.available ?? null;
    this.clock = deps.clock;
    this.firstOf = deps.db.prepare<[string], { low_usd: number; high_usd: number }>(
      `SELECT low_usd, high_usd FROM run_forecasts WHERE run_id = ?`,
    );
    this.saveFirst = deps.db.prepare<[string, number, number, number]>(
      `INSERT OR IGNORE INTO run_forecasts (run_id, low_usd, high_usd, at) VALUES (?, ?, ?, ?)`,
    );
  }

  /** primer pronostico guardado de la corrida (para el cierre); null si nunca se pronostico */
  first(runId: string): { lowUsd: number; highUsd: number } | null {
    const r = this.firstOf.get(runId);
    return r ? { lowUsd: r.low_usd, highUsd: r.high_usd } : null;
  }

  /** null sin historial, o si la corrida o algun agente no tiene precio (no se pronostica un monto a medias) */
  forecast(run: WorkflowRun): WorkflowForecast | null {
    if (run.costUsd === null || run.agents.some((a) => a.costUsd === null)) return null;
    const general = this.baselines.general();
    if (!general) return null;

    let spent = 0;
    let low = 0;
    let high = 0;
    let unknownAgents = 0;
    for (const a of run.agents) {
      const cost = a.costUsd ?? 0;
      spent += cost;
      if (a.status !== 'working') continue;
      const p = this.baselines.of(a.role ?? 'generalist', modelFamily(a.model));
      if (p) {
        low += Math.max(0, p.p50Usd - cost);
        high += Math.max(0, p.p75Usd - cost);
      } else {
        unknownAgents++;
        low += Math.max(0, general.p50Usd - cost);
        high += Math.max(0, general.p50Usd - cost);
      }
    }

    const seen = run.phases.filter((p) => p.agentsStarted > 0);
    const pending = run.phases.filter((p) => p.status === 'pending').length;
    // sin fases vistas todavia se cuenta un agente por fase: ninguna fase termina sin al menos uno
    const perPhase = seen.length > 0 ? seen.reduce((n, p) => n + p.agentsStarted, 0) / seen.length : 1;
    low += pending * perPhase * general.p25Usd;
    high += pending * perPhase * general.p75Usd;

    const budgetUsd = this.rules.value('workflow_cost');
    const highUsd = cents(spent + high);
    const lowUsd = cents(spent + low);
    // el primero queda guardado: en el cierre se compara con lo que costo de verdad
    if (!this.firstOf.get(run.runId)) this.saveFirst.run(run.runId, lowUsd, highUsd, this.clock());
    const monthAvailableUsd = this.available ? this.available() : null;
    return {
      lowUsd,
      highUsd,
      budgetUsd,
      risk: runRiskOf(highUsd, budgetUsd),
      unknownAgents,
      ...(monthAvailableUsd !== null
        ? {
            monthAvailableUsd: cents(monthAvailableUsd),
            monthShare: monthAvailableUsd > 0 ? Math.round((highUsd / monthAvailableUsd) * 1000) / 1000 : null,
            monthRisk: riskOf(highUsd, monthAvailableUsd),
          }
        : {}),
    };
  }
}
