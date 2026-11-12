import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { Siren, Users, X } from 'lucide-react';
import { agentsNow, type NowRow } from '@/lib/agentsNow';
import { elapsedMs, formatClock, formatUsd, formatUsdOrUnpriced } from '@/lib/format';
import { useOfficeStore } from '@/state/store';
import { DURATION, STATE } from '@/theme';
import { Portrait } from './PixelArt';
import { IconButton, Led, PanelState, STROKE } from './primitives';
import { SpendToggle } from './RankingTab';
import { useNow } from './useNow';
import { usePresence } from './usePresence';
import './agents-now.css';

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const WAITING_COLOR = 'var(--color-scene-amber)';

/**
 * "Agentes ahora" (L): todos los agentes que trabajan o esperan tu respuesta, en una tabla, sin navegar la
 * escena. Clic en una fila lleva la camara a su sala y abre su panel. El costo sigue "Mostrar gasto".
 */
export function AgentsNowModal() {
  const open = useOfficeStore((s) => s.agentsOpen);
  const { shown, leaving } = usePresence(open ? true : null, DURATION.modalOut);
  if (shown === null) return null;
  return <AgentsNowDialog leaving={leaving} />;
}

function AgentsNowDialog({ leaving }: { leaving: boolean }) {
  const close = useOfficeStore((s) => s.closeAgents);
  const snapshot = useOfficeStore((s) => s.snapshot);
  const showSpend = useOfficeStore((s) => s.showSpend);
  const toggleSpend = useOfficeStore((s) => s.toggleSpend);
  const now = useNow(1_000);
  const view = agentsNow(snapshot);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const trapFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const openAgent = (row: NowRow) => {
    const store = useOfficeStore.getState();
    store.closeAgents();
    store.focusRoom(row.roomId);
    store.selectAgent(row.agentId);
  };

  const summary = [
    `${view.working} trabajando`,
    view.waiting > 0 ? `${view.waiting} ${view.waiting === 1 ? 'espera' : 'esperan'} tu respuesta` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <div aria-hidden className={`scrim ${leaving ? 'is-leaving' : ''}`} onClick={close} />
      <div className="modal-wrap">
        <section
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="agents-now-title"
          tabIndex={-1}
          onKeyDown={trapFocus}
          className={`modal agents-now-modal ${leaving ? 'is-leaving' : ''}`}
        >
          <header className="modal-head an-head">
            <Users size={18} strokeWidth={STROKE} aria-hidden className="an-head-icon" />
            <div className="an-head-text">
              <h2 id="agents-now-title" className="modal-title display">
                Agentes ahora
              </h2>
              {view.rows.length > 0 ? <span className="an-summary">{summary}</span> : null}
            </div>
            {showSpend && view.rows.length > 0 ? (
              <span className="an-total" title="Suma de lo que llevan las tareas en curso (valor equivalente API)">
                <span className="label">En curso</span>
                <b className="num">{formatUsd(view.costUsd)}</b>
                {view.unpriced > 0 ? <span className="an-muted">+{view.unpriced} sin precio</span> : null}
              </span>
            ) : null}
            <div className="modal-close">
              <SpendToggle shown={showSpend} onToggle={toggleSpend} />
              <kbd className="kbd">Esc</kbd>
              <IconButton label="Cerrar (Esc)" onClick={close}>
                <X size={16} strokeWidth={STROKE} />
              </IconButton>
            </div>
          </header>
          <div className="modal-body an-body">
            {view.rows.length === 0 ? (
              <PanelState
                kind="empty"
                title="Nadie trabajando ahora"
                text="Cuando un agente empiece una tarea, aparece aquí con lo que hace y cuánto lleva."
              />
            ) : (
              <table className="an-table">
                <thead>
                  <tr>
                    <th scope="col">Agente</th>
                    <th scope="col">Sala</th>
                    <th scope="col">Tarea</th>
                    <th scope="col">Ahora</th>
                    <th scope="col" className="an-num">
                      Tiempo
                    </th>
                    {showSpend ? (
                      <th scope="col" className="an-num">
                        Costo
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row) => (
                    <AgentRow key={row.agentId} row={row} now={now} showSpend={showSpend} onOpen={openAgent} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <footer className="an-foot">
            Clic en un agente para ver su panel. El costo del líder es el de su turno; el de un subagente, su tarea
            completa.
          </footer>
        </section>
      </div>
    </>
  );
}

function AgentRow({
  row,
  now,
  showSpend,
  onOpen,
}: {
  row: NowRow;
  now: number;
  showSpend: boolean;
  onOpen: (row: NowRow) => void;
}) {
  const waiting = row.state === 'waiting';
  const meta = [row.lead ? 'Líder' : row.role, row.model !== '—' ? row.model : null].filter(Boolean).join(' · ');
  return (
    <tr
      className={`an-row ${waiting ? 'is-waiting' : ''} ${row.alert ? 'is-alert' : ''}`}
      style={{ '--room': row.roomAccent } as CSSProperties}
      tabIndex={0}
      onClick={() => onOpen(row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(row);
        }
      }}
      aria-label={`${row.name}, ${row.roomTitle}: ${row.doing}. Abrir su panel`}
    >
      <td>
        <span className="an-agent">
          <Portrait agentType={row.look} size={28} />
          <span className="an-agent-text">
            <span className="an-name">{row.name}</span>
            {meta ? <span className="an-muted">{meta}</span> : null}
          </span>
        </span>
      </td>
      <td>
        <span className="an-room" title={row.roomTitle}>
          <span className="an-room-num num">{String(row.roomNumber).padStart(2, '0')}</span>
          <span className="an-ellipsis">{row.roomTitle}</span>
        </span>
      </td>
      <td className="an-task">
        <span className="an-clamp" title={row.task}>
          {row.task}
        </span>
      </td>
      <td>
        <span className="an-doing">
          {row.alert ? (
            <Siren size={14} strokeWidth={STROKE} aria-hidden className="an-alert-icon" />
          ) : waiting ? (
            <Led mode="blink" color={WAITING_COLOR} />
          ) : (
            <Led mode="blink" color={STATE.working} />
          )}
          <span className="an-ellipsis" title={row.alert ? `${row.doing} · ${row.alert.title}` : row.doing}>
            {row.alert ? row.alert.title : row.doing}
          </span>
        </span>
      </td>
      <td className="an-num num">{row.since ? formatClock(elapsedMs(row.since, null, now)) : '—'}</td>
      {showSpend ? <td className="an-num num">{formatUsdOrUnpriced(row.costUsd)}</td> : null}
    </tr>
  );
}
