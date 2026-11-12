import type { AgentRole, ModelFamily, RuleId, SimBaselineRow, SimulatorResponse } from '@shared/contract';
import { COST_HISTORY_DAYS } from '../config';
import type { Db } from '../db/connection';
import { modelFamily } from '../ingest/pricing';
import { agentRoleOf, ROLE_ORDER } from './costs';

/** lo que se usa de RulesService (server/src/habits/rules.ts); estructural para no depender del orden */
export interface RuleValues {
  /** umbral vigente; null = regla apagada */
  value(id: RuleId): number | null;
}

/** minimo de muestras para dar percentiles ("sin historico" por debajo) */
export const MIN_COST_SAMPLES = 3;

const FAMILY_ORDER: readonly ModelFamily[] = ['fable', 'opus', 'sonnet', 'haiku', 'other'];

export interface CostPercentiles {
  samples: number;
  p25Usd: number;
  p50Usd: number;
  p75Usd: number;
}

/** percentil con interpolacion lineal sobre valores ya ordenados de menor a mayor */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

function percentiles(sorted: readonly number[]): CostPercentiles | null {
  if (sorted.length < MIN_COST_SAMPLES) return null;
  return {
    samples: sorted.length,
    p25Usd: percentile(sorted, 0.25),
    p50Usd: percentile(sorted, 0.5),
    p75Usd: percentile(sorted, 0.75),
  };
}

/** medianoche local de hace COST_HISTORY_DAYS dias: la ventana solo se mueve una vez al dia */
export function costWindowStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - COST_HISTORY_DAYS).getTime();
}

interface SampleRow {
  cost_usd: number;
  role: string | null;
  agent_type: string;
  model: string | null;
}

interface Baselines {
  key: string;
  rows: SimBaselineRow[];
  byKey: Map<string, CostPercentiles>;
  general: CostPercentiles | null;
}

/**
 * Costo por subagente terminado (tabla tasks) por rol x familia de modelo, ultimos COST_HISTORY_DAYS dias.
 * Las tareas con tokens sin precio no entran (su costo no se conoce). Se recalcula solo si cambian las
 * tareas de la ventana o el rol y modelo de sus agentes: el pronostico de flujos lo consulta en cada
 * snapshot y debe ser determinista.
 */
export class CostBaselines {
  private readonly samples;
  private readonly fingerprint;
  private cache: Baselines | null = null;

  constructor(
    db: Db,
    private readonly clock: () => number,
  ) {
    this.samples = db.prepare<[number], SampleRow>(`
      SELECT t.cost_usd, a.role, t.agent_type, a.model
      FROM tasks t LEFT JOIN agents a ON a.agent_id = t.agent_id
      WHERE t.kind = 'subagent' AND t.ended_at >= ? AND t.unpriced_tokens = 0`);
    // el rol, el modelo y el tipo cambian sin tocar tasks (RoleStore reclasifica despues del backfill):
    // entran como suma ponderada por fila. Los roles empiezan cada uno con otra letra; el modelo, por la
    // letra de su familia (claude-<familia>-...)
    this.fingerprint = db.prepare<[number], { n: number; last: number | null; cost: number; mix: number }>(`
      SELECT COUNT(*) AS n, MAX(t.ended_at) AS last, TOTAL(t.cost_usd) AS cost,
             TOTAL(t.rowid * (COALESCE(unicode(a.role), 0) + 128 * COALESCE(unicode(substr(a.model, 8, 1)), 0)
                              + 16384 * length(t.agent_type))) AS mix
      FROM tasks t LEFT JOIN agents a ON a.agent_id = t.agent_id
      WHERE t.kind = 'subagent' AND t.ended_at >= ? AND t.unpriced_tokens = 0`);
  }

  rows(): SimBaselineRow[] {
    return this.current().rows;
  }

  /** percentiles del rol y familia; null con menos de MIN_COST_SAMPLES muestras */
  of(role: AgentRole, family: ModelFamily): CostPercentiles | null {
    return this.current().byKey.get(`${role}:${family}`) ?? null;
  }

  /** todos los subagentes de la ventana juntos; null con menos de MIN_COST_SAMPLES muestras */
  general(): CostPercentiles | null {
    return this.current().general;
  }

  private current(): Baselines {
    const from = costWindowStart(this.clock());
    const f = this.fingerprint.get(from);
    const key = `${from}:${f?.n ?? 0}:${f?.last ?? 0}:${f?.cost ?? 0}:${f?.mix ?? 0}`;
    if (this.cache?.key === key) return this.cache;

    const groups = new Map<string, { role: AgentRole; family: ModelFamily; costs: number[] }>();
    const all: number[] = [];
    for (const s of this.samples.all(from)) {
      const role = agentRoleOf('subagent', s.role, s.agent_type);
      const family = modelFamily(s.model);
      const k = `${role}:${family}`;
      const g = groups.get(k) ?? { role, family, costs: [] };
      g.costs.push(s.cost_usd);
      groups.set(k, g);
      all.push(s.cost_usd);
    }

    const byKey = new Map<string, CostPercentiles>();
    const rows: SimBaselineRow[] = [];
    for (const [k, g] of groups) {
      g.costs.sort((a, b) => a - b);
      const p = percentiles(g.costs);
      if (p) byKey.set(k, p);
      rows.push({
        role: g.role,
        family: g.family,
        samples: g.costs.length,
        p25Usd: p?.p25Usd ?? null,
        p50Usd: p?.p50Usd ?? null,
        p75Usd: p?.p75Usd ?? null,
      });
    }
    rows.sort(
      (a, b) =>
        ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
        FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family),
    );
    all.sort((a, b) => a - b);
    this.cache = { key, rows, byKey, general: percentiles(all) };
    return this.cache;
  }
}

/** lo que se usa de HistoryService para el disponible del mes */
export interface MonthBudget {
  budget(month: string | undefined, now: number): { budgetUsd: number; spentUsd: number };
}

/** GET /api/history/simulator: la base historica; el escenario lo arma el cliente con riskOf */
export class SimulatorService {
  constructor(
    private readonly baselines: CostBaselines,
    private readonly budget: MonthBudget,
    private readonly rules: RuleValues,
    private readonly clock: () => number,
  ) {}

  simulator(): SimulatorResponse {
    const month = this.budget.budget(undefined, this.clock());
    return {
      windowDays: COST_HISTORY_DAYS,
      rows: this.baselines.rows(),
      availableUsd: month.budgetUsd - month.spentUsd,
      workflowBudgetUsd: this.rules.value('workflow_cost'),
    };
  }
}
