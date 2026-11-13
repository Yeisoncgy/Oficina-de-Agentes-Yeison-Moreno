import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  ChevronsLeftRight,
  CircleDashed,
  CircleStop,
  ChartGantt,
  Clock3,
  DoorOpen,
  Hand,
  Hourglass,
  ListX,
  Loader,
  SquareKanban,
  X,
} from 'lucide-react';
import type { WorkflowForecast, WorkflowStatus } from '@shared/contract';
import { MonthShare, RunCloseCard } from '../extras/RunClose';
import { formatClock, formatTimeOfDay, formatTokens, formatUsdOrUnpriced } from '@/lib/format';
import {
  boardColumns,
  columnCountText,
  columnSpan,
  flowPipeline,
  forecastDetail,
  forecastText,
  isRunning,
  nextColumnKey,
  PHASE_STATUS_LABEL,
  prettyRunName,
  runAgentCounts,
  runElapsedMs,
  runForecast,
  runProgress,
  runStory,
  RUN_STATUS_LABEL,
  startsCollapsed,
  type BoardColumn,
  type FlowEntry,
  type RunStory,
} from '@/lib/workflows';
import { describeApiError } from '@/state/api';
import { dismissRun } from '@/state/notesApi';
import { useOfficeStore } from '@/state/store';
import { Portrait } from '../PixelArt';
import { Led, STROKE } from '../primitives';
import { useNow } from '../useNow';
import { AgentCard } from './AgentCard';
import { RUN_LED } from './parts';
import { FlowPipeline, RiskChip } from './Pipeline';
import { RunTimeline, timelineGroupId } from './Timeline';

type View = 'board' | 'timeline';

const columnId = (key: string) => `fx-col-${key}`;

/**
 * Una corrida: cabecera (quien, que pasa ahora en una frase, cifras), el recorrido del flujo y el cuerpo en
 * dos vistas: Tablero (una columna por fase, enfocado en la actual) o Linea de tiempo.
 */
