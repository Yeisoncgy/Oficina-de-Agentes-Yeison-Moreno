// Logica pura de las pestanas de eficiencia del historial (Habitos, Reglas, Costos, Comparador y
// Simulador): etiquetas en espanol, formato de la evidencia y el calculo del escenario del simulador.
// Solo campos del contrato; nada de texto de prompts.
import {
  riskOf,
  type AgentRole,
  type BudgetRisk,
  type CompareRow,
  type CostRow,
  type CostsResponse,
  type DiscardedRow,
  type HabitEvidence,
  type HabitFinding,
  type HabitKind,
  type ModelFamily,
  type RuleConfig,
  type RuleId,
  type SimBaselineRow,
  type WorkflowRole,
} from '@shared/contract';
import { formatPercent, formatTokens, formatUsd } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/workflows';
import { STATE } from '@/theme';

/** etiquetas de rol del contrato (AgentRole): las mismas de la escena y de Flujos */
export const AGENT_ROLE_LABEL: Record<AgentRole, string> = ROLE_LABEL;

export function isAgentRole(key: string): key is AgentRole {
  return Object.hasOwn(AGENT_ROLE_LABEL, key);
}

/** roles de subagente que se pueden simular (el orquestador es el lead, no se lanza) */
export const SIM_ROLES: WorkflowRole[] = ['explorer', 'builder', 'reviewer', 'tester', 'security', 'planner', 'docs', 'generalist'];

export const FAMILY_LABEL: Record<ModelFamily, string> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  other: 'Otro',
};

export const SIM_FAMILIES: ModelFamily[] = ['fable', 'opus', 'sonnet', 'haiku'];

export const HABIT_KIND_LABEL: Record<HabitKind, string> = {
  repeated_read: 'Relecturas',
  full_read: 'Lecturas completas',
  big_context: 'Contexto grande',
  needs_compact: 'Falta compactar',
  loop: 'Bucles',
  same_error: 'Error repetido',
  expensive_model: 'Modelo caro',
  low_cache: 'Poca caché',
  long_output: 'Respuestas largas',
  idle_no_changes: 'Sin cambios',
  mcp_unused: 'MCP sin uso',
  dup_instructions: 'Instrucciones duplicadas',
  discarded: 'Trabajo descartado',
  rule: 'Reglas',
};

export const SEVERITY_LABEL: Record<HabitFinding['severity'], string> = {
  critical: 'Crítico',
  warning: 'Aviso',
  info: 'Info',
};

export const SEVERITY_COLOR: Record<HabitFinding['severity'], string> = {
  critical: STATE.error,
  warning: STATE.warning,
  info: STATE.live,
};

export const DISCARD_REASON_LABEL: Record<DiscardedRow['reason'], string> = {
  failed: 'Falló',
  killed: 'Cancelado',
  stopped: 'Detenido',
  retry: 'Reintento',
};

export const RISK_LABEL: Record<BudgetRisk, string> = { low: 'Bajo', medium: 'Medio', high: 'Alto' };

export const RISK_COLOR: Record<BudgetRisk, string> = { low: STATE.done, medium: STATE.warning, high: STATE.error };

export const RULE_SOURCE_LABEL: Record<RuleConfig['source'], string> = {
  calibrated: 'Calibrado p90',
  floor: 'Mínimo',
  custom: 'Propio',
  budget: 'Por presupuesto',
};

/** que mide cada regla (del contrato), para la linea bajo su nombre */
export const RULE_HINT: Record<RuleId, string> = {
  agent_cost: 'Avisa cuando un agente supera este costo.',
  session_day_cost: 'Avisa cuando una sesión supera este costo en el día.',
  workflow_cost: 'Presupuesto por flujo: avisa cuando una corrida lo supera.',
  turns_without_compact: 'Avisa cuando una sesión pasa estos turnos sin compactar.',
  subagents_per_turn: 'Avisa cuando un turno del lead lanza más subagentes que esto.',
  loop_repeats: 'Avisa cuando se repite la misma herramienta con el mismo input estas veces seguidas.',
};

const countFmt = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

function evidenceValue(unit: HabitEvidence['unit'], v: number): string {
  switch (unit) {
    case 'count':
      return countFmt.format(v);
    case 'tokens':
      return formatTokens(v);
    case 'usd':
      return formatUsd(v);
    case 'pct':
      return formatPercent(v);
    case 'chars':
      return `${formatTokens(v)} caracteres`;
    case 'lines':
      return `${countFmt.format(v)} ${v === 1 ? 'línea' : 'líneas'}`;
    case 'minutes':
      return `${countFmt.format(v)} min`;
  }
}

/** valor de una evidencia con su unidad; '~' delante si es estimado (p.ej. tokens por caracteres / 4) */
export function formatEvidence(e: Pick<HabitEvidence, 'value' | 'unit' | 'estimated'>): string {
  const text = evidenceValue(e.unit, Number.isFinite(e.value) ? e.value : 0);
  return e.estimated ? `~${text}` : text;
}

/** "sala · agente" de un hallazgo (sin agente: solo la sala) */
export function findingWhere(f: Pick<HabitFinding, 'roomTitle' | 'projectName' | 'agentName'>): string {
  const room = f.roomTitle === f.projectName || !f.projectName ? f.roomTitle : `${f.roomTitle} (${f.projectName})`;
  return f.agentName ? `${room} · ${f.agentName}` : room;
}

/** Ahorro estimado: siempre con '~' porque sale de precios reales sobre un calculo aproximado */
export function formatSavings(usd: number | null): string | null {
  return usd === null || !(usd > 0) ? null : `~${formatUsd(usd)}`;
}

