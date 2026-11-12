import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  CircleCheck,
  DoorOpen,
  Ellipsis,
  GitBranch,
  Lightbulb,
  Lock,
  Pause,
  Siren,
  TriangleAlert,
  Workflow,
  X,
} from 'lucide-react';
import type { LiveAlert, OfficeAgent } from '@shared/contract';
import { elapsedMs, formatClock, formatTimeOfDay } from '@/lib/format';
import { modelLabel } from '@/lib/models';
import {
  actionView,
  agentIdentity,
  ALERT_LEVEL_LABEL,
  childrenTotals,
  drawerAlert,
  formatAgo,
  formatLastActivity,
  PLACE_LABEL,
  STATUS_LABEL,
  type ActionView,
  type AgentIdentity,
  type SelectionView,
} from '@/lib/office';
import { findRun, openFlowRoom, phaseProgress, phaseText, prettyRunName, ROLE_LABEL } from '@/lib/workflows';
import { useOfficeStore } from '@/state/store';
import { useSelectedAgent } from '@/state/useSelectedAgent';
import { agentColor, DURATION, lookKey } from '@/theme';
import { useHudEdge } from './hudInsets';
import { ChangeNameButton } from './onboarding/Welcome';
import { Portrait } from './PixelArt';
import { IconButton, ModelChip, RunStatusChip, StatusChip, STROKE, ThinkingDots, ToolIcon } from './primitives';
import { TokenBreakdownView } from './TokenBreakdownView';
import { TranscriptView } from './Transcript';
import { useNow } from './useNow';
import { usePresence } from './usePresence';

/** Panel derecho del agente (D3): entra desde +24 px y sale hacia el mismo borde (D5) */
export function AgentDrawer() {
  const view = useSelectedAgent();
  const { shown, leaving } = usePresence(view, DURATION.drawerOut);
  if (!shown) return null;
  return <AgentPanel key={shown.agent.id} view={shown} leaving={leaving} />;
}

/** Lider · rol del flujo · tipo del elenco */
function agentKindText(agent: OfficeAgent): string {
  if (agent.kind === 'lead') return 'Líder de la sesión';
  if (agent.workflow) return `Flujo · ${ROLE_LABEL[agent.workflow.role]}`;
  return agent.agentType;
}