export function RunBoard({ entry, tabbedBy, spend }: { entry: FlowEntry; tabbedBy: string | null; spend: boolean }) {
  const { run, room } = entry;
  const running = isRunning(run);
  const now = useNow(1_000, 'server', running);
  const columns = useMemo(() => boardColumns(run, room), [run, room]);
  const pipeline = useMemo(() => flowPipeline(run, room), [run, room]);
  const story = runStory(run, room, now);
  const name = prettyRunName(run.name);
  const [view, setView] = useState<View>('board');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // ir a una fase desde el recorrido: la despliega, la trae a la vista y la marca un momento (n: repetir
  // el clic en la misma fase vuelve a llevarla a la vista)
  const [jump, setJump] = useState<{ key: string; n: number } | null>(null);
  const flash = jump?.key ?? null;
  const nextKey = nextColumnKey(columns);
  const isOpen = (column: BoardColumn) => expanded[column.key] ?? !startsCollapsed(column, run, columns);
  const pending = useRef(false);
  const goTo = useCallback(
    (key: string) => {
      if (view === 'board') setExpanded((e) => ({ ...e, [key]: true }));
      pending.current = true;
      setJump((j) => ({ key, n: (j?.n ?? 0) + 1 }));
    },
    [view],
  );
  useEffect(() => {
    if (!jump || !pending.current) return;
    pending.current = false;
    const el = document.getElementById(view === 'board' ? columnId(jump.key) : timelineGroupId(jump.key));
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest', inline: 'center' });
    el.focus({ preventScroll: true });
  }, [jump, view]);
  useEffect(() => {
    if (!jump) return;
    const id = window.setTimeout(() => setJump(null), 1_400);
    return () => window.clearTimeout(id);
  }, [jump]);

  return (
    <div id="flows-run" className="fx-run" role={tabbedBy ? 'tabpanel' : undefined} aria-labelledby={tabbedBy ?? undefined}>
      <header className="fx-hero">
        <div className="fx-hero-id">
          <div className="fx-hero-line">
            <RunState status={run.status} />
            <h3 className="fx-name" title={name !== run.name ? `Nombre en el script: ${run.name}` : undefined}>
              {name}
            </h3>
          </div>
          {run.description ? <p className="fx-desc">{run.description}</p> : null}
          <RunMeta entry={entry} />
          <RunStats entry={entry} now={now} spend={spend} />
          {spend && !isRunning(run) ? <RunCloseCard run={run} /> : null}
        </div>
        <StoryCard story={story} roomId={room.id} />
      </header>

      <FlowPipeline nodes={pipeline} onPhase={goTo} />

      <div className="fx-viewbar">
        <div className="fx-seg-ctl" role="group" aria-label="Vista">
          <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>
            <SquareKanban size={16} strokeWidth={STROKE} aria-hidden />
            Tablero
          </button>
          <button type="button" aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>
            <ChartGantt size={16} strokeWidth={STROKE} aria-hidden />
            Línea de tiempo
          </button>
        </div>
        <span className="fx-viewbar-hint">
          {view === 'board'
            ? 'Una columna por fase, en orden. Clic en un agente para abrir su panel.'
            : 'Cada barra es un agente, desde que arrancó hasta que terminó.'}
        </span>
      </div>

      {view === 'timeline' ? (
        <RunTimeline run={run} room={room} now={now} spend={spend} />
      ) : columns.length === 0 ? (
        <p className="fx-board-empty">
          {running ? 'Todavía no arrancó ningún agente de este flujo.' : 'Ningún agente llegó a arrancar en este flujo.'}
        </p>
      ) : (
        <ol className="fx-board" aria-label={`Fases de ${name}`}>
          {columns.map((column) => (
            <PhaseColumn
              key={column.key}
              column={column}
              now={now}
              runStatus={run.status}
              spend={spend}
              open={isOpen(column)}
              next={column.key === nextKey && running}
              flash={flash === column.key}
              onToggle={() => setExpanded((e) => ({ ...e, [column.key]: !isOpen(column) }))}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function RunState({ status }: { status: WorkflowStatus }) {
  return (
    <span className={`fx-state is-${status}`}>
      {status === 'running' ? (
        <Led mode="blink" color={RUN_LED.running} className="fx-led" />
      ) : status === 'done' ? (
        <Check size={16} strokeWidth={STROKE} aria-hidden />
      ) : status === 'failed' ? (
        <X size={16} strokeWidth={STROKE} aria-hidden />
      ) : (
        <CircleStop size={16} strokeWidth={STROKE} aria-hidden />
      )}
      {RUN_STATUS_LABEL[status]}
    </span>
  );
}

function RunMeta({ entry }: { entry: FlowEntry }) {
  const { run, room } = entry;
  const focusRoom = useOfficeStore((s) => s.focusRoom);
  return (
    <p className="fx-meta">
      <button type="button" className="fx-chipbtn" onClick={() => focusRoom(room.id)} title="Llevar la cámara a esta sala">
        <DoorOpen size={14} strokeWidth={STROKE} aria-hidden />
        <span>Sala {room.title}</span>
      </button>
      <span className="fx-meta-t">
        <Clock3 size={14} strokeWidth={STROKE} aria-hidden />
        Arrancó a las {formatTimeOfDay(run.startedAt)}
        {run.endedAt ? ` · terminó a las ${formatTimeOfDay(run.endedAt)}` : ''}
      </span>
      {isRunning(run) ? null : <DismissButton runId={run.runId} />}
    </p>
  );
}

const STORY_ICON: Record<RunStory['tone'], ReactNode> = {
  live: <Led mode="blink" className="fx-story-led" />,
  between: <Loader size={20} strokeWidth={STROKE} aria-hidden className="is-spin" />,
  waiting: <Hand size={20} strokeWidth={STROKE} aria-hidden />,
  done: <Check size={20} strokeWidth={2} aria-hidden />,
  failed: <X size={20} strokeWidth={2} aria-hidden />,
  stopped: <CircleStop size={20} strokeWidth={STROKE} aria-hidden />,
};

/** "Que pasa ahora": la frase de la corrida, grande. Si espera al usuario, lleva a la sala */
function StoryCard({ story, roomId }: { story: RunStory; roomId: string }) {
  const focusRoom = useOfficeStore((s) => s.focusRoom);
  return (
    <section className={`fx-story is-${story.tone}`} aria-label="Qué pasa ahora">
      <span className="fx-story-icon">{STORY_ICON[story.tone]}</span>
      <span className="fx-story-body">
        <span className="fx-story-k">Qué pasa ahora</span>
        <span className="fx-story-h">{story.headline}</span>
        <span className="fx-story-d">{story.detail}</span>
        {story.tone === 'waiting' ? (
          <button type="button" className="btn btn--sm fx-story-go" onClick={() => focusRoom(roomId)}>
            <DoorOpen size={14} strokeWidth={STROKE} aria-hidden />
            Ir a la sala
          </button>
        ) : null}
      </span>
    </section>
  );
}

function RunStats({ entry, now, spend }: { entry: FlowEntry; now: number; spend: boolean }) {
  const { run } = entry;
  const running = isRunning(run);
  const counts = useMemo(() => runAgentCounts(run), [run]);
  const progress = runProgress(run);
  const forecast = runForecast(run);
  return (
    <dl className="fx-stats">
      <Stat k={running ? 'Lleva' : 'Duró'} tone={running ? 'live' : undefined}>
        {formatClock(runElapsedMs(run, now))}
      </Stat>
      {progress.total > 0 ? (
        <Stat k="Fases" title={`${progress.phasesDone} de ${progress.total} fases terminadas`}>
          {progress.phasesDone}
          <small>/{progress.total}</small>
        </Stat>
      ) : null}
      <Stat k="Agentes" title="Trabajando · terminados · fallaron">
        <span className="fx-agents">
          {counts.working > 0 ? <span className="is-live">{counts.working} trabajando</span> : null}
          <span className={counts.done > 0 ? 'is-done' : undefined}>
            {counts.done} {counts.done === 1 ? 'terminado' : 'terminados'}
          </span>
          {counts.failed > 0 ? <span className="is-error">{counts.failed} fallaron</span> : null}
        </span>
      </Stat>
      {spend ? (
        <>
          <Stat k="Tokens">{formatTokens(run.tokens.total)}</Stat>
          <Stat k="Valor eq. API" tone={run.costUsd === null ? 'unpriced' : 'usd'} title="Valor equivalente API: plan Enterprise, no es un cobro real">
            {formatUsdOrUnpriced(run.costUsd)}
          </Stat>
          {running ? <ForecastStat forecast={forecast} /> : null}
          {running ? <MonthShare forecast={forecast} /> : null}
        </>
      ) : forecast?.risk && forecast.risk !== 'low' ? (
        <div className="fx-stat" title={forecastDetail(forecast)}>
          <dt className="fx-stat-k">Tope por flujo</dt>
          <dd className="fx-stat-v">
            <RiskChip risk={forecast.risk} />
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function Stat({
  k,
  tone,
  title,
  children,
}: {
  k: string;
  tone?: 'live' | 'done' | 'error' | 'usd' | 'unpriced';
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="fx-stat" title={title}>
      <dt className="fx-stat-k">{k}</dt>
      <dd className={`fx-stat-v num ${tone ? `is-${tone}` : ''}`}>{children}</dd>
    </div>
  );
}

/**
 * Pronostico del costo final (solo en curso): "~$bajo–$alto" y el riesgo contra el presupuesto por
 * workflow. Sin historial para estimar, lo dice en vez de inventar una cifra.
 */
function ForecastStat({ forecast }: { forecast: WorkflowForecast | null }) {
  if (!forecast) {
    return (
      <Stat k="Pronóstico" tone="unpriced" title="Todavía no hay historial de agentes de este rol y modelo para estimar">
        sin historial
      </Stat>
    );
  }
  const detail = forecastDetail(forecast);
  return (
    <div className="fx-stat" title={detail}>
      <dt className="fx-stat-k">Pronóstico</dt>
      <dd className="fx-stat-v num fx-forecast">
        <span className="fx-forecast-usd">{forecastText(forecast)}</span>
        {forecast.risk ? <RiskChip risk={forecast.risk} /> : null}
        <span className="sr-only">. {detail}</span>
      </dd>
    </div>
  );
}

/**
 * Quita el flujo de la sala de control (se guarda en la DB de la app, no en ~/.claude). Solo para flujos
 * que ya no corren: no detiene nada ni cambia el presupuesto.
 */
function DismissButton({ runId }: { runId: string }) {
  const demo = useOfficeStore((s) => s.demo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (demo) return null;
  const onClick = async () => {
    setBusy(true);
    setError(null);
    try {
      await dismissRun(runId);
    } catch (err) {
      setError(describeApiError(err));
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="fx-chipbtn"
        onClick={() => void onClick()}
        disabled={busy}
        title="Sacar este flujo de la lista. No borra nada en Claude Code y su costo sigue en el presupuesto"
      >
        <ListX size={14} strokeWidth={STROKE} aria-hidden />
        <span>{busy ? 'Quitando…' : 'Quitar de la lista'}</span>
      </button>
      {error ? (
        <span className="fx-offline" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

function PhaseColumn({
  column,
  now,
  runStatus,
  spend,
  open,
  next,
  flash,
  onToggle,
}: {
  column: BoardColumn;
  now: number;
  runStatus: WorkflowStatus;
  spend: boolean;
  open: boolean;
  next: boolean;
  flash: boolean;
  onToggle: () => void;
}) {
  const headId = useId();
  const n = column.index >= 0 ? column.index + 1 : null;
  const span = columnSpan(column, now);
  const foldable = column.total > 0 && column.status !== 'running';
  const folded = foldable && !open;
  const cls = [
    'fx-col',
    `is-${column.status}`,
    column.current ? 'is-current' : '',
    folded ? 'is-folded' : '',
    column.total === 0 ? 'is-empty' : '',
    next ? 'is-next' : '',
    flash ? 'is-flash' : '',
  ].join(' ');

  return (
    <li id={columnId(column.key)} className={cls} aria-labelledby={headId} tabIndex={-1}>
      <div className="fx-col-head">
        <span className="fx-col-n num" aria-hidden>
          {column.status === 'done' ? (
            <Check size={16} strokeWidth={2} />
          ) : column.status === 'failed' ? (
            <X size={16} strokeWidth={2} />
          ) : (
            (n ?? '·')
          )}
        </span>
        <span className="fx-col-id">
          <h4 id={headId} className="fx-col-title" title={column.title}>
            {n ? <span className="sr-only">Fase {n}: </span> : null}
            {column.title}
          </h4>
          <span className="fx-col-meta">
            <span className="fx-col-st">
              {column.status === 'running' ? <Led mode="blink" className="fx-led" /> : null}
              {next ? 'Sigue' : PHASE_STATUS_LABEL[column.status]}
            </span>
            {column.total > 0 ? <span className="fx-col-count num">{columnCountText(column)}</span> : null}
            {span ? <span className="fx-col-time num">{formatClock(span.endMs - span.startMs)}</span> : null}
          </span>
        </span>
        {foldable ? (
          <button
            type="button"
            className="fx-col-fold"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={open ? `Plegar la fase ${column.title}` : `Ver los agentes de la fase ${column.title}`}
            title={open ? 'Plegar' : 'Ver agentes'}
          >
            <ChevronsLeftRight size={16} strokeWidth={STROKE} aria-hidden />
          </button>
        ) : null}
      </div>

      {column.total === 0 && runStatus !== 'running' ? (
        <div className="fx-wait is-never">
          <CircleDashed size={22} strokeWidth={STROKE} aria-hidden />
          <span className="fx-wait-t">No llegó a correr</span>
          <span className="fx-wait-s">
            {runStatus === 'stopped' ? 'El flujo se detuvo antes de esta fase' : 'El flujo terminó antes de esta fase'}
          </span>
        </div>
      ) : column.total === 0 ? (
        <div className="fx-wait">
          <Hourglass size={22} strokeWidth={STROKE} aria-hidden />
          <span className="fx-wait-t">{next ? 'Es la siguiente' : 'Después'}</span>
          <span className="fx-wait-s">
            {next ? 'Arranca cuando termine la fase anterior' : 'Todavía no arrancó ningún agente'}
          </span>
        </div>
      ) : folded ? (
        <button type="button" className="fx-fold" onClick={onToggle} aria-label={`Ver los ${column.total} agentes de ${column.title}`}>
          <span className="fx-fold-faces" aria-hidden>
            {column.agents.slice(0, 5).map((view) => (
              <Portrait key={view.ref.agentId} agentType={view.look} size={28} />
            ))}
          </span>
          <span className="fx-fold-t">{column.agents.map((v) => v.name).join(', ')}</span>
          <span className="fx-fold-cta">Ver agentes</span>
        </button>
      ) : (
        <ul className="fx-cards" aria-label={`Agentes de ${column.title}`}>
          {column.agents.map((view) => (
            <AgentCard key={view.ref.agentId} view={view} now={now} spend={spend} />
          ))}
        </ul>
      )}
    </li>
  );
}
