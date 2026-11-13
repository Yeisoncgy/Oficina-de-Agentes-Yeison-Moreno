import type { BudgetResponse, HistoryRange, RankingRow, TaskRow, TasksResponse } from '@shared/contract';
import { capitalize, formatDayMonth, formatDayRange, formatMonthLabel, formatWeekdayDateLong, pad2 } from './format';

// ---- Presupuesto ----

export type BudgetTone = 'ok' | 'warn' | 'over';

export interface BudgetGauge {
  /** valor que ocupa el 100 % del ancho: max(presupuesto, proyeccion, gastado) */
  scaleMax: number;
  spentPct: number;
  projectedPct: number;
  budgetPct: number;
  /** gastado / presupuesto (puede pasar de 1) */
  usedRatio: number;
  /** proyeccion / presupuesto */
  projectedRatio: number;
  /** presupuesto - gastado; negativo = excedido */
  remainingUsd: number;
  /** cuanto pasaria la proyeccion por encima del presupuesto (0 si no pasa) */
  projectedOverUsd: number;
  tone: BudgetTone;
}

const positive = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);
const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

export function budgetGauge(b: Pick<BudgetResponse, 'spentUsd' | 'projectedUsd' | 'budgetUsd'>): BudgetGauge {
  const spent = positive(b.spentUsd);
  const projected = Math.max(positive(b.projectedUsd), spent);
  const budget = positive(b.budgetUsd);
  const scaleMax = Math.max(budget, projected, spent) || 1;
  const tone: BudgetTone =
    budget > 0 && spent >= budget ? 'over' : budget > 0 && projected > budget ? 'warn' : 'ok';
  return {
    scaleMax,
    spentPct: clampPct((spent / scaleMax) * 100),
    projectedPct: clampPct((projected / scaleMax) * 100),
    budgetPct: clampPct((budget / scaleMax) * 100),
    usedRatio: budget > 0 ? spent / budget : 0,
    projectedRatio: budget > 0 ? projected / budget : 0,
    remainingUsd: budget - spent,
    projectedOverUsd: Math.max(0, projected - budget),
    tone,
  };
}

/** Segmentos encendidos de una barra pixel: cualquier valor > 0 enciende al menos uno */
export function filledSegments(ratio: number, total: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0 || total <= 0) return 0;
  return Math.min(total, Math.max(1, Math.round(ratio * total)));
}

function parseMonth(month: string): [number, number] {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) {
    const now = new Date();
    return [now.getFullYear(), now.getMonth() + 1];
  }
  return [Number(match[1]), Number(match[2])];
}

