// Cierre de una corrida de flujo: en que se fue, cuanto se descarto y como quedo contra su primer pronostico.
// Logica pura sobre el WorkflowRun del snapshot.
import type { WorkflowRole, WorkflowRun } from '@shared/contract';

export interface CloseGroup {
  key: string;
  agents: number;
  /** null si algun agente del grupo no tiene precio */
  costUsd: number | null;
}

export interface RunClose {
  byPhase: CloseGroup[];
  byRole: Array<CloseGroup & { role: WorkflowRole }>;
  /** agentes que fallaron o fueron reemplazados por un reintento, y lo que costaron */
  discardedAgents: number;
  discardedUsd: number;
  /** under: costo menos que el extremo bajo · within: dentro del rango · over: paso el extremo alto · null: sin pronostico o sin precio */
  verdict: 'under' | 'within' | 'over' | null;
}

const add = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);

function groupBy<K extends string>(run: WorkflowRun, keyOf: (a: WorkflowRun['agents'][number]) => K): Map<K, CloseGroup> {
  const out = new Map<K, CloseGroup>();
  for (const a of run.agents) {
    const key = keyOf(a);
    const g = out.get(key) ?? { key, agents: 0, costUsd: 0 };
    g.agents += 1;
    g.costUsd = add(g.costUsd, a.costUsd);
    out.set(key, g);
  }
  return out;
}

const byCost = (a: CloseGroup, b: CloseGroup): number => (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.key.localeCompare(b.key);

export function runClose(run: WorkflowRun): RunClose {
  const phases = groupBy(run, (a) => a.phase ?? 'Sin fase');
  // las fases en el orden del script; las que no estan ahi, al final
  const order = run.phases.map((p) => p.title);
  const byPhase = [...phases.values()].sort((a, b) => {
    const ia = order.indexOf(a.key);
    const ib = order.indexOf(b.key);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib) || a.key.localeCompare(b.key);
  });
  const byRole = [...groupBy(run, (a) => a.role ?? 'generalist').values()]
    .sort(byCost)
    .map((g) => ({ ...g, role: g.key as WorkflowRole }));
  const failed = run.agents.filter((a) => a.status === 'failed');
  const first = run.firstForecast ?? null;
  let verdict: RunClose['verdict'] = null;
  if (first && run.costUsd !== null) {
    if (run.costUsd > first.highUsd + 0.005) verdict = 'over';
    else if (run.costUsd < first.lowUsd - 0.005) verdict = 'under';
    else verdict = 'within';
  }
  return {
    byPhase,
    byRole,
    discardedAgents: failed.length,
    discardedUsd: failed.reduce((sum, a) => sum + (a.costUsd ?? 0), 0),
    verdict,
  };
}
