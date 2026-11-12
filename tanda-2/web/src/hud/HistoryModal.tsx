import { useEffect, useRef, type KeyboardEvent } from 'react';
import {
  BellRing,
  Calculator,
  Compass,
  Gauge,
  Lightbulb,
  ListChecks,
  PiggyBank,
  Receipt,
  Scale,
  Trophy,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useOfficeStore, type HistoryTab } from '@/state/store';
import { DURATION } from '@/theme';
import { BudgetTab } from './BudgetTab';
import { CompareTab } from './CompareTab';
import { CostsTab } from './CostsTab';
import { HabitsTab } from './HabitsTab';
import { IconButton, PanelState, STROKE } from './primitives';
import { RankingTab } from './RankingTab';
import { RulesTab } from './RulesTab';
import { SimulatorTab } from './SimulatorTab';
import { TasksTab } from './TasksTab';
import { usePresence } from './usePresence';
import './insights.css';

export type HistoryGroupId = 'spend' | 'efficiency' | 'rules';

export interface HistoryTabDef {
  id: HistoryTab;
  label: string;
  Icon: LucideIcon;
}

export interface HistoryGroupDef {
  id: HistoryGroupId;
  label: string;
  Icon: LucideIcon;
  tabs: [HistoryTabDef, ...HistoryTabDef[]];
}

const SPEND_GROUP: HistoryGroupDef = {
  id: 'spend',
  label: 'Gasto',
  Icon: Wallet,
  tabs: [
    { id: 'budget', label: 'Presupuesto', Icon: PiggyBank },
    { id: 'costs', label: 'Costos', Icon: Receipt },
    { id: 'ranking', label: 'Ranking', Icon: Trophy },
    { id: 'tasks', label: 'Tareas', Icon: ListChecks },
  ],
};

/**
 * Pestanas del historial en tres grupos: la fila de arriba lleva solo los grupos (cabe en 880 px) y
 * cada grupo con mas de una pestana muestra su fila debajo.
 */
export const HISTORY_GROUPS: HistoryGroupDef[] = [
  SPEND_GROUP,
  {
    id: 'efficiency',
    label: 'Eficiencia',
    Icon: Gauge,
    tabs: [
      { id: 'habits', label: 'Hábitos', Icon: Lightbulb },
      { id: 'compare', label: 'Comparador', Icon: Scale },
      { id: 'simulator', label: 'Simulador', Icon: Calculator },
    ],
  },
  { id: 'rules', label: 'Reglas', Icon: BellRing, tabs: [{ id: 'rules', label: 'Reglas', Icon: BellRing }] },
];

export function historyGroupOf(tab: HistoryTab): HistoryGroupDef {
  return HISTORY_GROUPS.find((g) => g.tabs.some((t) => t.id === tab)) ?? SPEND_GROUP;
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Primer y ultimo elemento al que llega Tab dentro del modal. Quedan fuera los botones con tabIndex -1
 * (pestanas inactivas, periodos, dias del calendario: se recorren con flechas) y lo que no se ve.
 */
export function tabStops(root: ParentNode, active: Element | null): { first: HTMLElement; last: HTMLElement } | null {
  const stops = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && (el.offsetParent !== null || el === active),
  );
  const first = stops[0];
  const last = stops[stops.length - 1];
  return first && last ? { first, last } : null;
}

/** indice destino de las flechas en una fila de pestanas; null si la tecla no mueve */
function stepIndex(key: string, index: number, length: number): number | null {
  if (key === 'ArrowRight') return (index + 1) % length;
  if (key === 'ArrowLeft') return (index - 1 + length) % length;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  return null;
}

/** Historial (D3): modal con pestanas agrupadas en Gasto, Eficiencia y Reglas; se abre con H y se cierra con Esc */
export function HistoryModal() {
  const open = useOfficeStore((s) => s.historyOpen);
  const { shown, leaving } = usePresence(open ? true : null, DURATION.modalOut);
  if (!shown) return null;
  return <HistoryDialog leaving={leaving} />;
}

/** Una rama por pestana: nada de ternarios encadenados donde la rama final atrapa a las nuevas */
function TabContent({ tab }: { tab: HistoryTab }) {
  switch (tab) {
    case 'budget':
      return <BudgetTab />;
    case 'costs':
      return <CostsTab />;
    case 'ranking':
      return <RankingTab />;
    case 'tasks':
      return <TasksTab />;
    case 'habits':
      return <HabitsTab />;
    case 'compare':
      return <CompareTab />;
    case 'simulator':
      return <SimulatorTab />;
    case 'rules':
      return <RulesTab />;
  }
}

