import type { HabitEvidence, HabitFinding, HabitKind } from '@shared/contract';
import { baseName } from '../ingest/labels';
import * as copy from './copy';
import { groupBy, money, normPath, type Claim } from './detectors';

// Lista de hallazgos que ve el usuario: junta los repetidos del mismo tipo en una sesion (un flujo con 20
// agentes de contexto grande es un solo aviso) y calcula los ahorros sin contar dos veces las mismas llamadas.

/** hallazgo con lo que solo usa el servidor (reclamos de ahorro y archivos o herramientas); no sale en la API */
export interface Scored extends HabitFinding {
  claims?: readonly Claim[];
  subjects?: readonly string[];
  /** solo en los juntados: ids de los hallazgos que lo forman (la bandeja los descarta con el grupo) */
  members?: readonly string[];
}

/** en 'live' solo se juntan si hay mas de 3 del mismo tipo en la sesion; en los rangos historicos, desde 2 */
export const LIVE_GROUP_MIN = 4;
export const HISTORY_GROUP_MIN = 2;

const SEVERITY_RANK: Readonly<Record<HabitFinding['severity'], number>> = { critical: 0, warning: 1, info: 2 };

/** mas severos primero, luego mayor ahorro, luego lo mas reciente */
export function sortFindings<T extends HabitFinding>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (b.savingsUsd ?? -1) - (a.savingsUsd ?? -1) ||
      b.detectedAt.localeCompare(a.detectedAt) ||
      a.id.localeCompare(b.id),
  );
}

export function toPublic(f: Scored): HabitFinding {
  const { claims, subjects, members, ...rest } = f;
  return rest;
}

// Evidencia al juntar: se suma salvo los maximos, los topes y los porcentajes (etiquetas de detectors.ts)
const EVIDENCE_MAX: ReadonlySet<string> = new Set([
  'Contexto máximo',
  'Archivo más largo',
  'Repeticiones seguidas',
  'Umbral',
  'Tope',
  'Lectura y búsqueda',
  'Contexto promedio reciente',
  'Tokens repetidos por llamada',
  'Texto repetido',
]);
/** en poca cache lo que importa es el peor */
const EVIDENCE_MIN: ReadonlySet<string> = new Set(['Aciertos de cache']);

function mergeEvidence(lists: readonly (readonly HabitEvidence[])[]): HabitEvidence[] {
  const out = new Map<string, HabitEvidence>();
  for (const list of lists) {
    for (const e of list) {
      const prev = out.get(e.label);
      if (!prev) {
        out.set(e.label, { ...e });
        continue;
      }
      let value: number;
      if (EVIDENCE_MAX.has(e.label)) value = Math.max(prev.value, e.value);
      else if (EVIDENCE_MIN.has(e.label)) value = Math.min(prev.value, e.value);
      else value = prev.value + e.value;
      const next: HabitEvidence = { ...prev, value: e.unit === 'usd' ? money(value) : value };
      if (e.estimated) next.estimated = true;
      out.set(e.label, next);
    }
  }
  return [...out.values()];
}

/** cuantos van juntados y en que unidad, cuando no son agentes */
function countEvidence(f: HabitFinding, n: number): HabitEvidence | null {
  if (f.kind === 'same_error') return { label: 'Errores distintos', value: n, unit: 'count' };
  if (f.ruleId === 'session_day_cost') return { label: 'Días', value: n, unit: 'count' };
  if (f.ruleId === 'workflow_cost') return { label: 'Flujos', value: n, unit: 'count' };
  return null;
}

