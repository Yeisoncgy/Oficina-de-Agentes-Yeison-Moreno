// Aviso del presupuesto dentro de la app: que decir cuando el mes cruza un umbral. Logica pura; lo dibuja
// hud/extras/BudgetBanner.tsx y lo que ya se aviso se recuerda en localStorage (una vez por umbral y mes).
import type { BudgetStatus } from '@shared/contract';
import { formatDayMonth, formatPercent, formatUsd } from './format';

export interface BudgetSeen {
  month: string;
  threshold: number;
  projected: boolean;
  /** dia local en que ya se aviso el exceso del dia */
  day: string | null;
  projects: string[];
}

export interface BudgetNotice {
  /** over: ya se paso el tope del mes · warn: va camino a pasarlo */
  tone: 'over' | 'warn';
  title: string;
  detail: string;
}

export const EMPTY_SEEN: BudgetSeen = { month: '', threshold: 0, projected: false, day: null, projects: [] };

const dayText = (date: string): string => formatDayMonth(`${date}T12:00:00`);

/** lo visto, descartando lo de otro mes */
export function seenFor(seen: BudgetSeen | null, month: string): BudgetSeen {
  return seen && seen.month === month ? seen : { ...EMPTY_SEEN, month };
}

/** el aviso mas importante que aun no se ha visto; null si no hay nada nuevo que decir */
export function budgetNotice(b: BudgetStatus, rawSeen: BudgetSeen | null, today: string): BudgetNotice | null {
  const seen = seenFor(rawSeen, b.month);
  const spent = `${formatUsd(b.spentUsd)} de ${formatUsd(b.budgetUsd)}`;
  if (b.threshold > seen.threshold) {
    if (b.threshold >= 100) {
      return {
        tone: 'over',
        title: `Pasaste el presupuesto del mes: ${spent} (${formatPercent(b.usedRatio)})`,
        detail: b.crossedDate ? `El gasto pasó el tope el ${dayText(b.crossedDate)}. Todo lo que sigue es exceso.` : 'Todo lo que sigue es exceso.',
      };
    }
    return {
      tone: 'warn',
      title: `Vas en el ${b.threshold} % del presupuesto: ${spent}`,
      detail: b.runOutDate
        ? `A este ritmo se acaba el ${dayText(b.runOutDate)}.`
        : b.perDayUsd !== null
          ? `Te quedan ${formatUsd(b.perDayUsd)} por día laboral.`
          : 'Ya no quedan días laborales este mes.',
    };
  }
  if (b.projectedOver && !seen.projected) {
    return {
      tone: 'warn',
      title: `A este ritmo cierras el mes en ${formatUsd(b.projectedUsd)}, por encima de ${formatUsd(b.budgetUsd)}`,
      detail: b.runOutDate ? `El presupuesto se acaba el ${dayText(b.runOutDate)}.` : `Llevas ${spent}.`,
    };
  }
  const project = b.projectsOver.find((p) => !seen.projects.includes(p.project));
  if (project) {
    return {
      tone: 'warn',
      title: `${project.project} pasó su tope del mes`,
      detail: `Lleva ${formatUsd(project.spentUsd)} de ${formatUsd(project.capUsd)}.`,
    };
  }
  if (b.dayOver && seen.day !== today && b.perDayUsd !== null) {
    return {
      tone: 'warn',
      title: `Hoy ya pasaste el gasto recomendado: ${formatUsd(b.todayUsd)}`,
      detail: `Para llegar a fin de mes, lo recomendado es ${formatUsd(b.perDayUsd)} por día laboral.`,
    };
  }
  return null;
}

/** lo que queda visto al cerrar el aviso: todo lo que el estado muestra ahora */
export function markSeen(b: BudgetStatus, today: string): BudgetSeen {
  return {
    month: b.month,
    threshold: b.threshold,
    projected: b.projectedOver,
    day: b.dayOver ? today : null,
    projects: b.projectsOver.map((p) => p.project),
  };
}

/** el umbral baja si se sube el presupuesto o se ajusta el gasto: lo visto baja con el para poder avisar de nuevo */
export function reconcileSeen(b: BudgetStatus, rawSeen: BudgetSeen | null): BudgetSeen {
  const seen = seenFor(rawSeen, b.month);
  return {
    ...seen,
    threshold: Math.min(seen.threshold, b.threshold),
    projected: seen.projected && b.projectedOver,
    projects: seen.projects.filter((name) => b.projectsOver.some((p) => p.project === name)),
  };
}
