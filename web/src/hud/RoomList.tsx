import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RotateCcw,
  Siren,
  StickyNote,
  Trash2,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import { ROOM_NAME_MAX, type ArchivedRoom, type OfficeAgent, type OfficeRoom } from '@shared/contract';
import { describeApiError } from '@/state/api';
import { deleteRoomForever, pendingNotes, renameRoom, reorderRooms, roomsBySlot, setRoomArchived } from '@/state/notesApi';
import { BOOT_WINDOW_MS } from '@/lib/motion';
import {
  ALERT_LEVEL_LABEL,
  formatAgo,
  ROOM_STATE_LABEL,
  roomAgents,
  roomAlert,
  roomState,
  roomStats,
  roomStatusText,
  type RoomState,
} from '@/lib/office';
import { roomIdentity, type RoomIdentity } from '@/lib/roomIdentity';
import { openFlowRoom, phaseProgress, roomFlowText } from '@/lib/workflows';
import { findAgent, useOfficeStore } from '@/state/store';
import { lookKey, STATE } from '@/theme';
import { useHudEdge } from './hudInsets';
import { Portrait } from './PixelArt';
import { IconButton, Led, PanelState, SkeletonLines, STROKE } from './primitives';
import { useNow } from './useNow';
import { useViewportWidth } from './usePresence';
import './room-list.css';

/** Por debajo de este ancho la lista se pliega sola cuando se abre el panel del agente (D3) */
export const RAIL_WITH_DRAWER_BELOW = 1600;

const BOOT_AT = typeof performance === 'undefined' ? 0 : performance.now();

/** Lista desplegada o en riel (el dock de Flujos se acomoda a su ancho) */
export function useRoomListMode(): 'open' | 'rail' {
  const listOpen = useOfficeStore((s) => s.roomListOpen);
  // solo el panel del agente la pliega: el de la sala se abre desde la lista y no debe hacerla saltar
  const agentDrawer = useOfficeStore((s) => s.selectedAgentId !== null);
  const width = useViewportWidth();
  const forcedRail = agentDrawer && width < RAIL_WITH_DRAWER_BELOW;
  return listOpen && !forcedRail ? 'open' : 'rail';
}

/** Boton de la lista y tecla Tab: si el panel del agente la tiene plegada, desplegarla cierra ese panel */
export function toggleRoomList(viewportWidth: number): void {
  const s = useOfficeStore.getState();
  const forcedRail = s.selectedAgentId !== null && viewportWidth < RAIL_WITH_DRAWER_BELOW;
  if (s.roomListOpen && !forcedRail) {
    s.setRoomListOpen(false);
    return;
  }
  if (forcedRail) s.selectAgent(null);
  s.setRoomListOpen(true);
}

export function RoomList() {
  const width = useViewportWidth();
  const mode = useRoomListMode();
  const edgeRef = useHudEdge('left');

  // la entrada del HUD corre una sola vez por carga; despues el panel se abre desde su borde
  const [booting] = useState(() => performance.now() - BOOT_AT < BOOT_WINDOW_MS);
  const lastMode = useRef(mode);
  const switched = useRef(false);
  if (lastMode.current !== mode) {
    lastMode.current = mode;
    switched.current = true;
  }
  const enterCls = booting && !switched.current ? 'is-booting' : switched.current ? 'is-opening' : '';

  const toggle = () => toggleRoomList(width);

  return mode === 'open' ? (
    <RoomsPanel key="open" className={enterCls} onToggle={toggle} edgeRef={edgeRef} />
  ) : (
    <RoomsRail key="rail" className={enterCls} onToggle={toggle} edgeRef={edgeRef} />
  );
}

type EdgeRef = (el: HTMLElement | null) => (() => void) | undefined;

/** Sala resaltada: la del panel abierto; si no, donde esta la camara; si no, la del agente abierto */
function useCurrentRoomId(): string | null {
  const panelRoomId = useOfficeStore((s) => s.selectedRoomId);
  const focusedRoomId = useOfficeStore((s) => s.focus?.roomId ?? null);
  const agentRoomId = useOfficeStore((s) => findAgent(s.snapshot, s.selectedAgentId)?.room.id ?? null);
  return panelRoomId ?? focusedRoomId ?? agentRoomId;
}