function merge(list: readonly Scored[]): Scored {
  const sorted = sortFindings(list);
  const top = sorted[0]!;
  const agentIds = new Set(list.flatMap((f) => (f.agentId !== null ? [f.agentId] : [])));
  const oneAgent = agentIds.size === 1 && list.every((f) => f.agentId !== null);
  const leads = list.filter((f) => f.agentId !== null && f.agentId === f.roomId).length;
  const subs = list.filter((f) => f.agentId !== null && f.agentId !== f.roomId).length;
  const whoDid: copy.GroupFacts['who'] = subs === 0 ? 'lead' : leads === 0 ? 'subagents' : 'mixed';

  // archivos o herramientas distintos (sin distinguir mayusculas ni barras), con el nombre corto
  const names = new Map<string, string>();
  for (const f of sorted) for (const s of f.subjects ?? []) if (!names.has(normPath(s))) names.set(normPath(s), baseName(s));

  const merged = mergeEvidence(sorted.map((f) => f.evidence));
  const limit = merged.find((e) => e.label === 'Tope')?.value ?? null;
  const c = copy.groupCopy(top.kind, top.ruleId, {
    n: list.length,
    agents: agentIds.size,
    names: [...names.values()],
    who: whoDid,
    limit,
  });

  const head: HabitEvidence[] = [];
  if (agentIds.size > 1) head.push({ label: 'Agentes', value: agentIds.size, unit: 'count' });
  if (top.kind === 'repeated_read' || top.kind === 'full_read') head.push({ label: 'Archivos', value: names.size, unit: 'count' });
  const counted = countEvidence(top, list.length);
  if (counted) head.push(counted);

  const priced = list.filter((f) => f.savingsUsd !== null);
  return {
    id: `grupo:${top.kind}${top.ruleId ? `:${top.ruleId}` : ''}:${top.roomId}`,
    kind: top.kind,
    ...(top.ruleId ? { ruleId: top.ruleId } : {}),
    severity: top.severity,
    roomId: top.roomId,
    roomTitle: top.roomTitle,
    projectName: top.projectName,
    agentId: oneAgent ? top.agentId : null,
    agentName: oneAgent ? top.agentName : null,
    title: c?.title ?? `${top.title} (y ${list.length - 1} más)`,
    evidence: [...head, ...merged],
    recommendation: c?.recommendation ?? top.recommendation,
    copyText: c?.copyText ?? top.copyText,
    savingsUsd: priced.length > 0 ? money(priced.reduce((s, f) => s + (f.savingsUsd ?? 0), 0)) : null,
    detectedAt: list.reduce((m, f) => (f.detectedAt > m ? f.detectedAt : m), top.detectedAt),
    live: list.some((f) => f.live),
    members: sorted.map((f) => f.id),
  };
}

/**
 * Junta los hallazgos del mismo tipo (y la misma regla) en la misma sesion cuando son `minSize` o mas.
 * Reglas distintas no se juntan entre si. El orden de salida no esta definido: ordenar con sortFindings.
 */
export function groupFindings(findings: readonly Scored[], minSize: number): Scored[] {
  const out: Scored[] = [];
  for (const list of groupBy(findings, (f) => `${f.roomId}\u0000${f.kind}\u0000${f.ruleId ?? ''}`).values()) {
    if (list.length < minSize) out.push(...list);
    else out.push(merge(list));
  }
  return out;
}

/**
 * Ahorro total y por tipo sin contar dos veces las mismas llamadas del mismo agente: cuando varios tipos
 * reclaman las mismas (claims con la misma llave), cuenta solo el tipo que reclama mas. Lo que un hallazgo no
 * reclama suma directo. Se calcula sobre los hallazgos sin juntar (los juntados pierden sus reclamos).
 */
export function savingsTotals(findings: readonly Scored[]): { total: number; byKind: Map<HabitKind, number> } {
  const byKind = new Map<HabitKind, number>();
  const add = (kind: HabitKind, usd: number): void => {
    byKind.set(kind, (byKind.get(kind) ?? 0) + usd);
  };
  const claimed = new Map<string, Map<HabitKind, number>>();
  for (const f of findings) {
    const usd = f.savingsUsd ?? 0;
    if (usd <= 0) continue;
    let inClaims = 0;
    for (const c of f.claims ?? []) {
      const perKind = claimed.get(c.key) ?? new Map<HabitKind, number>();
      perKind.set(f.kind, (perKind.get(f.kind) ?? 0) + c.usd);
      claimed.set(c.key, perKind);
      inClaims += c.usd;
    }
    add(f.kind, Math.max(0, usd - inClaims));
  }
  for (const perKind of claimed.values()) {
    let best: [HabitKind, number] | null = null;
    for (const entry of perKind) if (!best || entry[1] > best[1]) best = entry;
    if (best) add(best[0], best[1]);
  }
  let total = 0;
  for (const [kind, usd] of byKind) {
    total += usd;
    byKind.set(kind, money(usd));
  }
  return { total: money(total), byKind };
}
