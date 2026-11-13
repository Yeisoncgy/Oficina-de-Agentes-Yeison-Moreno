import { useState } from 'react';
import { Check, ChevronRight, Hand, Maximize2, Workflow, X } from 'lucide-react';
import type { OfficeRoom, WorkflowRun } from '@shared/contract';
import { formatDuration } from '@/lib/format';
import {
  boardColumns,
  flowActivity,
  isRunning,
  nextColumnKey,
  openFlowAgent,
  prettyRunName,
  roomFlowRun,
  runElapsedMs,
  runStory,
  startsCollapsed,
  type BoardColumn,
  type FlowAgentView,
} from '@/lib/workflows';
import { useOfficeStore } from '@/state/store';
import { STATE } from '@/theme';
import { Portrait } from '../PixelArt';
import { Led, RunStatusChip, STROKE } from '../primitives';
import { useNow } from '../useNow';

/**
 * El flujo contado dentro del panel de la sala (que se entienda de un vistazo y que no se
 * sienta otra app). Arriba el nombre, la duracion y una barra con una casilla por fase; luego una frase grande de
 * que pasa ahora (que tambien dice si termino, fallo o se detuvo) y las fases de arriba abajo, con las caras de
 * quien trabaja en cada una. "Ver detalle" abre la vista grande (tablero y linea de tiempo).
 */
export function RoomFlow({ room }: { room: OfficeRoom }) {
  const askedRunId = useOfficeStore((s) => s.flowsRunId);
  const run = roomFlowRun(room, askedRunId);
  if (!run) return null;
  const others = (room.workflows ?? []).filter((r) => r.runId !== run.runId);
  return (
    <section className="drawer-sec rf" aria-label="Flujo">
      <RunCard key={run.runId} run={run} room={room} />
      {others.length > 0 ? <OtherRuns runs={others} /> : null}
    </section>
  );
}

function RunCard({ run, room }: { run: WorkflowRun; room: OfficeRoom }) {
  const openFlows = useOfficeStore((s) => s.openFlows);
  const running = isRunning(run);
  const now = useNow(1_000, 'server', running);
  const story = runStory(run, room, now);
  const columns = boardColumns(run, room);
  const next = running ? nextColumnKey(columns) : null;

  return (
    <>
      <div className="rf-head">
        <span className="rf-glyph" aria-hidden>
          <Workflow size={14} strokeWidth={STROKE} />
        </span>
        <div className="rf-head-id">
          <span className="label">Flujo</span>
          <span className="rf-name" title={run.description || undefined}>
            {prettyRunName(run.name)}
          </span>
        </div>
        <span className="rf-time num" title="Duración">
          {formatDuration(runElapsedMs(run, now))}
        </span>
      </div>
      {columns.length > 0 ? (
        <span className="rf-progress" aria-hidden>
          {columns.map((column) => (
            <span
              key={column.key}
              className={`rf-seg is-${column.status} ${column.current ? 'is-current' : ''}`}
            />
          ))}
        </span>
      ) : null}
      <div className={`rf-story is-${story.tone}`} role="status">
        {story.tone === 'waiting' ? <Hand size={18} strokeWidth={STROKE} aria-hidden className="rf-story-icon" /> : null}
        <div className="min-w-0">
          <p className="rf-headline display m-0">{story.headline}</p>
          <p className="rf-detail m-0">{story.detail}</p>
        </div>
      </div>
      {columns.length > 0 ? (
        <ol className="rf-steps m-0 list-none" aria-label="Fases">
          {columns.map((column) => (
            <Step
              key={column.key}
              column={column}
              next={column.key === next}
              collapsed={startsCollapsed(column, run, columns)}
            />
          ))}
        </ol>
      ) : null}
      <button type="button" className="btn btn--sm rf-more" onClick={() => openFlows(run.runId)}>
        <Maximize2 size={12} strokeWidth={STROKE} aria-hidden />
        Ver detalle
      </button>
    </>
  );
}

function StepMark({ column }: { column: BoardColumn }) {
  if (column.status === 'done') return <Check size={12} strokeWidth={2.5} aria-hidden />;
  if (column.status === 'failed') return <X size={12} strokeWidth={2.5} aria-hidden />;
  if (column.status === 'running') return <Led mode="blink" color={STATE.working} />;
  return null;
}

/** Una fase: marca en la linea, titulo, "2/3" y sus agentes (una fase terminada, mientras el flujo corre, va plegada) */
function Step({ column, next, collapsed }: { column: BoardColumn; next: boolean; collapsed: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  const showAgents = open && column.agents.length > 0;
  const count = column.total > 0 ? `${column.done}/${column.total}` : null;
  return (
    <li className={`rf-step is-${column.status} ${column.current ? 'is-current' : ''} ${next ? 'is-next' : ''}`}>
      <span className="rf-mark" aria-hidden>
        <StepMark column={column} />
      </span>
      <div className="rf-step-body">
        <button
          type="button"
          className="rf-step-head"
          onClick={() => setOpen((v) => !v)}
          disabled={column.agents.length === 0}
          aria-expanded={column.agents.length > 0 ? open : undefined}
        >
          <span className="rf-step-title">{column.title}</span>
          {next ? <span className="rf-next">Sigue</span> : null}
          {count ? <span className="rf-count num">{count}</span> : null}
          {column.agents.length > 0 ? (
            <ChevronRight size={12} strokeWidth={STROKE} aria-hidden className={`rf-chev ${open ? 'is-open' : ''}`} />
          ) : null}
        </button>
        {showAgents ? (
          <ul className="rf-agents m-0 list-none">
            {column.agents.map((view) => (
              <AgentLine key={view.ref.agentId} view={view} />
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

/** Cara, nombre y lo que hace ahora (o como termino); clic abre su panel si sigue en la oficina */
function AgentLine({ view }: { view: FlowAgentView }) {
  const [gone, setGone] = useState(false);
  const activity = flowActivity(view);
  const doing = activity.tone === 'working' ? view.work : activity.status;
  return (
    <li>
      <button
        type="button"
        className={`rf-agent is-${activity.tone}`}
        onClick={() => setGone(openFlowAgent(view.ref.agentId) === 'gone')}
        title={gone ? 'Ya salió de la oficina' : `${view.name}: ${doing}`}
      >
        <Portrait agentType={view.look} size={24} dim={activity.tone !== 'working' && activity.tone !== 'thinking'} />
        <span className="rf-agent-name">{view.name}</span>
        <span className="rf-agent-doing">{gone ? 'Ya salió de la oficina' : doing}</span>
      </button>
    </li>
  );
}

/** Los demas flujos de hoy en la sala: uno por linea; clic lo cuenta arriba */
function OtherRuns({ runs }: { runs: WorkflowRun[] }) {
  const selectFlowsRun = useOfficeStore((s) => s.selectFlowsRun);
  return (
    <div className="rf-others">
      <span className="label">Otros flujos de hoy</span>
      <ul className="m-0 list-none">
        {runs.map((run) => (
          <li key={run.runId}>
            <button type="button" className="rf-other" onClick={() => selectFlowsRun(run.runId)}>
              <span className="rf-other-name">{prettyRunName(run.name)}</span>
              <RunStatusChip status={run.status} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