/**
 * Numero y color de cada sala (los mismos que en la escena y en su panel). Sin slot (demo), el indice en el
 * orden del mapa: asi un arrastre pendiente no le cambia el color a nadie.
 */
function useRoomIdentities(rooms: readonly OfficeRoom[] | undefined): Map<string, RoomIdentity> {
  const map = new Map<string, RoomIdentity>();
  roomsBySlot(rooms ?? []).forEach((room, i) => map.set(room.id, roomIdentity(room, i)));
  return map;
}

/**
 * Puntero o foco sobre una ficha: la escena resalta esa sala, y la ficha se resalta cuando el puntero esta
 * sobre la sala en la escena. Al desmontar (plegar la lista) suelta el resaltado si era suyo.
 */
function useRoomHover(roomId: string) {
  const hovered = useOfficeStore((s) => s.hoveredRoomId === roomId);
  useEffect(() => () => useOfficeStore.getState().hoverRoom(null, roomId), [roomId]);
  const enter = () => useOfficeStore.getState().hoverRoom(roomId);
  const leave = () => useOfficeStore.getState().hoverRoom(null, roomId);
  return { hovered, handlers: { onPointerEnter: enter, onPointerLeave: leave, onFocus: enter, onBlur: leave } };
}

/** Clic en una sala de la lista: la camara va a ella y se abre su panel; otro clic en la del panel lo cierra */
function toggleRoomPanel(roomId: string): void {
  const s = useOfficeStore.getState();
  if (s.selectedRoomId === roomId) {
    s.selectRoom(null);
    return;
  }
  s.focusRoom(roomId);
  s.selectRoom(roomId);
}

/** Sala a la que llevan las flechas: la siguiente (+1) o la anterior (-1), dando la vuelta; sin sala actual, la primera o la ultima */
export function nextRoomId(ids: readonly string[], currentId: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = currentId === null ? -1 : ids.indexOf(currentId);
  if (at < 0) return (dir > 0 ? ids[0] : ids[ids.length - 1]) ?? null;
  return ids[(at + dir + ids.length) % ids.length] ?? null;
}

/** La lista esta desplegada (no en riel): mismas reglas que useRoomListMode, fuera de React */
export function roomListIsOpen(viewportWidth: number): boolean {
  const s = useOfficeStore.getState();
  return s.roomListOpen && !(s.selectedAgentId !== null && viewportWidth < RAIL_WITH_DRAWER_BELOW);
}

/**
 * Flechas con la lista desplegada: pasa a la sala siguiente o anterior en el orden de la lista, lleva la
 * camara y abre su panel (el panel sigue a la sala). Devuelve false si no hay salas.
 */
export function stepRoom(dir: 1 | -1): boolean {
  const s = useOfficeStore.getState();
  const ids = roomsBySlot(s.snapshot?.rooms ?? []).map((r) => r.id);
  const current = s.selectedRoomId ?? s.focus?.roomId ?? findAgent(s.snapshot, s.selectedAgentId)?.room.id ?? null;
  const id = nextRoomId(ids, current, dir);
  if (id === null) return false;
  s.focusRoom(id);
  s.selectRoom(id);
  return true;
}