function AgentPanel({ view, leaving }: { view: SelectionView; leaving: boolean }) {
  const { agent, room, gone } = view;
  const selectAgent = useOfficeStore((s) => s.selectAgent);
  const focusRoom = useOfficeStore((s) => s.focusRoom);
  const titleId = useId();
  const edgeRef = useHudEdge('right', !leaving);
  const working = !gone && agent.status === 'working';
  const status = gone ? 'done' : agent.status;
  const look = lookKey(agent);
  // la alerta se apaga sola en el server; un agente que ya salio no la arrastra
  const alert = gone ? null : drawerAlert(agent, room);
  const nameHeading = (
    <h2 id={titleId} className="drawer-name display m-0" style={{ color: agentColor(look) }}>
      {agent.displayName}
    </h2>
  );

  return (
    <aside
      ref={edgeRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className={`hud-drawer ${leaving ? 'is-leaving' : ''}`}
    >
      <header className="drawer-head scanline">
        <Portrait agentType={look} size={48} dim={status !== 'working'} />
        <div className="drawer-id">
          {agent.kind === 'lead' ? (
            <div className="ob-name-row">
              {nameHeading}
              <ChangeNameButton />
            </div>
          ) : (
            nameHeading
          )}
          <span className="drawer-sub">
            <span className="drawer-sub-text" title={agent.kind === 'subagent' ? `Tipo: ${agent.agentType}` : undefined}>
              {agentKindText(agent)}
            </span>
            <ModelChip model={agent.model} />
          </span>
        </div>
        <div className="drawer-head-end">
          <StatusChip status={status} />
          <IconButton label="Cerrar (Esc)" onClick={() => selectAgent(null)}>
            <X size={16} strokeWidth={STROKE} />
          </IconButton>
        </div>
      </header>

      <div className="drawer-body">
        {alert ? <AlertBanner alert={alert} /> : null}
        <TaskSection view={view} onRoom={() => focusRoom(room.id)} />
        <IdentitySection view={view} />
        {agent.workflow ? <FlowSection workflow={agent.workflow} /> : null}
        <section className="drawer-sec" aria-label="Tokens">
          <TokenBreakdownView tokens={agent.tokens} costUsd={agent.costUsd} model={agent.model} />
        </section>
        <TranscriptView agentId={agent.id} live={working} />
      </div>
    </aside>
  );
}

function TaskSection({ view, onRoom }: { view: SelectionView; onRoom: () => void }) {
  const { agent, room, gone, lastSeenAt } = view;
  const done = gone || agent.status === 'done';
  const now = useNow(1_000, 'server', !done);
  const task = agent.task;
  const endIso = task?.endedAt ?? (gone ? lastSeenAt : null);
  const end = done && endIso ? Date.parse(endIso) : now;
  const taskMs = task ? elapsedMs(task.startedAt, done ? endIso : task.endedAt, end) : null;
  const action = actionView(agent, gone, endIso);
  const actionMs = action.startedAt ? elapsedMs(action.startedAt, null, now) : null;
  const span = task
    ? done && endIso
      ? `${formatTimeOfDay(task.startedAt)} – ${formatTimeOfDay(endIso)}`
      : `Inicio ${formatTimeOfDay(task.startedAt)}`
    : null;

  return (
    <section className="drawer-sec" aria-label="Tarea">
      <div className="sec-head">
        <span className="label">Tarea</span>
        {span ? <span className="sec-aside">{span}</span> : null}
      </div>
      {gone ? (
        <p className="gone-note">
          <CircleCheck size={14} strokeWidth={STROKE} aria-hidden />
          Terminó y salió de la oficina. Estos son sus últimos datos.
        </p>
      ) : null}
      <p className={`drawer-task ${task ? '' : 'is-empty'}`}>{task ? task.title : 'Sin tarea asignada.'}</p>
      {task?.detail ? (
        <p className="drawer-task-detail">
          <Workflow size={12} strokeWidth={STROKE} aria-hidden className="flex-none" />
          <span>Flujo: {task.detail}</span>
        </p>
      ) : null}
      <div className="timers">
        <TimerCell label="Tarea" ms={taskMs} frozen={done} idle={agent.status === 'idle'} />
        <TimerCell label="Acción" ms={actionMs} frozen={done} idle={actionMs === null} />
      </div>
      <ActionRow action={action} />
      <button type="button" className="drawer-room" onClick={onRoom} title="Llevar la cámara a esta sala">
        <DoorOpen size={12} strokeWidth={STROKE} aria-hidden className="flex-none" />
        <span>{room.title}</span>
      </button>
    </section>
  );
}

/**
 * Alerta roja viva del agente (o de su sala, si es el lead), con enlace a Habitos. Sin region viva: el titulo
 * lleva el costo actual y cambia con cada snapshot, y el lector de pantalla lo releeria cada vez
 */
export function AlertBanner({ alert }: { alert: LiveAlert }) {
  const openHistory = useOfficeStore((s) => s.openHistory);
  const Icon = alert.level === 'critical' ? Siren : TriangleAlert;
  return (
    <section className={`drawer-sec lv-alert is-${alert.level}`} aria-label="Alerta">
      <p className="lv-alert-line">
        <Icon size={16} strokeWidth={STROKE} aria-hidden />
        <span className="lv-alert-text">
          <span className="lv-alert-level">{ALERT_LEVEL_LABEL[alert.level]}</span>
          {alert.title}
        </span>
      </p>
      <button type="button" className="btn btn--sm lv-alert-open" onClick={() => openHistory('habits')}>
        <Lightbulb size={12} strokeWidth={STROKE} aria-hidden />
        Ver hábitos
      </button>
    </section>
  );
}

function Fact({ k, children, className }: { k: string; children: ReactNode; className?: string }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd className={className}>{children}</dd>
    </div>
  );
}

