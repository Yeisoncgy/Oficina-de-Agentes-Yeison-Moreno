import { useCallback, useMemo } from 'react';
import { QualityControl } from './QualityControl';
import { TimeControl } from './TimeControl';
import {
  Box,
  Lightbulb,
  ListTodo,
  LoaderCircle,
  RefreshCw,
  Rows3,
  Siren,
  TriangleAlert,
  Users,
  WifiOff,
  Workflow,
} from 'lucide-react';
import { agentsNow } from '@/lib/agentsNow';
import { formatDayMonth, formatMonthLabel, formatMonthShort, formatPercent, formatTokens, formatUsd } from '@/lib/format';
import { budgetGauge, budgetTrack, currentMonth } from '@/lib/history';
import { habitsBadge } from '@/lib/office';
import { isLiteMode } from '@/lib/stream';
import { pendingTodos } from '@/lib/todo';
import { activeRunCount, collectRuns, toggleFlowRoom } from '@/lib/workflows';
import { useBudget } from '@/state/api';
import { useOfficeStore, type ConnectionState } from '@/state/store';
import { useHudEdge } from './hudInsets';
import { Led, STROKE } from './primitives';
import { useFitLevel } from './useFitLevel';
import './extras/extras.css';

/**
 * Barra de arriba (D3): una sola franja con tres grupos que nunca se montan. Vista (izquierda): conexion, vista
 * ligera u oficina 3D, hora y calidad · dinero (centro): hoy, el mes contra el tope y el ritmo · paneles
 * (derecha): Pendientes, Agentes, Flujos y Habitos. Cuanto se recorta lo decide useFitLevel midiendo lo que
 * lleva (data-fit); la franja entera publica su borde de abajo (hudInsets), sea una fila o varias.
 */
export function TopBar() {
  const edgeRef = useHudEdge('top');
  const fitRef = useFitLevel();
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return undefined;
      const edge = edgeRef(el);
      const fit = fitRef(el);
      return () => {
        fit?.();
        edge?.();
      };
    },
    [edgeRef, fitRef],
  );
  return (
    <div ref={ref} className="hud-top">
      <ViewGroup />
      <MoneyGroup />
      <PanelsGroup />
    </div>
  );
}

/** Grupo de la vista: estado de la conexion, vista ligera u oficina 3D y, en la oficina, la hora y la calidad */
function ViewGroup() {
  const connection = useOfficeStore((s) => s.connection);
  const hasSnapshot = useOfficeStore((s) => s.snapshot !== null);
  const demo = useOfficeStore((s) => s.demo);
  const lite = isLiteMode(window.location.search);
  return (
    <div className="hud-bar hud-bar--view win">
      <div className="bar-seg" role="status" aria-live="polite">
        <ConnectionStatus connection={connection} hasSnapshot={hasSnapshot} demo={demo} />
      </div>
      {demo ? (
        <div className="bar-seg">
          <span className="tag-demo" title="Datos simulados en el navegador: no se conecta al servidor">
            DEMO
          </span>
        </div>
      ) : (
        <div className="bar-seg x-view-seg">
          <a
            className="btn btn--sm"
            href={lite ? '?' : '?lite=1'}
            aria-label={lite ? 'Oficina 3D' : 'Vista ligera'}
            title={lite ? 'Volver a la oficina 3D' : 'Vista ligera: los mismos datos sin la oficina 3D'}
          >
            {lite ? <Box size={12} strokeWidth={STROKE} aria-hidden /> : <Rows3 size={12} strokeWidth={STROKE} aria-hidden />}
            <span className="btn-label">{lite ? 'Oficina 3D' : 'Vista ligera'}</span>
          </a>
        </div>
      )}
      {lite ? null : (
        <div className="bar-seg">
          <TimeControl />
          <QualityControl />
        </div>
      )}
    </div>
  );
}

/** Grupo de los paneles: los cuatro botones abren un panel; la insignia cuenta lo que espera */
function PanelsGroup() {
  return (
    <div className="hud-bar hud-bar--panels win">
      <TodoSeg />
      <AgentsSeg />
      <FlowsSeg />
      <HabitsSeg />
    </div>
  );
}

