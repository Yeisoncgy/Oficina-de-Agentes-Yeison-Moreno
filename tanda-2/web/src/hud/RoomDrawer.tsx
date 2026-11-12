import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronRight, Crown, Eye, EyeOff, GitBranch, Lightbulb, MapPin, X } from 'lucide-react';
import type { OfficeAgent, OfficeRoom } from '@shared/contract';
import { elapsedMs, formatClock } from '@/lib/format';
import {
  activityText,
  ALERT_LEVEL_LABEL,
  formatAgo,
  formatLastActivity,
  ROOM_STATE_LABEL,
  roomAgents,
  roomAlert,
  roomState,
  roomStats,
  type RoomState,
} from '@/lib/office';
import { roomIdentity } from '@/lib/roomIdentity';
import { pendingNotes, roomsBySlot } from '@/state/notesApi';
import { useOfficeStore } from '@/state/store';
import { agentColor, DURATION, lookKey, STATE } from '@/theme';
import { AlertBanner } from './AgentDrawer';
import { RoomFlow } from './flows/RoomFlow';
import { useHudEdge } from './hudInsets';
import { Portrait } from './PixelArt';
import { IconButton, Led, STROKE } from './primitives';
import { RoomTools } from './RoomList';
import { TokenBreakdownView } from './TokenBreakdownView';
import { useNow } from './useNow';
import { usePresence } from './usePresence';
import './room-drawer.css';

/**
 * Panel derecho de la sala (igual que el del agente). Se abre con un clic en la sala, en la
 * lista o en la escena; comparte el lado derecho con el panel del agente y uno cierra al otro.
 * Poco texto porque la pantalla se proyecta: el numero y el color de la sala (roomIdentity) dicen cual es,
 * las caras dicen quien esta y el gasto sale oculto hasta "Mostrar gasto".
 */
export function RoomDrawer() {
  const roomId = useOfficeStore((s) => s.selectedRoomId);
  const snapshot = useOfficeStore((s) => s.snapshot);
  const room = useMemo(() => snapshot?.rooms.find((r) => r.id === roomId) ?? null, [snapshot, roomId]);
  const { shown, leaving } = usePresence(room, DURATION.drawerOut);
  if (!shown) return null;
  return <RoomPanel key={shown.id} room={shown} leaving={leaving} />;
}