/** Ficha del agente: quien es, donde esta, de quien depende y cuando trabajo (solo datos del snapshot) */
function IdentitySection({ view }: { view: SelectionView }) {
  const { agent, room, gone } = view;
  const snapshot = useOfficeStore((s) => s.snapshot);
  const now = useNow(30_000, 'server');
  const identity = agentIdentity(agent, room, snapshot);
  const status = gone ? 'done' : agent.status;
  const place = gone ? null : identity.place;
  return (
    <section className="drawer-sec" aria-label="Identidad">
      <div className="sec-head">
        <span className="label">Identidad</span>
      </div>
      <dl className="flow-facts lv-facts">
        <Fact k="Rol">{identity.role ? ROLE_LABEL[identity.role] : '—'}</Fact>
        <Fact k="Lugar" className={place === 'door' ? 'lv-door' : undefined}>
          {place ? PLACE_LABEL[place] : '—'}
        </Fact>
        <Fact k="Modelo">
          <span title={agent.model ? `Modelo: ${agent.model}` : undefined}>{modelLabel(agent.model)}</span>
        </Fact>
        <Fact k="Proyecto · rama">
          <span className="lv-project">
            {identity.projectName}
            {identity.branch ? (
              <span className="lv-branch" title={`Rama git: ${identity.branch}`}>
                <GitBranch size={12} strokeWidth={STROKE} aria-hidden />
                <span className="sr-only">rama </span>
                {identity.branch}
              </span>
            ) : null}
          </span>
        </Fact>
        <Fact k="Tarea">{agent.task?.title || 'Sin tarea asignada'}</Fact>
        <Fact k="Padre">
          <ParentLink parent={identity.parent} leadId={room.lead.id} />
        </Fact>
        <Fact k="Subagentes">
          <ChildrenList identity={identity} />
        </Fact>
        <Fact k="Inicio">{identity.startedAt ? formatLastActivity(identity.startedAt, now) : '—'}</Fact>
        <Fact k="Última actividad">{identity.lastActivityAt ? formatAgo(identity.lastActivityAt, now) : '—'}</Fact>
        <Fact k="Estado">{STATUS_LABEL[status]}</Fact>
      </dl>
    </section>
  );
}

function AgentLink({ id, children }: { id: string; children: ReactNode }) {
  const selectAgent = useOfficeStore((s) => s.selectAgent);
  return (
    <button type="button" className="lv-link" onClick={() => selectAgent(id)}>
      {children}
    </button>
  );
}

function ParentLink({ parent, leadId }: { parent: AgentIdentity['parent']; leadId: string }) {
  if (parent.kind === 'lead') return <AgentLink id={leadId}>Líder de la sesión</AgentLink>;
  if (parent.kind === 'agent') return <AgentLink id={parent.id}>{parent.name}</AgentLink>;
  if (parent.kind === 'gone') return <span className="muted">Un subagente que ya salió</span>;
  return <>—</>;
}

/** "5 · Bruno, Elena · en flujo: Gael · 2 ya salieron": los que siguen en la oficina se abren con un clic */
function ChildrenList({ identity }: { identity: AgentIdentity }) {
  const { children, flowChildren } = identity;
  const { total, left } = childrenTotals(identity);
  if (total === 0) return <>Ninguno</>;
  return (
    <span className="lv-children">
      <span className="num">{total}</span>
      {children.map((child, i) => (
        <Fragment key={child.id}>
          {i === 0 ? ' · ' : ', '}
          <AgentLink id={child.id}>{child.name}</AgentLink>
        </Fragment>
      ))}
      {flowChildren.map((child, i) => (
        <Fragment key={child.id}>
          {i === 0 ? ' · en flujo: ' : ', '}
          <AgentLink id={child.id}>{child.name}</AgentLink>
        </Fragment>
      ))}
      {left > 0 ? <span className="muted"> · {left === 1 ? '1 ya salió' : `${left} ya salieron`}</span> : null}
    </span>
  );
}

