import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Coins, Hand, History, Workflow, X } from 'lucide-react';
import type { WorkflowRun } from '@shared/contract';
import {
  awaitsHuman,
  collectRuns,
  dockMode,
  flowAgentViews,
  isRunning,
  openFlowRoom,
  phaseAnnouncement,
  phaseProgress,
  pickEntry,
  prefAfterClose,
  prettyRunName,
  runForecast,
  runStory,
  RUN_STATUS_LABEL,
  type FlowEntry,
} from '@/lib/workflows';
import { drawerOpen as isDrawerOpen, useOfficeStore } from '@/state/store';
import { STATE } from '@/theme';
import { HowToRead, RUN_LED } from './flows/parts';
import { RiskChip } from './flows/Pipeline';
import { RunBoard } from './flows/RunBoard';
import { useHudEdge } from './hudInsets';
import { Portrait } from './PixelArt';
import { IconButton, Led, PanelState, SkeletonBlock, STROKE } from './primitives';
import { useRoomListMode } from './RoomList';
import { useNow } from './useNow';
import './flows/flows.css';

type EdgeRef = (el: HTMLElement | null) => (() => void) | undefined;
type DockLayout = { 'data-rooms': 'open' | 'rail'; 'data-drawer': 'open' | 'closed' };

const tabId = (runId: string) => `flows-tab-${runId}`;

/**
 * Sala de control de Flujos (corridas del tool Workflow), abajo entre la lista de salas y el panel del
 * agente. F o el boton Flujos abren la vista grande; con un flujo en curso y la vista cerrada queda una
 * barra compacta con el resumen. Esc cierra la vista grande.
 * El gasto (tokens, valor y pronostico) sale oculto, como en el ranking, porque la pantalla se proyecta:
 * "Mostrar gasto" lo enciende; es la misma preferencia recordada del ranking y el panel de la sala (store.showSpend).
 */
export function FlowsDock() {
  const snapshot = useOfficeStore((s) => s.snapshot);
  const pref = useOfficeStore((s) => s.flowsDock);
  const runId = useOfficeStore((s) => s.flowsRunId);
  const drawerOpen = useOfficeStore(isDrawerOpen);
  const rooms = useRoomListMode();
  const entries = useMemo(() => collectRuns(snapshot), [snapshot]);
  const hasActive = entries.some((e) => isRunning(e.run));
  const mode = dockMode(pref, hasActive);
  const edgeRef = useHudEdge('bottom', mode !== 'hidden');
  const watched = pickEntry(entries, runId);
  const layout: DockLayout = { 'data-rooms': rooms, 'data-drawer': drawerOpen ? 'open' : 'closed' };
  const spend = useOfficeStore((s) => s.showSpend);
  const toggleSpend = useOfficeStore((s) => s.toggleSpend);

  return (
    <>
      {/* anuncia los cambios de fase y el fin de la corrida que se esta mirando (no los cronometros) */}
      <p className="sr-only" role="status" aria-live="polite">
        {watched ? phaseAnnouncement(watched.run) : ''}
      </p>
      {mode === 'hidden' ? null : mode === 'bar' ? (
        <FlowsBar key="bar" edgeRef={edgeRef} entries={entries} layout={layout} />
      ) : (
        <FlowsSheet
          key="open"
          edgeRef={edgeRef}
          entries={entries}
          hasActive={hasActive}
          layout={layout}
          spend={spend}
          onSpend={toggleSpend}
        />
      )}
    </>
  );
}

// ---- barra compacta ----

/** fichas visibles a la vez; las demas se cuentan con "+N" */
const BAR_TICKETS_MAX = 3;

/**
 * Tira de abajo mientras corre un flujo: una ficha por flujo en curso con su sala, que pasa ahora (runStory)
 * y sus fases. Clic lleva a la sala y abre su panel, que lo cuenta completo (el flujo vive en la oficina).
 */