function RoomPanel({ room, leaving }: { room: OfficeRoom; leaving: boolean }) {
  const closeDrawer = useOfficeStore((s) => s.closeDrawer);
  const here = useOfficeStore((s) => s.snapshot?.leadRoomId === room.id);
  // sin slot (demo, fixtures) el numero sale del orden de la lista, igual que en ella
  const fallbackIndex = useOfficeStore((s) =>
    s.snapshot ? Math.max(0, roomsBySlot(s.snapshot.rooms).findIndex((r) => r.id === room.id)) : 0,
  );
  const identity = roomIdentity(room, fallbackIndex);
  const titleId = useId();
  const numberId = useId();
  const edgeRef = useHudEdge('right', !leaving);
  const now = useNow(30_000, 'server');
  const state = roomState(room, now);
  const alert = roomAlert(room);
  const pending = pendingNotes(room).length;
  const systemName = room.customName && room.autoTitle && room.autoTitle !== room.title ? room.autoTitle : null;

  return (
    <aside
      ref={edgeRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${numberId} ${titleId}`}
      className={`hud-drawer rd-drawer ${leaving ? 'is-leaving' : ''}`}
      style={{ '--room': identity.accent } as CSSProperties}
    >
      <header className="rd-head scanline">
        <div className="rd-id-row">
          <span className="rd-num display" aria-hidden>
            {identity.label}
          </span>
          <span id={numberId} className="sr-only">
            Sala {identity.number}
          </span>
          <div className="drawer-id">
            <h2
              id={titleId}
              className="drawer-name display m-0"
              title={systemName ? `Nombre del sistema: ${systemName}` : undefined}
            >
              {room.title}
            </h2>
            <span className="drawer-sub rd-sub">
              <span className="drawer-sub-text" title={room.cwd}>
                {room.projectName}
              </span>
              {room.gitBranch ? (
                <span className="rd-branch" title={`Rama git: ${room.gitBranch}`}>
                  <GitBranch size={12} strokeWidth={STROKE} aria-hidden />
                  <span className="sr-only">rama </span>
                  {room.gitBranch}
                </span>
              ) : null}
            </span>
          </div>
          <IconButton label="Cerrar (Esc)" className="rd-close" onClick={closeDrawer}>
            <X size={16} strokeWidth={STROKE} />
          </IconButton>
        </div>
        <Vitals room={room} state={state} now={now} />
      </header>

      <div className="drawer-body rd-body">
        {alert ? <AlertBanner alert={alert.alert} /> : null}
        {/* el flujo va primero: es lo que mas cambia y lo que hay que entender de un vistazo */}
        <RoomFlow room={room} />
        <WhoIsHere room={room} here={here} />
        <SpendSection room={room} />
      </div>

      <footer className="rd-foot" aria-label="Acciones de la sala">
        <RoomTools room={room} pending={pending} />
      </footer>
    </aside>
  );
}

/** Tres datos grandes bajo el nombre: como esta, cuando fue lo ultimo y los hallazgos (enlace a Habitos) */
function Vitals({ room, state, now }: { room: OfficeRoom; state: RoomState; now: number }) {
  const openHistory = useOfficeStore((s) => s.openHistory);
  const habits = room.habitCount ?? 0;
  return (
    <dl className="rd-vitals m-0">
      <div className={`rd-vital rd-vital--state is-${state}`}>
        <dt className="label">Estado</dt>
        <dd className="rd-vital-v">
          <StateLed state={state} />
          {ROOM_STATE_LABEL[state]}
        </dd>
      </div>
      <div className="rd-vital" title={`Última actividad: ${formatLastActivity(room.lastActivityAt, now)}`}>
        <dt className="label">Actividad</dt>
        <dd className="rd-vital-v num">{state === 'working' ? 'ahora' : formatAgo(room.lastActivityAt, now)}</dd>
      </div>
      <div className={`rd-vital ${habits > 0 ? 'has-habits' : ''}`}>
        <dt className="label">Hallazgos</dt>
        <dd className="rd-vital-v num">
          {habits > 0 ? (
            <button
              type="button"
              className="rd-vital-link"
              onClick={() => openHistory('habits')}
              aria-label={`${habits === 1 ? '1 hallazgo' : `${habits} hallazgos`} de hábitos: ver en Hábitos`}
            >
              <Lightbulb size={14} strokeWidth={STROKE} aria-hidden />
              {habits}
              <ChevronRight size={12} strokeWidth={STROKE} aria-hidden className="rd-vital-go" />
            </button>
          ) : (
            <span className="muted">0</span>
          )}
        </dd>
      </div>
    </dl>
  );
}

function StateLed({ state }: { state: RoomState }) {
  if (state === 'working') return <Led mode="blink" color={STATE.working} />;
  if (state === 'waiting') return <Led color={STATE.idle} />;
  return <Led color={STATE.offline} hollow />;
}

function agentsAside(room: OfficeRoom): string {
  const { working, present } = roomStats(room);
  if (working === 0) return `${present} en la sala`;
  return `${working} de ${present} trabajando`;
}

/**
 * Quien esta: una cara por agente, el lider primero. Quien trabaja va encendido y con LED; pasar el puntero
 * (o el foco) por una cara la resalta tambien en la escena y cuenta en la linea de abajo que hace.
 */
function WhoIsHere({ room, here }: { room: OfficeRoom; here: boolean }) {
  const hoveredAgentId = useOfficeStore((s) => s.hoveredAgentId);
  const hoverAgent = useOfficeStore((s) => s.hoverAgent);
  const agents = roomAgents(room);
  const hovered = useRef<string | null>(null);

  // si la cara se desmonta con el puntero encima (clic abre el agente), la escena no queda resaltandolo
  useEffect(
    () => () => {
      if (hovered.current) useOfficeStore.getState().hoverAgent(null, hovered.current);
    },
    [],
  );

  const enter = (id: string) => {
    hovered.current = id;
    hoverAgent(id);
  };
  const leave = (id: string) => {
    if (hovered.current === id) hovered.current = null;
    hoverAgent(null, id);
  };

  const peeked = agents.find((a) => a.id === hoveredAgentId) ?? null;
  const subject = peeked ?? agents.find((a) => a.status === 'working') ?? null;

  return (
    <section className="drawer-sec rd-who" aria-label="Quién está">
      <div className="sec-head">
        <span className="label">Quién está</span>
        <span className="sec-aside">{agentsAside(room)}</span>
      </div>
      <ul className="rd-faces m-0 list-none" aria-label={`Agentes de ${room.title}`}>
        {agents.map((agent, index) => (
          <li key={agent.id}>
            <Face
              agent={agent}
              index={index}
              here={here && agent.kind === 'lead'}
              peeked={peeked?.id === agent.id}
              onEnter={enter}
              onLeave={leave}
            />
          </li>
        ))}
      </ul>
      <DoingLine agent={subject} />
    </section>
  );
}

function Face({
  agent,
  index,
  here,
  peeked,
  onEnter,
  onLeave,
}: {
  agent: OfficeAgent;
  index: number;
  here: boolean;
  peeked: boolean;
  onEnter: (id: string) => void;
  onLeave: (id: string) => void;
}) {
  const selectAgent = useOfficeStore((s) => s.selectAgent);
  const lead = agent.kind === 'lead';
  const working = agent.status === 'working';
  const look = lookKey(agent);
  // quien ya sale no arrastra la alerta (igual que la sala)
  const alert = agent.status === 'done' ? null : (agent.alert ?? null);
  const label = [
    agent.displayName,
    lead ? 'líder' : null,
    here ? 'está aquí' : null,
    working ? 'trabajando' : activityText(agent).toLowerCase(),
    alert ? `${ALERT_LEVEL_LABEL[alert.level]}: ${alert.title}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <button
      type="button"
      className={`rd-face is-${agent.status} ${lead ? 'is-lead' : ''} ${peeked ? 'is-peeked' : ''}`}
      style={{ '--i': Math.min(index, 11), '--face': agentColor(look) } as CSSProperties}
      aria-label={label}
      onClick={() => selectAgent(agent.id)}
      onPointerEnter={() => onEnter(agent.id)}
      onPointerLeave={() => onLeave(agent.id)}
      onFocus={() => onEnter(agent.id)}
      onBlur={() => onLeave(agent.id)}
    >
      <span className="rd-face-pic">
        <Portrait agentType={look} size={40} dim={!working} />
        {working ? <Led mode="blink" color={STATE.working} className="rd-face-led" /> : null}
        {lead ? (
          <span className="rd-face-badge rd-face-lead" aria-hidden>
            <Crown size={10} strokeWidth={2} />
          </span>
        ) : null}
        {here ? (
          <span className="rd-face-badge rd-face-here" aria-hidden>
            <MapPin size={10} strokeWidth={2} />
          </span>
        ) : null}
        {alert ? (
          <span className={`rd-face-badge rd-face-alert is-${alert.level}`} aria-hidden>
            !
          </span>
        ) : null}
      </span>
      <span className="rd-face-name" aria-hidden>
        {agent.displayName}
      </span>
    </button>
  );
}

/** Una sola linea: el que trabaja (o la cara bajo el puntero), que hace y hace cuanto. Nunca prompts */
function DoingLine({ agent }: { agent: OfficeAgent | null }) {
  const working = agent?.status === 'working';
  const now = useNow(1_000, 'server', working);
  if (!agent) {
    return <p className="rd-doing is-empty m-0">Nadie trabaja ahora</p>;
  }
  const task = agent.task;
  const text = working ? task?.title || activityText(agent) : activityText(agent);
  const clock = working && task ? formatClock(elapsedMs(task.startedAt, task.endedAt, now)) : null;
  return (
    <p className={`rd-doing m-0 ${working ? 'is-working' : ''}`} title={`${agent.displayName}: ${text}`}>
      {working ? <Led mode="blink" color={STATE.working} /> : <Led color={STATE.idle} hollow={agent.status === 'done'} />}
      <span className="rd-doing-name" style={{ color: agentColor(lookKey(agent)) }}>
        {agent.displayName}
      </span>
      <span className="rd-doing-text">{text}</span>
      {clock ? <span className="rd-doing-clock num">{clock}</span> : null}
    </p>
  );
}

/** Gasto oculto por defecto (la pantalla se proyecta); la misma preferencia recordada del ranking y los flujos */
function SpendSection({ room }: { room: OfficeRoom }) {
  const shown = useOfficeStore((s) => s.showSpend);
  const toggleSpend = useOfficeStore((s) => s.toggleSpend);
  const bodyId = useId();
  return (
    <section className="drawer-sec rd-spend" aria-label="Gasto">
      <div className="sec-head">
        <span className="label">Gasto</span>
        <button
          type="button"
          className="btn btn--sm"
          aria-expanded={shown}
          aria-controls={bodyId}
          onClick={toggleSpend}
        >
          {shown ? <EyeOff size={14} strokeWidth={STROKE} aria-hidden /> : <Eye size={14} strokeWidth={STROKE} aria-hidden />}
          {shown ? 'Ocultar gasto' : 'Mostrar gasto'}
        </button>
      </div>
      <div id={bodyId} className="rd-spend-body" hidden={!shown}>
        {shown ? <TokenBreakdownView tokens={room.tokens} costUsd={room.costUsd} model={null} /> : null}
      </div>
    </section>
  );
}