/** Corrida del tool Workflow a la que pertenece el agente, con enlace al panel de su sala, que la cuenta */
function FlowSection({ workflow }: { workflow: NonNullable<OfficeAgent['workflow']> }) {
  const run = useOfficeStore((s) => findRun(s.snapshot, workflow.runId));
  const progress = run ? phaseProgress(run) : null;
  return (
    <section className="drawer-sec" aria-label="Flujo">
      <div className="sec-head">
        <span className="label">Flujo</span>
        {run ? <RunStatusChip status={run.status} /> : null}
      </div>
      <dl className="flow-facts">
        <div>
          <dt>Corrida</dt>
          <dd title={run?.description || undefined}>{prettyRunName(workflow.name)}</dd>
        </div>
        <div>
          <dt>Fase</dt>
          <dd>
            {workflow.phase ?? 'Sin fase'}
            {progress ? <span className="muted"> · {phaseText(progress)}</span> : null}
          </dd>
        </div>
        {workflow.label ? (
          <div>
            <dt>Etiqueta</dt>
            <dd>{workflow.label}</dd>
          </div>
        ) : null}
      </dl>
      <button type="button" className="btn btn--sm flow-open" onClick={() => openFlowRoom(workflow.runId)}>
        <Workflow size={12} strokeWidth={STROKE} aria-hidden />
        Ver el flujo
      </button>
    </section>
  );
}

function TimerCell({ label, ms, frozen, idle }: { label: string; ms: number | null; frozen: boolean; idle: boolean }) {
  return (
    <div className={`timer ${frozen ? 'is-frozen' : idle ? 'is-idle' : ''}`}>
      <div className="timer-top">
        <span className="label">{label}</span>
        <span className="timer-frozen">
          <Lock size={12} strokeWidth={STROKE} aria-hidden />
          congelado
        </span>
      </div>
      <span className="timer-value" aria-label={ms === null ? `${label}: sin cronómetro` : undefined}>
        {ms === null ? '—' : formatClock(ms)}
      </span>
    </div>
  );
}

/**
 * Fila de accion (D3). Cuando llega una accion nueva (D5): la anterior sube y se va en 160 ms, la nueva
 * entra desde +8 px en 240 ms con 80 ms de retardo y un destello de 600 ms.
 */
function ActionRow({ action }: { action: ActionView }) {
  const firstKey = useRef(action.key);
  const [previous, setPrevious] = useState<ActionView | null>(null);
  const [last, setLast] = useState(action);
  if (last.key !== action.key) {
    setPrevious(last);
    setLast(action);
  }

  useEffect(() => {
    if (!previous) return;
    const id = window.setTimeout(() => setPrevious(null), DURATION.actionOut);
    return () => window.clearTimeout(id);
  }, [previous]);

  const isNew = action.key !== firstKey.current;
  return (
    <div className="action-slot" aria-live="polite">
      {previous ? <ActionLine key={`out-${previous.key}`} action={previous} extra="is-leaving" /> : null}
      <ActionLine key={action.key} action={action} extra={isNew ? 'is-new' : ''} />
    </div>
  );
}

function ActionLine({ action, extra }: { action: ActionView; extra: string }) {
  const cls = `action-row ${action.kind === 'tool' ? '' : `is-${action.kind}`} ${extra}`;
  return (
    <div className={cls}>
      {action.kind === 'tool' && action.tool ? (
        <ToolIcon tool={action.tool} size={14} />
      ) : action.kind === 'thinking' ? (
        <Ellipsis size={14} strokeWidth={STROKE} aria-hidden />
      ) : action.kind === 'idle' ? (
        <Pause size={14} strokeWidth={STROKE} aria-hidden />
      ) : (
        <Check size={14} strokeWidth={STROKE} aria-hidden />
      )}
      <span title={action.label}>
        {action.label}
        {action.kind === 'thinking' ? (
          <>
            {' '}
            <ThinkingDots />
          </>
        ) : null}
      </span>
      {action.tool ? <span className="action-tool">{action.tool}</span> : null}
    </div>
  );
}