function FlowsBar({ edgeRef, entries, layout }: { edgeRef: EdgeRef; entries: FlowEntry[]; layout: DockLayout }) {
  const active = entries.filter((e) => isRunning(e.run));
  const waiting = active.some((e) => awaitsHuman(e.run, e.room));
  const shown = active.slice(0, BAR_TICKETS_MAX);
  const extra = active.length - shown.length;
  return (
    <div id="flows-dock" ref={edgeRef} className={`hud-flows fx-dockbar ${waiting ? 'is-waiting' : ''}`} {...layout}>
      <ul className="fx-tickets m-0 list-none" aria-label="Flujos en curso">
        {shown.map((entry) => (
          <FlowTicket key={entry.run.runId} entry={entry} />
        ))}
        {extra > 0 ? (
          <li className="fx-tickets-more" aria-label={`y ${extra} flujos más`}>
            +{extra}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function FlowTicket({ entry }: { entry: FlowEntry }) {
  const { run, room } = entry;
  const now = useNow(1_000, 'server');
  const story = runStory(run, room, now);
  const waiting = story.tone === 'waiting';
  const forecast = runForecast(run);
  const faces = flowAgentViews(run, room)
    .filter((v) => v.ref.status === 'working' && !v.dim)
    .slice(0, 3);
  return (
    <li>
      <button
        type="button"
        className={`fx-ticket is-${story.tone}`}
        onClick={() => openFlowRoom(run.runId)}
        aria-keyshortcuts="F"
        aria-label={`${room.title}: ${story.headline}. ${story.detail} Ver el flujo en la sala`}
        title={`${prettyRunName(run.name)} · ${room.title}\nClic: ver el flujo en su sala`}
      >
        <span className="fx-ticket-state" aria-hidden>
          {waiting ? (
            <Hand size={16} strokeWidth={STROKE} className="fx-wave" />
          ) : (
            <Led mode="blink" color={STATE.working} className="fx-led" />
          )}
        </span>
        <span className="fx-ticket-text" aria-hidden>
          <span className="fx-ticket-room">{room.title}</span>
          <span className="fx-ticket-head">{story.headline}</span>
        </span>
        <MiniPhases run={run} />
        {faces.length > 0 ? (
          <span className="fx-faces" aria-hidden>
            {faces.map((v) => (
              <Portrait key={v.ref.agentId} agentType={v.look} size={24} />
            ))}
          </span>
        ) : null}
        {forecast?.risk && forecast.risk !== 'low' ? (
          <span aria-hidden>
            <RiskChip risk={forecast.risk} />
          </span>
        ) : null}
      </button>
    </li>
  );
}

function MiniPhases({ run }: { run: WorkflowRun }) {
  if (run.phases.length === 0) return null;
  return (
    <span className="fx-mini" aria-hidden>
      {run.phases.map((phase, i) => (
        <i key={i} className={`is-${phase.status}`} />
      ))}
    </span>
  );
}

// ---- vista grande ----

function FlowsSheet({
  edgeRef,
  entries,
  hasActive,
  layout,
  spend,
  onSpend,
}: {
  edgeRef: EdgeRef;
  entries: FlowEntry[];
  hasActive: boolean;
  layout: DockLayout;
  spend: boolean;
  onSpend: () => void;
}) {
  const hasSnapshot = useOfficeStore((s) => s.snapshot !== null);
  const offline = useOfficeStore((s) => s.connection === 'offline' && !s.demo);
  const runId = useOfficeStore((s) => s.flowsRunId);
  const setFlowsDock = useOfficeStore((s) => s.setFlowsDock);
  const setLastLayer = useOfficeStore((s) => s.setLastLayer);
  const requestReconnect = useOfficeStore((s) => s.requestReconnect);
  const titleId = useId();
  // Solo lo que corre (lo unico que gasta) a la vista; los terminados de hoy quedan detras de un boton.
  // No se recuerda: al volver a abrir la vista salen ocultos otra vez.
  const [showFinished, setShowFinished] = useState(false);
  // un flujo terminado pedido por nombre (lista de salas, panel del agente) se muestra aunque esten ocultos
  useEffect(() => {
    const asked = runId ? entries.find((e) => e.run.runId === runId) : undefined;
    if (asked && !isRunning(asked.run)) setShowFinished(true);
  }, [runId]);
  const activeCount = entries.filter((e) => isRunning(e.run)).length;
  const finishedCount = entries.length - activeCount;
  const visible = showFinished ? entries : entries.filter((e) => isRunning(e.run));
  const entry = pickEntry(visible, runId);
  const sheetRef = useRef<HTMLElement | null>(null);
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      sheetRef.current = el;
      return edgeRef(el);
    },
    [edgeRef],
  );

  // al abrir, el foco entra a la vista; al cerrar vuelve a donde estaba (boton Flujos, lista de salas...)
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.focus({ preventScroll: true });
    return () => {
      if (prev && prev !== document.body && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, []);

  let body;
  if (!hasSnapshot) {
    body = offline ? (
      <PanelState
        kind="error"
        title="No se pudieron cargar los flujos"
        text="El servidor de la oficina no responde. La vista vuelve sola al reconectar."
        onRetry={requestReconnect}
      />
    ) : (
      <div className="fx-loading">
        <SkeletonBlock rows={3} height={56} />
      </div>
    );
  } else if (!entry) {
    body = <EmptyFlows onlyFinished={finishedCount > 0} onShowFinished={() => setShowFinished(true)} />;
  } else {
    body = (
      <RunBoard key={entry.run.runId} entry={entry} tabbedBy={visible.length > 1 ? tabId(entry.run.runId) : null} spend={spend} />
    );
  }

  return (
    <section
      id="flows-dock"
      ref={setRef}
      tabIndex={-1}
      className="hud-flows fx-sheet"
      aria-labelledby={titleId}
      onPointerDownCapture={() => setLastLayer('flows')}
      onFocusCapture={() => setLastLayer('flows')}
      {...layout}
    >
      <header className="win-head scanline fx-head">
        <Workflow size={20} strokeWidth={STROKE} aria-hidden className="fx-head-icon" />
        <h2 id={titleId} className="display m-0 fx-head-title">
          Flujos
        </h2>
        {activeCount > 0 ? (
          <span className="fx-head-badge num" title="Flujos en curso">
            {activeCount} en curso
          </span>
        ) : null}
        {visible.length > 1 && entry ? <RunTabs entries={visible} selected={entry.run.runId} /> : <span className="fx-head-fill" />}
        {finishedCount > 0 ? (
          <button
            type="button"
            className="fx-toggle"
            aria-pressed={showFinished}
            onClick={() => setShowFinished((v) => !v)}
            title={showFinished ? 'Mostrar solo los flujos en curso' : 'Ver los flujos que terminaron o se detuvieron hoy'}
          >
            <History size={14} strokeWidth={STROKE} aria-hidden />
            {showFinished ? 'Solo en curso' : `Terminados hoy (${finishedCount})`}
          </button>
        ) : null}
        <button
          type="button"
          className="fx-toggle"
          aria-pressed={spend}
          onClick={onSpend}
          title={spend ? 'Ocultar tokens, valor y pronóstico' : 'Ver tokens, valor equivalente API y pronóstico'}
        >
          <Coins size={14} strokeWidth={STROKE} aria-hidden />
          {spend ? 'Ocultar gasto' : 'Mostrar gasto'}
        </button>
        {offline && hasSnapshot ? <span className="fx-offline">Sin conexión</span> : null}
        <IconButton
          label="Cerrar la vista de flujos (Esc)"
          onClick={() => setFlowsDock(prefAfterClose(hasActive))}
          aria-controls="flows-dock"
          aria-expanded
          className="fx-close"
        >
          <X size={18} strokeWidth={STROKE} />
        </IconButton>
      </header>
      <div className="fx-scroll">{body}</div>
      <footer className="fx-foot">
        <HowToRead />
        <span className="fx-foot-keys" aria-hidden>
          <kbd className="kbd fx-kbd">F</kbd> alterna
          <kbd className="kbd fx-kbd">Esc</kbd> cierra
        </span>
      </footer>
    </section>
  );
}

/** Sin flujos a la vista: que es esto, como se llena y, si hay terminados de hoy, como verlos */
function EmptyFlows({ onlyFinished, onShowFinished }: { onlyFinished: boolean; onShowFinished: () => void }) {
  return (
    <div className="fx-empty" role="status">
      <span className="fx-empty-art" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <p className="fx-empty-title">{onlyFinished ? 'No hay flujos en curso' : 'Todavía no hay flujos hoy'}</p>
      <p className="fx-empty-text">
        {onlyFinished
          ? 'Ningún flujo está gastando tokens ahora. Los que terminaron hoy siguen guardados.'
          : 'Un flujo es un Workflow de Claude Code: un script que reparte el trabajo en fases y lanza varios agentes a la vez.'}
      </p>
      {onlyFinished ? (
        <button type="button" className="btn btn--sm" onClick={onShowFinished}>
          <History size={14} strokeWidth={STROKE} aria-hidden />
          Ver los terminados de hoy
        </button>
      ) : (
        <ol className="fx-empty-steps">
          <li>
            <b className="num">1</b>Una sesión lanza un Workflow
          </li>
          <li>
            <b className="num">2</b>Aquí ves sus fases y agentes en vivo
          </li>
          <li>
            <b className="num">3</b>Al terminar queda su resumen del día
          </li>
        </ol>
      )}
    </div>
  );
}

/** Pestanas de corridas (en curso primero; despues las terminadas de hoy): flechas, Inicio y Fin */
function RunTabs({ entries, selected }: { entries: FlowEntry[]; selected: string }) {
  const selectFlowsRun = useOfficeStore((s) => s.selectFlowsRun);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const n = entries.length;
    const i = Math.max(0, entries.findIndex((e) => e.run.runId === selected));
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + n) % n;
    const target = entries[next];
    if (!target) return;
    selectFlowsRun(target.run.runId);
    document.getElementById(tabId(target.run.runId))?.focus();
  };
  return (
    <div role="tablist" aria-label="Corridas de hoy" className="fx-tabs" onKeyDown={onKeyDown}>
      {entries.map(({ run, room }) => {
        const on = run.runId === selected;
        const running = isRunning(run);
        const progress = running ? phaseProgress(run) : null;
        const waiting = awaitsHuman(run, room);
        const name = prettyRunName(run.name);
        return (
          <button
            key={run.runId}
            id={tabId(run.runId)}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls="flows-run"
            tabIndex={on ? 0 : -1}
            className={`fx-tab ${running ? 'is-running' : ''} ${waiting ? 'is-waiting' : ''}`}
            onClick={() => selectFlowsRun(run.runId)}
            title={`${name} · sala ${room.title} · ${waiting ? 'espera tu respuesta' : RUN_STATUS_LABEL[run.status]}`}
          >
            {waiting ? (
              <Hand size={14} strokeWidth={STROKE} aria-hidden className="fx-wave" />
            ) : (
              <Led color={RUN_LED[run.status]} mode={running ? 'blink' : 'steady'} hollow={run.status === 'done'} />
            )}
            <span className="fx-tab-name">{name}</span>
            <span className="fx-tab-meta num">
              {progress ? `${progress.current}/${progress.total}` : RUN_STATUS_LABEL[run.status]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