function RoomsPanel({ className, onToggle, edgeRef }: { className: string; onToggle: () => void; edgeRef: EdgeRef }) {
  const snapshot = useOfficeStore((s) => s.snapshot);
  const connection = useOfficeStore((s) => s.connection);
  const requestReconnect = useOfficeStore((s) => s.requestReconnect);
  const panelRoomId = useOfficeStore((s) => s.selectedRoomId);
  const currentId = useCurrentRoomId();
  const now = useNow(30_000, 'local');
  const demo = useOfficeStore((s) => s.demo);
  const drag = useRoomDrag(snapshot?.rooms, !demo);
  const rooms = drag.rooms;
  const identities = useRoomIdentities(snapshot?.rooms);

  return (
    <nav id="room-list" ref={edgeRef} aria-label="Salas" className={`hud-rooms win ${className}`}>
      <div className="win-head scanline">
        <h2 className="display m-0">Salas</h2>
        {rooms ? <span className="rooms-count">{rooms.length}</span> : null}
        <IconButton label="Plegar lista (Tab)" onClick={onToggle} aria-controls="room-list" aria-expanded>
          <PanelLeftClose size={16} strokeWidth={STROKE} />
        </IconButton>
      </div>
      {!rooms ? (
        connection === 'offline' ? (
          <PanelState
            kind="error"
            title="No se pudieron cargar las salas"
            text="El servidor de la oficina no responde. La lista vuelve sola al reconectar."
            onRetry={requestReconnect}
          />
        ) : (
          <div className="rooms-list" role="status" aria-label="Cargando salas">
            {[
              ['70%', '45%'],
              ['60%', '40%'],
              ['65%', '50%'],
            ].map((widths, i) => (
              <div key={i} className="skel-room">
                <span className="skel-room-band" aria-hidden />
                <span className="skel-room-lines">
                  <SkeletonLines widths={widths} />
                </span>
              </div>
            ))}
          </div>
        )
      ) : rooms.length === 0 ? (
        <PanelState
          kind="empty"
          title={snapshot?.archivedRooms?.length ? 'Todas las salas están archivadas' : 'Todavía no hay salas'}
          text={
            snapshot?.archivedRooms?.length
              ? 'Restáuralas desde Archivadas, abajo. También vuelven solas si su chat sigue trabajando.'
              : 'Aparecen aquí cuando un proyecto abre su primera sesión.'
          }
        />
      ) : (
        <ul className="rooms-list m-0 list-none">
          {rooms.map((room) => (
            <RoomItem
              key={room.id}
              room={room}
              identity={identities.get(room.id) ?? roomIdentity(room)}
              now={now}
              here={snapshot?.leadRoomId === room.id}
              current={room.id === currentId}
              panelOpen={room.id === panelRoomId}
              dragProps={drag.itemProps(room.id)}
            />
          ))}
        </ul>
      )}
      {drag.error ? (
        <span className="room-tools-error rooms-drag-error" role="alert">
          {drag.error}
        </span>
      ) : null}
      {snapshot?.archivedRooms && snapshot.archivedRooms.length > 0 ? <ArchivedList rooms={snapshot.archivedRooms} /> : null}
    </nav>
  );
}

type DropSide = 'before' | 'after';

interface RoomDragProps {
  draggable: boolean;
  className: string;
  onDragStart?: (event: DragEvent<HTMLLIElement>) => void;
  onDragOver?: (event: DragEvent<HTMLLIElement>) => void;
  onDrop?: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd?: () => void;
}

/**
 * La lista va por lugar fijo en el mapa (no salta con la actividad). Dejando presionado el click se
 * arrastra una sala a otra posicion: las salas intercambian sus lugares del mapa. Mientras el server
 * confirma, se muestra el orden nuevo.
 */
function useRoomDrag(snapshotRooms: readonly OfficeRoom[] | undefined, enabled: boolean) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; side: DropSide } | null>(null);
  const [pending, setPending] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bySlot = snapshotRooms ? roomsBySlot(snapshotRooms) : undefined;
  const serverOrder = bySlot?.map((r) => r.id).join('|') ?? '';
  // el snapshot ya trae el orden pedido (o cambio el juego de salas): se suelta el orden local
  useEffect(() => {
    setPending((p) => (p && p.join('|') !== serverOrder ? p : null));
  }, [serverOrder]);

  let rooms = bySlot;
  if (bySlot && pending) {
    const rank = new Map(pending.map((id, i) => [id, i]));
    rooms = [...bySlot].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  }

  const drop = (targetId: string, side: DropSide) => {
    if (!rooms || !dragId || dragId === targetId) return;
    const ids = rooms.map((r) => r.id).filter((id) => id !== dragId);
    const at = ids.indexOf(targetId);
    if (at < 0) return;
    ids.splice(side === 'before' ? at : at + 1, 0, dragId);
    if (ids.join('|') === rooms.map((r) => r.id).join('|')) return;
    setPending(ids);
    setError(null);
    reorderRooms(ids).then(
      ({ moved }) => {
        if (!moved) setPending(null);
      },
      (err: unknown) => {
        setPending(null);
        setError(describeApiError(err));
      },
    );
  };

  const end = () => {
    setDragId(null);
    setOver(null);
  };

  const itemProps = (id: string): RoomDragProps => {
    if (!enabled || !rooms || rooms.length < 2) return { draggable: false, className: '' };
    const cls = [
      dragId === id ? 'is-dragging' : '',
      over?.id === id && dragId !== id ? `is-drop-${over.side}` : '',
    ].join(' ');
    return {
      draggable: true,
      className: cls,
      onDragStart: (event) => {
        // seleccionar texto en el campo de renombrar no arrastra la sala
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', id);
        setDragId(id);
      },
      onDragOver: (event) => {
        if (!dragId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const box = event.currentTarget.getBoundingClientRect();
        const side: DropSide = event.clientY < box.top + box.height / 2 ? 'before' : 'after';
        if (over?.id !== id || over.side !== side) setOver({ id, side });
      },
      onDrop: (event) => {
        event.preventDefault();
        if (over) drop(id, over.side);
        end();
      },
      onDragEnd: end,
    };
  };

  return { rooms, itemProps, error };
}