// ---- Simulador ----

export interface SimLine {
  id: number;
  role: WorkflowRole;
  family: ModelFamily;
  count: number;
}

export interface SimLineEstimate {
  line: SimLine;
  /** null = sin historico de ese rol y familia */
  baseline: SimBaselineRow | null;
  lowUsd: number | null;
  highUsd: number | null;
}

export interface SimEstimate {
  lines: SimLineEstimate[];
  /** suma de cantidad x p25 / p50 / p75 de las filas con historico */
  lowUsd: number;
  midUsd: number;
  highUsd: number;
  /** agentes que entraron al calculo */
  pricedAgents: number;
  /** filas sin historico (no suman) */
  missingLines: number;
}

/** fila del historico con percentiles (null si no hay o tiene menos de 3 muestras) */
export function baselineFor(rows: readonly SimBaselineRow[], role: AgentRole, family: ModelFamily): SimBaselineRow | null {
  const row = rows.find((r) => r.role === role && r.family === family);
  return row && row.p25Usd !== null && row.p50Usd !== null && row.p75Usd !== null ? row : null;
}

/** Escenario: cantidad x p25..p75 del costo por agente de cada rol y familia; sin historico no suma */
export function simulateScenario(lines: readonly SimLine[], rows: readonly SimBaselineRow[]): SimEstimate {
  const out: SimEstimate = { lines: [], lowUsd: 0, midUsd: 0, highUsd: 0, pricedAgents: 0, missingLines: 0 };
  for (const line of lines) {
    const count = Number.isFinite(line.count) ? Math.max(0, Math.floor(line.count)) : 0;
    const baseline = baselineFor(rows, line.role, line.family);
    if (!baseline) {
      if (count > 0) out.missingLines++;
      out.lines.push({ line, baseline: null, lowUsd: null, highUsd: null });
      continue;
    }
    const low = count * (baseline.p25Usd ?? 0);
    const high = count * (baseline.p75Usd ?? 0);
    out.lowUsd += low;
    out.midUsd += count * (baseline.p50Usd ?? 0);
    out.highUsd += high;
    out.pricedAgents += count;
    out.lines.push({ line, baseline, lowUsd: low, highUsd: high });
  }
  return out;
}

/** riesgo del escenario frente a lo que queda del mes; null si nada entro al calculo */
export function scenarioRisk(estimate: Pick<SimEstimate, 'highUsd' | 'pricedAgents'>, availableUsd: number | null): BudgetRisk | null {
  return estimate.pricedAgents > 0 ? riskOf(estimate.highUsd, availableUsd) : null;
}

export interface SimVerdict {
  tone: 'ok' | 'warn' | 'error';
  text: string;
}

/** una sola frase contra el tope por flujo (regla workflow_cost); null sin estimacion o con la regla apagada */
export function simVerdict(
  estimate: Pick<SimEstimate, 'midUsd' | 'highUsd' | 'pricedAgents'>,
  capUsd: number | null,
): SimVerdict | null {
  if (estimate.pricedAgents === 0 || capUsd === null) return null;
  const cap = formatUsd(capUsd);
  if (estimate.highUsd <= capUsd) return { tone: 'ok', text: `Cabe en el tope por flujo (${cap}).` };
  if (estimate.midUsd <= capUsd) return { tone: 'warn', text: `El extremo alto pasa el tope por flujo (${cap}).` };
  return { tone: 'error', text: `La mediana ya pasa el tope por flujo (${cap}).` };
}

/**
 * Precio de un monto que el server suma solo con lo que tiene precio. priced: todo tiene precio ·
 * partial: hay monto, pero parte quedo fuera (marca discreta) · unpriced: nada tiene monto y hay algo sin
 * precio ("sin precio", nunca $0,00)
 */
export type Pricing = 'priced' | 'partial' | 'unpriced';

function pricingOf(unpriced: number | undefined, hasAmount: boolean): Pricing {
  if (!((unpriced ?? 0) > 0)) return 'priced';
  return hasAmount ? 'partial' : 'unpriced';
}

/** fila de costos: unpricedTokens son los tokens de modelos sin precio, fuera de costUsd */
export function costRowPricing(row: Pick<CostRow, 'costUsd' | 'unpricedTokens'>): Pricing {
  return pricingOf(row.unpricedTokens, row.costUsd > 0);
}

/** fila del comparador: las tareas con tokens sin precio no entran en costPerCompletedUsd */
export function compareRowPricing(row: Pick<CompareRow, 'costPerCompletedUsd' | 'unpricedTasks'>): Pricing {
  return pricingOf(row.unpricedTasks, row.costPerCompletedUsd !== null);
}

/** Tokens sin precio del periodo: los de totals; sin el dato, la suma por modelo (el precio va por modelo) */
export function unpricedCostTokens(data: {
  totals: Pick<CostsResponse['totals'], 'unpricedTokens'>;
  byModel: readonly Pick<CostRow, 'unpricedTokens'>[];
}): number {
  return data.totals.unpricedTokens ?? data.byModel.reduce((sum, r) => sum + (r.unpricedTokens ?? 0), 0);
}

/** 0..1 relativo al mayor costo de la lista (barras de las tablas de costos) */
export function costShares(rows: readonly { costUsd: number }[]): number[] {
  const max = rows.reduce((m, r) => Math.max(m, Number.isFinite(r.costUsd) ? r.costUsd : 0), 0);
  return rows.map((r) => (max > 0 && Number.isFinite(r.costUsd) ? Math.max(0, r.costUsd) / max : 0));
}
