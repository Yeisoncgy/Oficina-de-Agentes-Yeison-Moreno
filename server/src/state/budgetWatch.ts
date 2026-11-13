import type { BudgetResponse, BudgetStatus, BudgetThreshold } from '@shared/contract';
import { BUDGET_THRESHOLDS } from '@shared/contract';

/** lo que se usa de HistoryService */
export interface BudgetSource {
  budget(month: string | undefined, now: number): BudgetResponse;
}

/** lo que queda del mes, para atar a el los topes de las reglas y el pronostico de los flujos */
export interface BudgetCaps {
  /** presupuesto - gastado, nunca negativo */
  remainingUsd: number;
  /** recomendado por dia laboral; null si no quedan dias laborales */
  perDayUsd: number | null;
}

export function thresholdOf(usedRatio: number): BudgetThreshold {
  let out: BudgetThreshold = 0;
  for (const t of BUDGET_THRESHOLDS) if (usedRatio * 100 >= t) out = t;
  return out;
}

function cents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

export function toStatus(b: BudgetResponse): BudgetStatus {
  const usedRatio = b.budgetUsd > 0 ? b.spentUsd / b.budgetUsd : 0;
  const todayUsd = b.todayUsd ?? 0;
  const perDayUsd = b.recommendedPerDayUsd ?? null;
  const over = b.spentUsd > b.budgetUsd;
  return {
    month: b.month,
    budgetUsd: b.budgetUsd,
    spentUsd: cents(b.spentUsd),
    projectedUsd: cents(b.projectedUsd),
    usedRatio: Math.round(usedRatio * 1000) / 1000,
    threshold: thresholdOf(usedRatio),
    projectedOver: !over && b.projectedUsd > b.budgetUsd,
    todayUsd: cents(todayUsd),
    perDayUsd: perDayUsd === null ? null : cents(perDayUsd),
    // con el presupuesto ya pasado el aviso es el del mes, no el del dia
    dayOver: !over && perDayUsd !== null && perDayUsd > 0 && todayUsd > perDayUsd,
    burnPerHourUsd: cents(b.burnPerHourUsd ?? 0),
    runOutDate: b.runOutDate ?? null,
    crossedDate: b.crossedDate ?? null,
    estimatedUsd: cents(b.estimatedUsd ?? 0),
    projectsOver: (b.projects ?? [])
      .filter((p) => p.capUsd !== null && p.spentUsd > p.capUsd)
      .map((p) => ({ project: p.project, spentUsd: cents(p.spentUsd), capUsd: p.capUsd as number })),
  };
}

/**
 * Estado vivo del presupuesto del mes. Se calcula una vez por lote de ingesta o sweep (refresh) y el snapshot,
 * las reglas y el pronostico de flujos leen ese resultado: build() corre muy seguido y no debe sumar el mes
 * cada vez.
 */
export class BudgetWatch {
  private cached: BudgetStatus | null = null;

  constructor(
    private readonly source: BudgetSource,
    private readonly clock: () => number,
  ) {}

  /** recalcula; lo llaman settle(), el sweep y las rutas que cambian el presupuesto */
  refresh(): BudgetStatus {
    this.cached = toStatus(this.source.budget(undefined, this.clock()));
    return this.cached;
  }

  status(): BudgetStatus {
    return this.cached ?? this.refresh();
  }

  caps(): BudgetCaps {
    const s = this.status();
    return { remainingUsd: Math.max(0, s.budgetUsd - s.spentUsd), perDayUsd: s.perDayUsd };
  }
}
