import { useEffect, useState } from 'react';
import { PiggyBank, X } from 'lucide-react';
import { budgetNotice, markSeen, reconcileSeen, type BudgetSeen } from '@/lib/budgetAlert';
import { localDateKey } from '@/lib/history';
import { useOfficeStore } from '@/state/store';
import { IconButton, STROKE } from '../primitives';
import './extras.css';

const SEEN_KEY = 'colmena.budget.seen';

function readSeen(): BudgetSeen | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? 'null') as Partial<BudgetSeen> | null;
    if (!v || typeof v.month !== 'string' || typeof v.threshold !== 'number') return null;
    return {
      month: v.month,
      threshold: v.threshold,
      projected: v.projected === true,
      day: typeof v.day === 'string' ? v.day : null,
      projects: Array.isArray(v.projects) ? v.projects.filter((p): p is string => typeof p === 'string') : [],
    };
  } catch {
    return null;
  }
}

function writeSeen(seen: BudgetSeen): void {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // sin almacenamiento: el aviso vuelve a salir en la proxima carga
  }
}

/**
 * Aviso del presupuesto sobre la escena: sale una vez al cruzar el 50, 75, 90 y 100 % del mes, cuando la
 * proyeccion pasa el tope, cuando un proyecto pasa el suyo o cuando hoy se gasto mas de lo recomendado. No
 * tapa el trabajo: es una franja que se cierra con un clic.
 */
export function BudgetBanner() {
  const budget = useOfficeStore((s) => s.snapshot?.budget);
  const demo = useOfficeStore((s) => s.demo);
  const historyOpen = useOfficeStore((s) => s.historyOpen);
  const openHistory = useOfficeStore((s) => s.openHistory);
  const [seen, setSeen] = useState<BudgetSeen | null>(() => readSeen());

  useEffect(() => {
    if (!budget) return;
    const next = reconcileSeen(budget, seen);
    if (JSON.stringify(next) !== JSON.stringify(seen)) {
      setSeen(next);
      writeSeen(next);
    }
  }, [budget, seen]);

  if (!budget || demo || historyOpen) return null;
  const today = localDateKey(Date.now());
  const notice = budgetNotice(budget, seen, today);
  if (!notice) return null;

  const dismiss = () => {
    const next = markSeen(budget, today);
    setSeen(next);
    writeSeen(next);
  };

  return (
    <div className={`x-banner ${notice.tone === 'over' ? 'is-over' : ''}`} role="alert">
      <PiggyBank size={18} strokeWidth={STROKE} aria-hidden />
      <div className="x-banner-text">
        <b>{notice.title}</b>
        <span className="x-small">{notice.detail}</span>
      </div>
      <div className="x-banner-actions">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => {
            dismiss();
            openHistory('budget');
          }}
        >
          Ver presupuesto
        </button>
        <IconButton label="Entendido" onClick={dismiss}>
          <X size={14} strokeWidth={STROKE} />
        </IconButton>
      </div>
    </div>
  );
}