/** Boton "Pendientes" (P): tu lista general de cosas por hacer; la insignia cuenta lo que falta */
function TodoSeg() {
  const open = useOfficeStore((s) => s.todoOpen);
  const toggle = useOfficeStore((s) => s.toggleTodo);
  const pending = useOfficeStore((s) => pendingTodos(s.snapshot?.todos).length);
  const label = pending === 0 ? 'Pendientes' : `Pendientes, ${pending} por hacer`;
  return (
    <div className="bar-seg">
      <button
        type="button"
        className="btn"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="P"
        aria-label={label}
        title={`${label} (P)`}
      >
        <ListTodo size={14} strokeWidth={STROKE} aria-hidden />
        <span className="btn-label">Pendientes</span>
        {pending > 0 ? (
          <span className="flows-badge" aria-hidden>
            {pending}
          </span>
        ) : null}
        <kbd className="kbd">P</kbd>
      </button>
    </div>
  );
}

type ConnView = 'connecting' | 'live' | 'reconnecting' | 'offline';

function connView(connection: ConnectionState, hasSnapshot: boolean, demo: boolean): ConnView {
  if (demo || connection === 'live') return 'live';
  if (connection === 'connecting') return hasSnapshot ? 'reconnecting' : 'connecting';
  return 'offline';
}

function ConnectionStatus({
  connection,
  hasSnapshot,
  demo,
}: {
  connection: ConnectionState;
  hasSnapshot: boolean;
  demo: boolean;
}) {
  const requestReconnect = useOfficeStore((s) => s.requestReconnect);
  const view = connView(connection, hasSnapshot, demo);
  const text = view === 'connecting' ? 'Conectando…' : 'Reconectando…';
  if (view === 'live') {
    return (
      <span className="conn conn--live" title="En vivo">
        <Led mode="ring" />
        <span className="conn-text">En vivo</span>
      </span>
    );
  }
  if (view === 'offline') {
    return (
      <>
        <span className="conn conn--offline" title="Sin conexión">
          <WifiOff size={14} strokeWidth={STROKE} aria-hidden />
          <span className="conn-text">Sin conexión</span>
        </span>
        <button type="button" className="btn btn--sm" onClick={requestReconnect} title="Reintentar la conexión">
          <RefreshCw size={12} strokeWidth={STROKE} aria-hidden />
          <span className="conn-text">Reintentar</span>
        </button>
      </>
    );
  }
  return (
    <span className={`conn conn--${view}`} title={text}>
      <LoaderCircle size={14} strokeWidth={STROKE} aria-hidden className="is-spin" />
      <span className="conn-text">{text}</span>
    </span>
  );
}

/**
 * Grupo del dinero (D3): costo de hoy, el mes contra el presupuesto y el ritmo. Es lo ultimo que se recorta.
 * Sin boton de Historial (Hábitos abre el mismo panel) ni de Guía (va dentro de ese panel).
 */
function MoneyGroup() {
  const today = useOfficeStore((s) => s.snapshot?.today ?? null);
  const demo = useOfficeStore((s) => s.demo);
  const openHistory = useOfficeStore((s) => s.openHistory);
  const month = currentMonth(Date.now());
  const budget = useBudget(month, !demo);
  const data = budget.data?.month === month ? budget.data : undefined;
  const loading = !today || (!demo && budget.isPending);
  const failed = !demo && budget.isError && !data;

  return (
    <div className="hud-bar hud-bar--money win">
      {loading ? (
        <>
          <div className="bar-seg" data-tour="today">
            <span className="label">Hoy</span>
            <span className="skel" style={{ width: 110 }} />
          </div>
          <div className="bar-seg bar-seg--month" data-tour="month">
            <span className="skel" style={{ width: 150 }} />
          </div>
        </>
      ) : failed ? (
        <>
          <TodaySeg today={today} />
          <div className="bar-seg bar-seg--error bar-seg--month" role="alert" data-tour="month" title="Sin datos de costo">
            <TriangleAlert size={14} strokeWidth={STROKE} aria-hidden />
            <span className="bar-seg-error-text">Sin datos de costo</span>
            <button type="button" className="btn btn--sm" onClick={() => void budget.refetch()}>
              Reintentar
            </button>
          </div>
        </>
      ) : (
        <>
          <TodaySeg today={today} />
          <MonthSeg
            month={month}
            data={data ?? null}
            onOpen={() => openHistory('budget')}
          />
          <PaceSeg />
        </>
      )}
    </div>
  );
}