/** Caras en la ficha: primero las que trabajan; de ahi en adelante, "+N" */
const MAX_FACES = 5;
/** Con un flujo en curso su chip ocupa la esquina de la fila: lugares (caras o "+N") que caben a su lado */
const FLOW_SLOTS = 4;

type RoomAlertInfo = NonNullable<ReturnType<typeof roomAlert>>;
type RoomFlowInfo = NonNullable<ReturnType<typeof roomFlowText>>;

/**
 * Ficha de sala (poco texto: la pantalla puede proyectarse). Banda con el numero y el color de la
 * sala, nombre, una linea de estado y las caras de quien esta. Costo y tokens van en el panel de la sala; las
 * senales (alerta, notas, habitos, "estas aqui") son iconos que solo aparecen cuando aplican. El estado se lee
 * por brillo: trabajando se enciende, inactiva o cerrada se apaga y queda en una linea.
 */
function RoomItem({
  room,
  identity,
  now,
  here,
  current,
  panelOpen,
  dragProps,
}: {
  room: OfficeRoom;
  identity: RoomIdentity;
  now: number;
  here: boolean;
  current: boolean;
  panelOpen: boolean;
  dragProps: RoomDragProps;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const { hovered, handlers } = useRoomHover(room.id);
  const present = roomAgents(room).filter((a) => a.status !== 'done');
  const state = roomState(room, now);
  const flow = roomFlowText(room);
  const pending = pendingNotes(room).length;
  const alert = roomAlert(room);
  const habits = room.habitCount ?? 0;
  const quiet = state === 'inactive' || state === 'closed';
  // apagada = una linea; con su panel abierto, una alerta o un flujo en curso vuelve a la ficha completa
  const compact = quiet && !panelOpen && !alert && !flow;
  // el lead siempre esta: las caras solo dicen algo si hay mas de uno, alguien trabaja o corre un flujo
  const showFaces = !compact && (present.length > 1 || state === 'working' || flow !== null);
  const autoTitle = room.customName && room.autoTitle && room.autoTitle !== room.title ? `\n${room.autoTitle}` : '';

  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const cls = [
    'room-item',
    `room-item--${state}`,
    compact ? 'is-compact' : '',
    current ? 'is-current' : '',
    panelOpen ? 'is-selected' : '',
    hovered ? 'is-hovered' : '',
    alert ? `is-alerted is-${alert.alert.level}` : '',
    flow ? 'has-flow' : '',
    dragProps.className,
  ];

  return (
    <li
      ref={ref}
      className={cls.filter(Boolean).join(' ')}
      style={{ '--room': identity.accent } as CSSProperties}
      draggable={dragProps.draggable}
      onDragStart={dragProps.onDragStart}
      onDragOver={dragProps.onDragOver}
      onDrop={dragProps.onDrop}
      onDragEnd={dragProps.onDragEnd}
      {...handlers}
    >
      <button
        type="button"
        className="room"
        onClick={() => toggleRoomPanel(room.id)}
        aria-current={current ? 'true' : undefined}
        aria-pressed={panelOpen}
        title={`Sala ${identity.number} · ${room.title}${autoTitle}\n${roomStatusText(room, now)}\n${room.cwd}${
          panelOpen ? '\nClic para cerrar su panel' : '\nClic para ver su panel'
        }${dragProps.draggable ? '\nArrastra para cambiarla de posición' : ''}`}
      >
        <span className="room-num" aria-hidden>
          {identity.label}
        </span>
        <span className="sr-only">Sala {identity.number}: </span>
        <span className="room-body">
          <span className="room-head">
            <RoomLed state={state} />
            <span className="room-title">{room.title}</span>
            <RoomSignals room={room} here={here} pending={pending} habits={habits} alert={alert} />
            {compact ? <span className="room-ago">{formatAgo(room.lastActivityAt, now)}</span> : null}
          </span>
          {compact ? (
            <span className="sr-only">. {ROOM_STATE_LABEL[state]}</span>
          ) : (
            <span className="room-status">{statusLine(room, state, now)}</span>
          )}
          {showFaces ? <RoomFaces agents={present} flowSpace={flow ? flowChipText(flow) : undefined} /> : null}
        </span>
      </button>
      {flow ? <RoomFlowChip flow={flow} /> : null}
    </li>
  );
}

/** Una linea: cuantos trabajan, o el estado y hace cuanto fue la ultima actividad */
function statusLine(room: OfficeRoom, state: RoomState, now: number): string {
  if (state === 'working') {
    const { working } = roomStats(room);
    return working > 0 ? `${working} trabajando` : 'Trabajando';
  }
  return `${ROOM_STATE_LABEL[state]} · ${formatAgo(room.lastActivityAt, now)}`;
}

/** Senales como iconos, solo cuando aplican; el detalle va en el title y para lectores de pantalla */
function RoomSignals({
  room,
  here,
  pending,
  habits,
  alert,
}: {
  room: OfficeRoom;
  here: boolean;
  pending: number;
  habits: number;
  alert: RoomAlertInfo | null;
}) {
  if (!here && pending === 0 && habits === 0 && !alert) return null;
  const alertText = alert
    ? `${ALERT_LEVEL_LABEL[alert.alert.level]}: ${alert.agentName ? `${alert.agentName}: ` : ''}${alert.alert.title}`
    : '';
  const notesText = `${pending} ${pending === 1 ? 'nota pendiente' : 'notas pendientes'}`;
  const habitsText = `${habits} ${habits === 1 ? 'hallazgo de hábitos' : 'hallazgos de hábitos'}`;
  return (
    <span className="room-signals">
      {here ? (
        <span className="room-sig room-sig--here" title={`${room.lead.displayName} está aquí`}>
          <MapPin size={13} strokeWidth={STROKE} aria-hidden />
          <span className="sr-only">. {room.lead.displayName} está aquí</span>
        </span>
      ) : null}
      {pending > 0 ? (
        <span className="room-sig room-sig--notes" title={notesText}>
          <StickyNote size={12} strokeWidth={STROKE} aria-hidden />
          <span aria-hidden>{pending}</span>
          <span className="sr-only">. {notesText}</span>
        </span>
      ) : null}
      {habits > 0 ? (
        <span className="room-sig room-sig--habits" title={`${habitsText} en esta sala (A abre Hábitos)`}>
          <Lightbulb size={12} strokeWidth={STROKE} aria-hidden />
          <span aria-hidden>{habits}</span>
          <span className="sr-only">. {habitsText}</span>
        </span>
      ) : null}
      {alert ? (
        <span className={`room-sig room-sig--alert is-${alert.alert.level}`} title={alertText}>
          {alert.alert.level === 'critical' ? (
            <Siren size={13} strokeWidth={STROKE} aria-hidden />
          ) : (
            <TriangleAlert size={13} strokeWidth={STROKE} aria-hidden />
          )}
          <span className="sr-only">. {alertText}</span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * Caras de quien esta en la sala: las que trabajan encendidas, el resto atenuadas. Con un flujo en curso,
 * `flowSpace` es el texto del chip: la fila le guarda su sitio (::after en room-list.css) para no taparse.
 */
function RoomFaces({ agents, flowSpace }: { agents: OfficeAgent[]; flowSpace?: string }) {
  const sorted = [...agents].sort((a, b) => Number(b.status === 'working') - Number(a.status === 'working'));
  // con flujo caben FLOW_SLOTS lugares en una linea junto al chip, y el "+N" ocupa uno
  const max = flowSpace === undefined ? MAX_FACES : sorted.length > FLOW_SLOTS ? FLOW_SLOTS - 1 : FLOW_SLOTS;
  const shown = sorted.slice(0, max);
  const extra = sorted.length - shown.length;
  return (
    <span className="room-faces" data-flow={flowSpace} aria-hidden>
      {shown.map((a) => (
        <span key={a.id} className={`room-face ${a.status === 'working' ? 'is-working' : ''}`} title={a.displayName}>
          <Portrait agentType={lookKey(a)} size={20} dim={a.status !== 'working'} />
        </span>
      ))}
      {extra > 0 ? <span className="room-faces-more">+{extra}</span> : null}
    </span>
  );
}

/** Lo que se lee en el chip del flujo ("2/3", "2/3 +1"): la fila de caras lo usa para guardarle sitio */
function flowChipText(flow: RoomFlowInfo): string {
  const progress = phaseProgress(flow.run);
  return [progress ? `${progress.current}/${progress.total}` : '', flow.extra > 0 ? `+${flow.extra}` : '']
    .filter(Boolean)
    .join(' ');
}

/** Flujo en curso: chip compacto con la fase; lleva a la sala y abre el flujo en su panel */
function RoomFlowChip({ flow }: { flow: RoomFlowInfo }) {
  const progress = phaseProgress(flow.run);
  const label = `Flujo en curso: ${flow.text}${flow.extra > 0 ? ` y ${flow.extra} más` : ''}. Ver el flujo en el panel de la sala`;
  return (
    <button type="button" className="room-flow" onClick={() => openFlowRoom(flow.run.runId)} title={label} aria-label={label}>
      <Workflow size={12} strokeWidth={STROKE} aria-hidden className="flex-none" />
      {progress ? (
        <span className="room-flow-step" aria-hidden>
          {progress.current}/{progress.total}
        </span>
      ) : null}
      {flow.extra > 0 ? (
        <span className="room-flow-more" aria-hidden>
          +{flow.extra}
        </span>
      ) : null}
    </button>
  );
}

/** trabajando late; en espera queda fijo; inactiva o cerrada, hueco */
function RoomLed({ state }: { state: RoomState }) {
  if (state === 'working') return <Led mode="blink" color={STATE.working} className="room-led" />;
  if (state === 'waiting') return <Led color={STATE.idle} className="room-led" />;
  return <Led color={STATE.offline} hollow className="room-led" />;
}

/** Herramientas de la sala (van en su panel): ponerle nombre propio, abrir sus notas y archivarla */
export function RoomTools({ room, pending }: { room: OfficeRoom; pending: number }) {
  const openNotes = useOfficeStore((s) => s.openNotes);
  const demo = useOfficeStore((s) => s.demo);
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEdit = !demo && room.projectKey !== undefined;

  const archive = async () => {
    setArchiving(true);
    setError(null);
    try {
      await setRoomArchived(room.id, true);
      // el panel derecho no puede quedar abierto sobre una sala que ya no esta
      const state = useOfficeStore.getState();
      if (state.selectedRoomId === room.id) state.selectRoom(null);
      if (findAgent(state.snapshot, state.selectedAgentId)?.room.id === room.id) state.selectAgent(null);
    } catch (err) {
      setError(describeApiError(err));
      setArchiving(false);
    }
  };

  if (renaming) return <RenameForm room={room} onDone={() => setRenaming(false)} />;
  return (
    <div className="room-tools">
      <button
        type="button"
        className="room-tool"
        onClick={() => setRenaming(true)}
        disabled={!canEdit}
        title={canEdit ? 'Ponerle un nombre propio a la sala' : 'Necesita el servidor'}
      >
        <Pencil size={13} strokeWidth={STROKE} aria-hidden />
        Renombrar
      </button>
      <button type="button" className="room-tool" onClick={() => openNotes(room.id)} title="Pendientes de esta sala">
        <StickyNote size={13} strokeWidth={STROKE} aria-hidden />
        Notas
        {pending > 0 ? <span className="room-tools-count">{pending}</span> : null}
      </button>
      <IconButton
        label={demo ? 'Archivar (necesita el servidor)' : 'Archivar sala: sale de la oficina hasta que su chat vuelva a trabajar'}
        className="room-tools-archive"
        onClick={() => void archive()}
        disabled={demo || archiving}
      >
        <Archive size={14} strokeWidth={STROKE} />
      </IconButton>
      {error ? (
        <span className="room-tools-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Salas archivadas que sin eso estarian en la oficina: se restauran desde aqui */
function ArchivedList({ rooms }: { rooms: ArchivedRoom[] }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** sala con la confirmacion de eliminar a la vista */
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      setConfirmId(null);
    } catch (err) {
      setError(describeApiError(err));
    }
  };
  const restore = (id: string) => run(() => setRoomArchived(id, false));
  const remove = (id: string) => run(() => deleteRoomForever(id));

  return (
    <div className="rooms-archived">
      <button
        type="button"
        className="rooms-archived-toggle"
        aria-expanded={open}
        aria-controls="rooms-archived-list"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown size={14} strokeWidth={STROKE} aria-hidden />
        ) : (
          <ChevronRight size={14} strokeWidth={STROKE} aria-hidden />
        )}
        <Archive size={12} strokeWidth={STROKE} aria-hidden />
        Archivadas
        <span className="rooms-count">{rooms.length}</span>
      </button>
      {open ? (
        <ul id="rooms-archived-list" className="rooms-archived-list m-0 list-none">
          {rooms.map((r) =>
            confirmId === r.id ? (
              <li key={r.id} className="rooms-archived-confirm" role="alertdialog" aria-labelledby={`del-${r.id}`}>
                <span id={`del-${r.id}`} className="rooms-archived-confirm-text">
                  ¿Eliminar <strong>{r.title}</strong> para siempre? No vuelve a la oficina aunque su chat siga
                  trabajando. El chat en Claude Code y el historial de costos no se borran.
                </span>
                <span className="rooms-archived-confirm-actions">
                  <button type="button" className="btn btn--sm" onClick={() => setConfirmId(null)} autoFocus>
                    Cancelar
                  </button>
                  <button type="button" className="btn btn--sm btn--danger" onClick={() => void remove(r.id)}>
                    <Trash2 size={12} strokeWidth={STROKE} aria-hidden />
                    Eliminar
                  </button>
                </span>
              </li>
            ) : (
              <li key={r.id} className="rooms-archived-item">
                <span className="min-w-0 flex-1">
                  <span className="rooms-archived-title">{r.title}</span>
                  <span className="rooms-archived-sub">
                    {r.projectName !== r.title ? `${r.projectName} · ` : ''}
                    {r.open ? 'abierta' : 'cerrada'}
                  </span>
                </span>
                <IconButton label={`Restaurar ${r.title}`} onClick={() => void restore(r.id)}>
                  <ArchiveRestore size={14} strokeWidth={STROKE} />
                </IconButton>
                <IconButton
                  label={`Eliminar ${r.title} para siempre`}
                  className="rooms-archived-delete"
                  onClick={() => setConfirmId(r.id)}
                >
                  <Trash2 size={14} strokeWidth={STROKE} />
                </IconButton>
              </li>
            ),
          )}
        </ul>
      ) : null}
      {error ? (
        <span className="room-tools-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function RenameForm({ room, onDone }: { room: OfficeRoom; onDone: () => void }) {
  const [name, setName] = useState(room.customName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const auto = room.autoTitle ?? room.title;

  const save = async (value: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await renameRoom(room.id, value);
      onDone();
    } catch (err) {
      setError(describeApiError(err));
      setSaving(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void save(name.trim() || null);
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    // cancela sin cerrar el panel del agente ni otra capa
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    onDone();
  };

  return (
    <form className="room-rename" onSubmit={onSubmit}>
      <label htmlFor={`rename-${room.id}`} className="label">
        Nombre de la sala
      </label>
      <input
        id={`rename-${room.id}`}
        className="room-rename-input"
        value={name}
        maxLength={ROOM_NAME_MAX}
        placeholder={auto}
        autoFocus
        autoComplete="off"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKey}
        disabled={saving}
      />
      <span className="room-rename-hint">
        Vacío = nombre automático ({auto}). Solo cambia esta sala.
      </span>
      {error ? (
        <span className="room-rename-error" role="alert">
          {error}
        </span>
      ) : null}
      <span className="room-rename-actions">
        {room.customName ? (
          <button type="button" className="btn btn--sm" onClick={() => void save(null)} disabled={saving}>
            <RotateCcw size={12} strokeWidth={STROKE} aria-hidden />
            Automático
          </button>
        ) : null}
        <button type="button" className="btn btn--sm" onClick={onDone} disabled={saving}>
          Cancelar
        </button>
        <button type="submit" className="btn btn--sm btn--primary" disabled={saving}>
          Guardar
        </button>
      </span>
    </form>
  );
}


function RoomsRail({ className, onToggle, edgeRef }: { className: string; onToggle: () => void; edgeRef: EdgeRef }) {
  const snapshot = useOfficeStore((s) => s.snapshot);
  const currentId = useCurrentRoomId();
  const panelRoomId = useOfficeStore((s) => s.selectedRoomId);
  const now = useNow(30_000, 'local');
  const rooms = roomsBySlot(snapshot?.rooms ?? []);
  return (
    <nav id="room-list" ref={edgeRef} aria-label="Salas" className={`hud-rooms hud-rooms--rail win ${className}`}>
      <div className="win-head scanline">
        <IconButton label="Mostrar salas (Tab)" onClick={onToggle} aria-controls="room-list" aria-expanded={false}>
          <PanelLeftOpen size={16} strokeWidth={STROKE} />
        </IconButton>
      </div>
      <ul className="rail-list m-0 list-none">
        {rooms.map((room, i) => (
          <RailTile
            key={room.id}
            room={room}
            identity={roomIdentity(room, i)}
            now={now}
            here={snapshot?.leadRoomId === room.id}
            current={room.id === currentId}
            panelOpen={room.id === panelRoomId}
          />
        ))}
      </ul>
    </nav>
  );
}

/** Riel: el numero de la sala sobre su color, cuantos trabajan y marcas de esquina (aqui, flujo, alerta) */
function RailTile({
  room,
  identity,
  now,
  here,
  current,
  panelOpen,
}: {
  room: OfficeRoom;
  identity: RoomIdentity;
  now: number;
  here: boolean;
  current: boolean;
  panelOpen: boolean;
}) {
  const { hovered, handlers } = useRoomHover(room.id);
  const working = roomStats(room).working;
  const flow = roomFlowText(room);
  const state = roomState(room, now);
  const alert = roomAlert(room);
  const cls = [
    'rail-tile',
    `rail-tile--${state}`,
    current ? 'is-current' : '',
    hovered ? 'is-hovered' : '',
    alert ? `is-alerted is-${alert.alert.level}` : '',
  ];
  const status = roomStatusText(room, now);
  const alertText = alert ? `${alert.agentName ? `${alert.agentName}: ` : ''}${alert.alert.title}` : '';
  return (
    <li>
      <button
        type="button"
        className={cls.filter(Boolean).join(' ')}
        style={{ '--room': identity.accent } as CSSProperties}
        title={`Sala ${identity.number} · ${room.title} · ${status}${flow ? ` · flujo: ${flow.text}` : ''}${
          alert ? ` · ${alertText}` : ''
        }`}
        aria-label={`Sala ${identity.number}, ${room.title}, ${status}${flow ? `, flujo en curso: ${flow.text}` : ''}${
          here ? `, ${room.lead.displayName} está aquí` : ''
        }${alert ? `, ${ALERT_LEVEL_LABEL[alert.alert.level].toLowerCase()}: ${alertText}` : ''}`}
        aria-current={current ? 'true' : undefined}
        aria-pressed={panelOpen}
        onClick={() => toggleRoomPanel(room.id)}
        {...handlers}
      >
        <span aria-hidden>{identity.label}</span>
        {working > 0 ? (
          <span className="rail-badge" aria-hidden>
            {working}
          </span>
        ) : null}
        {here ? <span className="rail-here" aria-hidden /> : null}
        {flow ? <span className="rail-flow" aria-hidden /> : null}
        {alert ? <span className="rail-alert" aria-hidden /> : null}
      </button>
    </li>
  );
}
