import type { FastifyInstance } from 'fastify';
import type { HistoryRange } from '@shared/contract';
import type { Db } from '../db/connection';
import { CompareService, type HabitFindings } from '../state/compare';
import { CostsService } from '../state/costs';
import { CostBaselines, SimulatorService, type MonthBudget, type RuleValues } from '../state/simulator';
import { rangeStart } from './history';

const COST_RANGES: readonly HistoryRange[] = ['today', 'week', 'month', 'all'];
const COMPARE_RANGES = ['week', 'month', 'all'] as const;
type CompareRange = (typeof COMPARE_RANGES)[number];

function isCompareRange(v: string): v is CompareRange {
  return (COMPARE_RANGES as readonly string[]).includes(v);
}

export interface InsightsDeps {
  db: Db;
  clock: () => number;
  /** RulesService (habits/rules.ts) */
  rules: RuleValues;
  /** HabitsService (habits/service.ts) */
  habits: HabitFindings;
  /** HistoryService: disponible del mes para el simulador */
  budget: MonthBudget;
  /** para compartir la cache con el pronostico de flujos (WorkflowForecaster); sin el se crea una */
  baselines?: CostBaselines;
}

/** GET /api/history/costs, /api/history/compare y /api/history/simulator (solo lectura) */
export function registerInsightsRoutes(app: FastifyInstance, deps: InsightsDeps): void {
  const costs = new CostsService(deps.db);
  const compare = new CompareService(deps.db, deps.habits);
  const simulator = new SimulatorService(
    deps.baselines ?? new CostBaselines(deps.db, deps.clock),
    deps.budget,
    deps.rules,
    deps.clock,
  );

  app.get<{ Querystring: { range?: string } }>('/api/history/costs', async (req, reply) => {
    const range = (req.query.range ?? 'month') as HistoryRange;
    if (!COST_RANGES.includes(range)) return reply.code(400).send({ error: 'range debe ser today|week|month|all' });
    return costs.costs(range, rangeStart(range, deps.clock()));
  });

  app.get<{ Querystring: { range?: string } }>('/api/history/compare', async (req, reply) => {
    const range = req.query.range ?? 'month';
    if (!isCompareRange(range)) return reply.code(400).send({ error: 'range debe ser week|month|all' });
    return compare.compare(range, rangeStart(range, deps.clock()));
  });

  app.get('/api/history/simulator', async () => simulator.simulator());
}