/** 'YYYY-MM' en hora local */
export function currentMonth(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 'YYYY-MM-DD' en hora local */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = parseMonth(month);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function daysInMonth(month: string): number {
  const [y, m] = parseMonth(month);
  return new Date(y, m, 0).getDate();
}

/**
 * Ritmo diario que agota el presupuesto justo al cierre del mes: por dia laboral si el server mando
 * cuantos tiene el mes (workdays.total); si no, por dia calendario.
 */
export function dailyPace(budgetUsd: number, month: string, workdaysTotal?: number | null): number {
  if (!(budgetUsd > 0)) return 0;
  return workdaysTotal && workdaysTotal > 0 ? budgetUsd / workdaysTotal : budgetUsd / daysInMonth(month);
}

/** sabado o domingo ('YYYY-MM-DD', dia local) */
export function isWeekend(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getDay();
  return day === 0 || day === 6;
}

/**
 * Pie de "Recomendado". El server cuenta hoy entre los laborales que faltan solo si hoy es laboral (ni
 * fin de semana ni dia libre), asi que "(con hoy)" va solo en ese caso.
 */
export function remainingWorkdaysText(remaining: number, month: string, daysOff: readonly string[], nowMs: number): string {
  if (!(remaining > 0)) return 'no quedan días laborales';
  const today = localDateKey(nowMs);
  const withToday = today.startsWith(`${month}-`) && !isWeekend(today) && !daysOff.includes(today);
  if (remaining === 1) return withToday ? 'para hoy, el último día laboral' : 'en el día laboral que falta';
  return `por día en los ${remaining} laborales que faltan${withToday ? ' (con hoy)' : ''}`;
}

export interface DayBar {
  day: number;
  date: string;
  costUsd: number;
  isToday: boolean;
  isFuture: boolean;
  /** lunes a viernes y no marcado como libre */
  isWorkday: boolean;
}

/** Pista del presupuesto (D3): todo relativo al presupuesto; la proyeccion se topa en el 100 % */
export interface BudgetTrack {
  spentPct: number;
  projectedPct: number;
  /** la proyeccion pasa el presupuesto */
  over: boolean;
}

export function budgetTrack(b: Pick<BudgetResponse, 'spentUsd' | 'projectedUsd' | 'budgetUsd'>): BudgetTrack {
  const budget = positive(b.budgetUsd);
  const spent = positive(b.spentUsd);
  const projected = Math.max(positive(b.projectedUsd), spent);
  if (budget === 0) return { spentPct: 0, projectedPct: 0, over: false };
  return {
    spentPct: clampPct((spent / budget) * 100),
    projectedPct: clampPct((projected / budget) * 100),
    over: projected > budget,
  };
}

export interface ChartScale {
  /** valor del 100 % del alto */
  max: number;
  /** lineas guia: 0, paso y 2 pasos (0 %, 40 % y 80 % del alto) */
  ticks: number[];
}

/** Escala del grafico diario con pasos redondos (1 · 2 · 2,5 · 5 x 10^n) */
export function chartScale(maxValue: number): ChartScale {
  const target = Math.max(Number.isFinite(maxValue) ? maxValue : 0, 0.01) / 2.2;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= target) ?? 10 * magnitude;
  return { max: step * 2.5, ticks: [0, step, step * 2] };
}

/** Rotulo del rango del ranking (D3): Lunes 28 sep · 22 – 28 sep · Septiembre 2026 · Todo el historial */
export function rangeCaption(range: HistoryRange, nowMs: number): string {
  switch (range) {
    case 'today':
      return capitalize(formatWeekdayDateLong(nowMs));
    case 'week': {
      const from = new Date(nowMs);
      from.setDate(from.getDate() - 6);
      return formatDayRange(from.getTime(), nowMs);
    }
    case 'month':
      return formatMonthLabel(currentMonth(nowMs));
    case 'all':
      return 'Todo el historial';
  }
}

/** Todos los dias del mes (los que no vienen del server quedan en 0) */
export function monthDays(
  month: string,
  daily: BudgetResponse['daily'],
  nowMs: number,
  daysOff: readonly string[] = [],
): DayBar[] {
  const [y, m] = parseMonth(month);
  const total = new Date(y, m, 0).getDate();
  const byDate = new Map<string, number>();
  for (const d of daily) {
    const key = d.date.slice(0, 10);
    const cost = Number.isFinite(d.costUsd) ? d.costUsd : 0;
    byDate.set(key, (byDate.get(key) ?? 0) + cost);
  }
  const off = new Set(daysOff);
  const today = localDateKey(nowMs);
  return Array.from({ length: total }, (_, i) => {
    const date = `${y}-${pad2(m)}-${pad2(i + 1)}`;
    return {
      day: i + 1,
      date,
      costUsd: byDate.get(date) ?? 0,
      isToday: date === today,
      isFuture: date > today,
      isWorkday: !isWeekend(date) && !off.has(date),
    };
  });
}

export interface CalendarDay {
  date: string;
  day: number;
  weekend: boolean;
  /** dia libre marcado por el usuario (solo entre semana) */
  off: boolean;
  isToday: boolean;
}

/**
 * Mini calendario del mes en semanas de lunes a domingo; null = casilla vacia antes del 1 o despues del
 * ultimo dia.
 */
