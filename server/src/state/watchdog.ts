import type { BudgetStatus, OfficeSnapshot } from '@shared/contract';
import type { Notifier } from './notifier';
import type { BudgetNotified, Settings } from './settings';

const usdFmt = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd = (n: number): string => `$${usdFmt.format(n)}`;

/** "2026-11-21" -> "21 nov" */
function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d));
}

/** con pestanas abiertas el snapshot ya se arma para ellas; sin ninguna, se arma solo para vigilar cada tanto */
const IDLE_CHECK_MS = 30_000;

export interface WatchdogDeps {
  settings: Settings;
  budget: () => BudgetStatus;
  snapshot: () => OfficeSnapshot;
  /** pestanas conectadas */
  clients: () => number;
  notifier: Notifier;
  clock: () => number;
}

/** texto del aviso del presupuesto al cruzar un umbral */
export function budgetNotice(b: BudgetStatus): { title: string; body: string } {
  const pct = Math.round(b.usedRatio * 100);
  const spent = `${usd(b.spentUsd)} de ${usd(b.budgetUsd)}`;
  if (b.threshold >= 100) {
    return { title: `Colmena: pasaste el presupuesto del mes (${pct} %)`, body: `Llevas ${spent}.` };
  }
  const tail = b.runOutDate ? ` A este ritmo se acaba el ${dayLabel(b.runOutDate)}.` : '';
  return { title: `Colmena: presupuesto al ${pct} %`, body: `Llevas ${spent}.${tail}` };
}

/**
 * Avisos del sistema. Los del presupuesto (umbral cruzado, proyeccion por encima, dia por encima del
 * recomendado, tope de un proyecto) salen siempre y una sola vez: lo ya avisado se guarda en settings. Las
 * alertas criticas y los agentes que esperan una respuesta solo salen por aqui cuando no hay ninguna pestana
 * abierta (con pestana ya avisa el navegador).
 */
export class Watchdog {
  private lastIdleCheck = 0;
  /** alertas y esperas ya avisadas (o presentes al arrancar): no se repiten mientras sigan vivas */
  private seen: Set<string> | null = null;

  constructor(private readonly deps: WatchdogDeps) {}

  check(): void {
    const { settings, notifier } = this.deps;
    if (!settings.system().notifyDesktop) return;
    this.checkBudget();

    if (this.deps.clients() > 0) {
      // el navegador se encarga; al quedar sin pestanas no se repite lo que ya estaba a la vista
      this.seen = null;
      return;
    }
    const now = this.deps.clock();
    if (this.seen !== null && now - this.lastIdleCheck < IDLE_CHECK_MS) return;
    this.lastIdleCheck = now;
    const live = this.liveKeys(this.deps.snapshot());
    if (this.seen === null) {
      this.seen = new Set(live.keys());
      return;
    }
    for (const [key, notice] of live) {
      if (!this.seen.has(key)) notifier.notify(notice.title, notice.body);
    }
    this.seen = new Set(live.keys());
  }

  private checkBudget(): void {
    const { settings, notifier } = this.deps;
    const b = this.deps.budget();
    const today = new Date(this.deps.clock());
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const saved = settings.budgetNotified();
    const prev: BudgetNotified =
      saved && saved.month === b.month ? saved : { month: b.month, threshold: 0, projected: false, dayOver: null, projects: [] };
    const next: BudgetNotified = { ...prev, projects: [...prev.projects] };

    if (b.threshold > prev.threshold) {
      const n = budgetNotice(b);
      notifier.notify(n.title, n.body);
      next.threshold = b.threshold;
    } else if (b.threshold < prev.threshold) {
      // el presupuesto subio o se ajusto el gasto: el umbral vuelve a poder avisar
      next.threshold = b.threshold;
    }
    if (b.projectedOver && !prev.projected) {
      notifier.notify(
        'Colmena: a este ritmo pasas el presupuesto',
        `El mes cerraria en ${usd(b.projectedUsd)} de ${usd(b.budgetUsd)}.${b.runOutDate ? ` Se acaba el ${dayLabel(b.runOutDate)}.` : ''}`,
      );
    }
    next.projected = b.projectedOver;
    if (b.dayOver && prev.dayOver !== todayKey && b.perDayUsd !== null) {
      notifier.notify(
        'Colmena: hoy ya pasaste el gasto recomendado',
        `Hoy llevas ${usd(b.todayUsd)}; lo recomendado por dia es ${usd(b.perDayUsd)}.`,
      );
      next.dayOver = todayKey;
    }
    for (const p of b.projectsOver) {
      if (next.projects.includes(p.project)) continue;
      notifier.notify(`Colmena: ${p.project} paso su tope del mes`, `Lleva ${usd(p.spentUsd)} de ${usd(p.capUsd)}.`);
      next.projects.push(p.project);
    }
    next.projects = next.projects.filter((name) => b.projectsOver.some((p) => p.project === name));

    if (JSON.stringify(next) !== JSON.stringify(saved)) settings.setBudgetNotified(next);
  }

  /** alertas criticas vivas y agentes que esperan respuesta, con el texto de su aviso */
  private liveKeys(snapshot: OfficeSnapshot): Map<string, { title: string; body: string }> {
    const out = new Map<string, { title: string; body: string }>();
    for (const room of snapshot.rooms) {
      if (room.alert?.level === 'critical') {
        out.set(`room:${room.id}:${room.alert.title.replace(/\d+(?:[.,]\d+)*/g, '#')}`, {
          title: `Colmena: alerta en ${room.title}`,
          body: room.alert.title,
        });
      }
      for (const agent of [room.lead, ...room.subagents]) {
        if (agent.status === 'done') continue;
        if (agent.alert?.level === 'critical') {
          out.set(`agent:${agent.id}:${agent.alert.title.replace(/\d+(?:[.,]\d+)*/g, '#')}`, {
            title: `Colmena: ${agent.displayName} · ${room.title}`,
            body: agent.alert.title,
          });
        }
        if (agent.waitingSince && room.open) {
          out.set(`wait:${agent.id}:${agent.waitingSince}`, {
            title: `Colmena: ${agent.displayName} espera tu respuesta`,
            body: `Sala ${room.title}`,
          });
        }
      }
    }
    return out;
  }
}