function HistoryDialog({ leaving }: { leaving: boolean }) {
  const tab = useOfficeStore((s) => s.historyTab);
  const demo = useOfficeStore((s) => s.demo);
  const openHistory = useOfficeStore((s) => s.openHistory);
  const close = useOfficeStore((s) => s.closeHistory);
  const dialogRef = useRef<HTMLElement>(null);
  const groupRefs = useRef<Partial<Record<HistoryGroupId, HTMLButtonElement | null>>>({});
  const tabRefs = useRef<Partial<Record<HistoryTab, HTMLButtonElement | null>>>({});
  // ultima pestana vista de cada grupo: volver al grupo vuelve a ella
  const lastInGroup = useRef<Partial<Record<HistoryGroupId, HistoryTab>>>({});
  const group = historyGroupOf(tab);
  const nested = group.tabs.length > 1;

  useEffect(() => {
    lastInGroup.current[group.id] = tab;
  }, [group.id, tab]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initial = useOfficeStore.getState().historyTab;
    (tabRefs.current[initial] ?? groupRefs.current[historyGroupOf(initial).id])?.focus();
    return () => previous?.focus();
  }, []);

  // cambiar de pestana desde adentro (p.ej. "Ver hábitos") desmonta el boton que tenia el foco: sin esto
  // el foco cae al body y el siguiente Tab sale del modal
  useEffect(() => {
    const root = dialogRef.current;
    if (!root || root.contains(document.activeElement)) return;
    (tabRefs.current[tab] ?? groupRefs.current[group.id])?.focus();
  }, [tab, group.id]);

  const trapFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const root = dialogRef.current;
    const stops = root ? tabStops(root, document.activeElement) : null;
    if (!root || !stops) return;
    const { first, last } = stops;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const selectGroup = (target: HistoryGroupDef) => {
    openHistory(lastInGroup.current[target.id] ?? target.tabs[0].id);
  };

  const moveGroup = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = HISTORY_GROUPS.findIndex((g) => g.id === group.id);
    const next = stepIndex(event.key, index, HISTORY_GROUPS.length);
    const target = next === null ? undefined : HISTORY_GROUPS[next];
    if (!target) return;
    event.preventDefault();
    selectGroup(target);
    groupRefs.current[target.id]?.focus();
  };

  const moveTab = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = group.tabs.findIndex((t) => t.id === tab);
    const next = stepIndex(event.key, index, group.tabs.length);
    const target = next === null ? undefined : group.tabs[next];
    if (!target) return;
    event.preventDefault();
    openHistory(target.id);
    tabRefs.current[target.id]?.focus();
  };

  return (
    <>
      <div aria-hidden className={`scrim ${leaving ? 'is-leaving' : ''}`} onClick={close} />
      <div className="modal-wrap">
        <section
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="history-title"
          tabIndex={-1}
          onKeyDown={trapFocus}
          className={`modal history-modal ${leaving ? 'is-leaving' : ''}`}
        >
          <header className="modal-head">
            {/* se abre desde Hábitos (A) o la barra del mes: el usuario lo conoce como Hábitos */}
            <h2 id="history-title" className="modal-title display">
              Hábitos
            </h2>
            <div role="tablist" aria-label="Secciones del historial" className="tabs" onKeyDown={moveGroup}>
              {HISTORY_GROUPS.map((g) => (
                <button
                  key={g.id}
                  ref={(el) => {
                    groupRefs.current[g.id] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`history-group-${g.id}`}
                  aria-selected={group.id === g.id}
                  aria-controls="history-panel"
                  tabIndex={group.id === g.id ? 0 : -1}
                  className="tab display"
                  onClick={() => selectGroup(g)}
                >
                  <g.Icon size={16} strokeWidth={STROKE} aria-hidden />
                  {g.label}
                </button>
              ))}
            </div>
            <div className="modal-close">
              <button
                type="button"
                className="modal-guide"
                onClick={() => useOfficeStore.getState().openTour()}
                aria-haspopup="dialog"
                title="Repetir la guía de la oficina"
                data-tour="guide"
              >
                <Compass size={14} strokeWidth={STROKE} aria-hidden />
                Guía
              </button>
              <IconButton label="Cerrar (Esc)" onClick={close}>
                <X size={16} strokeWidth={STROKE} />
              </IconButton>
            </div>
          </header>
          <div id="history-panel" role="tabpanel" aria-labelledby={`history-group-${group.id}`} className="history-group">
            {nested ? (
              <div role="tablist" aria-label={group.label} className="subtabs" onKeyDown={moveTab}>
                {group.tabs.map((t) => (
                  <button
                    key={t.id}
                    ref={(el) => {
                      tabRefs.current[t.id] = el;
                    }}
                    type="button"
                    role="tab"
                    id={`history-tab-${t.id}`}
                    aria-selected={tab === t.id}
                    aria-controls="history-subpanel"
                    tabIndex={tab === t.id ? 0 : -1}
                    className="subtab"
                    onClick={() => openHistory(t.id)}
                  >
                    <t.Icon size={14} strokeWidth={STROKE} aria-hidden />
                    {t.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div
              key={tab}
              id="history-subpanel"
              role={nested ? 'tabpanel' : undefined}
              aria-labelledby={nested ? `history-tab-${tab}` : undefined}
              className="modal-body"
              data-tab={tab}
            >
              {demo ? (
                <PanelState
                  kind="empty"
                  title="El historial necesita el servidor"
                  text="En modo demo los datos son simulados en el navegador. Con npm run dev corriendo verás aquí el gasto, los hábitos y las reglas."
                />
              ) : (
                <TabContent tab={tab} />
              )}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