/** Boton "Agentes" (L): abre la tabla "Agentes ahora". La insignia cuenta quienes trabajan o esperan */
function AgentsSeg() {
  const open = useOfficeStore((s) => s.agentsOpen);
  const toggle = useOfficeStore((s) => s.toggleAgents);
  const snapshot = useOfficeStore((s) => s.snapshot);
  const view = useMemo(() => agentsNow(snapshot), [snapshot]);
  const count = view.rows.length;
  const label = count === 0 ? 'Agentes ahora' : `Agentes ahora, ${count} activos`;
  return (
    <div className="bar-seg">
      <button
        type="button"
        className="btn"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="L"
        aria-label={label}
        title={`${label} (L)`}
      >
        <Users size={14} strokeWidth={STROKE} aria-hidden />
        <span className="btn-label">Agentes</span>
        {count > 0 ? (
          <span className={`flows-badge ${view.waiting > 0 ? 'is-waiting' : ''}`} aria-hidden>
            {count}
          </span>
        ) : null}
        <kbd className="kbd">L</kbd>
      </button>
    </div>
  );
}

/**
 * Boton "Flujos" (F): lleva a la sala del flujo en curso y abre su panel, que lo cuenta (el flujo vive en la
 * oficina); otro clic lo cierra. La insignia cuenta las corridas en curso
 */
function FlowsSeg() {
  const active = useOfficeStore((s) => activeRunCount(s.snapshot));
  const open = useOfficeStore((s) => {
    const first = collectRuns(s.snapshot)[0];
    return first !== undefined && s.selectedRoomId === first.room.id;
  });
  const label = active === 0 ? 'Flujos' : `Flujos, ${active} en curso`;
  return (
    <div className="bar-seg">
      <button
        type="button"
        className="btn"
        onClick={toggleFlowRoom}
        aria-pressed={open}
        aria-keyshortcuts="F"
        aria-label={label}
        title={open ? 'Cerrar el panel del flujo (F)' : 'Ir a la sala del flujo (F)'}
        data-tour="flows"
      >
        <Workflow size={14} strokeWidth={STROKE} aria-hidden />
        <span className="btn-label">Flujos</span>
        {active > 0 ? (
          <span className="flows-badge" aria-hidden>
            {active}
          </span>
        ) : null}
        <kbd className="kbd">F</kbd>
      </button>
    </div>
  );
}

/**
 * Insignia de habitos (A): con alertas rojas vivas late en rojo y cuenta las alertas; si no, cuenta los
 * hallazgos vivos. Abre el historial en Habitos, o lo cierra si ya esta ahi.
 */
function HabitsSeg() {
  const habits = useOfficeStore((s) => s.snapshot?.habits);
  const onHabits = useOfficeStore((s) => s.historyOpen && s.historyTab === 'habits');
  const badge = habitsBadge(habits);
  const onClick = () => {
    const state = useOfficeStore.getState();
    if (onHabits) state.closeHistory();
    else state.openHistory('habits');
  };
  return (
    <div className="bar-seg">
      <button
        type="button"
        className={`btn lv-habits is-${badge.tone}`}
        onClick={onClick}
        aria-haspopup="dialog"
        aria-expanded={onHabits}
        aria-keyshortcuts="A"
        aria-label={badge.label}
        title={`${badge.label} (A)`}
        data-tour="habits"
      >
        {badge.tone === 'alert' ? (
          <Siren size={14} strokeWidth={STROKE} aria-hidden />
        ) : (
          <Lightbulb size={14} strokeWidth={STROKE} aria-hidden />
        )}
        <span className="btn-label">Hábitos</span>
        {badge.count > 0 ? (
          <span className="lv-habits-count" aria-hidden>
            {badge.count}
          </span>
        ) : null}
        <kbd className="kbd">A</kbd>
      </button>
    </div>
  );
}

function TodaySeg({
  today,
}: {
  today: { costUsd: number; tokens: { total: number }; unpricedTokens?: number } | null;
}) {
  const unpriced = today?.unpricedTokens ?? 0;
  const base = 'Hoy · valor equivalente API (plan Enterprise, no es un cobro real)';
  const title =
    unpriced > 0 ? `${base}. ${formatTokens(unpriced)} tokens de un modelo sin precio conocido no se suman` : base;
  let usd = '—';
  if (today) {
    if (unpriced <= 0) usd = formatUsd(today.costUsd);
    else usd = today.costUsd > 0 ? `${formatUsd(today.costUsd)}*` : 'sin precio';
  }
  return (
    <div className="bar-seg" title={title} data-tour="today">
      <span className="label">Hoy</span>
      <span className="today-usd">{usd}</span>
      <span className="today-tok">{today ? `${formatTokens(today.tokens.total)} tok` : ''}</span>
    </div>
  );
}