export function monthCalendar(month: string, daysOff: readonly string[], nowMs: number): (CalendarDay | null)[][] {
  const [y, m] = parseMonth(month);
  const total = new Date(y, m, 0).getDate();
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const off = new Set(daysOff);
  const today = localDateKey(nowMs);
  const cells: (CalendarDay | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= total; day++) {
    const date = `${y}-${pad2(m)}-${pad2(day)}`;
    const weekend = isWeekend(date);
    cells.push({ date, day, weekend, off: !weekend && off.has(date), isToday: date === today });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

/**
 * Monto escrito en formato es-CO -> numero; null si no se lee. '1.234,50' y '1.234' usan punto de miles;
 * '2,5' coma decimal. Un punto que no separa grupos de 3 cifras se toma como decimal ('2.50' = 2,5), para
 * que un monto chico escrito a la inglesa no se vuelva cien veces mayor. Un 0 delante tampoco abre un
 * grupo de miles: '0.500' = 0,5, no 500.
 */
export function parseEsNumber(text: string): number | null {
  const t = text.trim().replace(/^\$\s*/, '');
  if (/^[1-9]\d{0,2}(\.\d{3})+(,\d+)?$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  if (/^\d+(,\d+)?$/.test(t)) return Number(t.replace(',', '.'));
  if (/^\d+\.\d+$/.test(t)) return Number(t);
  return null;
}

const inputUsdFmt = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inputCountFmt = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

/** valor inicial de un campo editable: 2 -> '2,00' (usd) · 30 -> '30' (conteo) */
export function formatEsInput(n: number, unit: 'usd' | 'count'): string {
  return unit === 'usd' ? inputUsdFmt.format(n) : inputCountFmt.format(n);
}

// ---- Ranking ----

export interface RankedRow {
  row: RankingRow;
  rank: number;
  /** 0..1 relativo al primero (por USD; por tokens si nadie tiene costo) */
  share: number;
}

export function rankRows(rows: readonly RankingRow[]): RankedRow[] {
  const sorted = [...rows].sort((a, b) => b.costUsd - a.costUsd || b.tokens.total - a.tokens.total);
  const maxCost = sorted.reduce((max, r) => Math.max(max, r.costUsd), 0);
  const maxTokens = sorted.reduce((max, r) => Math.max(max, r.tokens.total), 0);
  return sorted.map((row, i) => ({
    row,
    rank: i + 1,
    share: maxCost > 0 ? row.costUsd / maxCost : maxTokens > 0 ? row.tokens.total / maxTokens : 0,
  }));
}

// ---- Tareas ----

export function flattenTaskPages(pages: readonly TasksResponse[]): TaskRow[] {
  const seen = new Set<string>();
  const out: TaskRow[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

export interface TaskGroup {
  key: string;
  label: string;
  items: TaskRow[];
  /** suma de los costos conocidos del dia */
  costUsd: number;
}

/** Agrupa por dia local de fin, conservando el orden en que llegan */
export function groupTasksByDay(items: readonly TaskRow[], nowMs: number): TaskGroup[] {
  const today = localDateKey(nowMs);
  const y = new Date(nowMs);
  y.setDate(y.getDate() - 1);
  const yesterday = localDateKey(y.getTime());
  const groups = new Map<string, TaskGroup>();
  for (const item of items) {
    const endedMs = Date.parse(item.endedAt);
    const key = Number.isNaN(endedMs) ? 'sin-fecha' : localDateKey(endedMs);
    let group = groups.get(key);
    if (!group) {
      const label =
        key === today ? 'Hoy' : key === yesterday ? 'Ayer' : key === 'sin-fecha' ? 'Sin fecha' : formatDayMonth(endedMs, nowMs);
      group = { key, label, items: [], costUsd: 0 };
      groups.set(key, group);
    }
    group.items.push(item);
    group.costUsd += item.costUsd ?? 0;
  }
  return [...groups.values()];
}