/**
 * Ritmo en vivo: gasto de la ultima hora y el dia en que se acaba (o se acabo) el presupuesto. Sale del
 * snapshot, asi que se mueve con cada llamada sin esperar al refresco del historial.
 */
function PaceSeg() {
  const budget = useOfficeStore((s) => s.snapshot?.budget);
  if (!budget) return null;
  const day = (date: string): string => formatDayMonth(`${date}T12:00:00`);
  const tone = budget.crossedDate ? 'is-over' : budget.runOutDate || budget.dayOver ? 'is-warn' : '';
  const when = budget.crossedDate
    ? `tope pasado el ${day(budget.crossedDate)}`
    : budget.runOutDate
      ? `se acaba el ${day(budget.runOutDate)}`
      : 'alcanza para el mes';
  const title = [
    `Última hora: ${formatUsd(budget.burnPerHourUsd)}`,
    `hoy ${formatUsd(budget.todayUsd)}${budget.perDayUsd !== null ? ` de ${formatUsd(budget.perDayUsd)} recomendados por día` : ''}`,
    budget.crossedDate
      ? `el gasto pasó el presupuesto el ${day(budget.crossedDate)}`
      : budget.runOutDate
        ? `al ritmo de los últimos días el presupuesto se acaba el ${day(budget.runOutDate)}`
        : 'a este ritmo el presupuesto alcanza para todo el mes',
    budget.estimatedUsd > 0 ? `incluye ~${formatUsd(budget.estimatedUsd)} con precio estimado` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="bar-seg x-pace-seg" title={title} data-tour="pace">
      <span className={`x-pace ${tone}`}>
        <b>{formatUsd(budget.burnPerHourUsd)}</b>/h · <b className="x-pace-when">{when}</b>
      </span>
    </div>
  );
}

function MonthSeg({
  month,
  data,
  onOpen,
}: {
  month: string;
  data: { spentUsd: number; projectedUsd: number; budgetUsd: number } | null;
  onOpen: () => void;
}) {
  if (!data) {
    return (
      <div className="bar-seg bar-seg--month" title="El presupuesto del mes necesita el servidor" data-tour="month">
        <span className="label">{formatMonthShort(month)}</span>
        <span className="budget-mini is-empty" aria-hidden />
        <span className="budget-mini-val">Sin datos</span>
      </div>
    );
  }
  const track = budgetTrack(data);
  const gauge = budgetGauge(data);
  // el gasto ya paso el presupuesto: todo el segmento en rojo; si solo la proyeccion lo pasa, la barra y la
  // cifra de la proyeccion van en rojo
  const over = gauge.tone === 'over';
  const projectedOver = track.over;
  const label = `${formatMonthLabel(month)}: ${formatUsd(data.spentUsd)} de ${formatUsd(data.budgetUsd)} (${formatPercent(
    gauge.usedRatio,
  )}), proyección ${formatUsd(data.projectedUsd)}${over ? '. Superaste el presupuesto' : ''}. Abrir el presupuesto`;
  return (
    <button
      type="button"
      className={`bar-seg bar-seg--month bar-seg--button ${over ? 'lv-month-over' : ''}`}
      onClick={onOpen}
      data-tour="month"
      aria-label={label}
      title={
        over
          ? 'El gasto del mes superó el presupuesto; la marca clara es la proyección'
          : projectedOver
            ? `A este ritmo el mes cierra en ${formatUsd(data.projectedUsd)}, por encima del presupuesto`
            : 'Gastado del mes contra el presupuesto; la marca clara es la proyección'
      }
    >
      <span className="label">{formatMonthShort(month)}</span>
      <span className={`budget-mini ${track.over ? 'is-over' : ''}`} aria-hidden>
        <span className="budget-mini-fill" style={{ width: `${track.spentPct}%` }} />
        <span className="budget-mini-proj" style={{ left: `${track.projectedPct}%` }} />
      </span>
      <span className="budget-mini-val">
        <b>{formatUsd(data.spentUsd)}</b> / {formatUsd(data.budgetUsd)}
      </span>
      <span className={`budget-mini-forecast ${projectedOver ? 'is-over' : ''}`}>
        proy. {formatUsd(data.projectedUsd)}
      </span>
    </button>
  );
}
