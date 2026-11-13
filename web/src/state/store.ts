import { create } from 'zustand';
import type { HabitsResponse, OfficeAgent, OfficeRoom, OfficeSnapshot } from '@shared/contract';
import { shareEqual } from '@/lib/share';

export type ConnectionState = 'connecting' | 'live' | 'offline';
/** pestanas del historial; se agrupan en Gasto, Eficiencia y Reglas (HISTORY_GROUPS en HistoryModal) */
export type HistoryTab =
  | 'budget'
  | 'costs'
  | 'ranking'
  | 'tasks'
  | 'sessions'
  | 'habits'
  | 'compare'
  | 'simulator'
  | 'report'
  | 'rules'
  | 'prices'
  | 'system';

/** px de la ventana que tapa el HUD por cada lado; la camara encuadra la oficina en lo que queda libre */
export interface HudInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const NO_INSETS: HudInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Flujos. open: vista grande (sala de control), la abre el usuario con F o el boton · auto y bar: barra
 * compacta abajo mientras haya un flujo en curso, nada si no (ver dockMode en lib/workflows).
 */
export type FlowsDockPref = 'auto' | 'open' | 'bar';

/** capa que el usuario toco por ultima vez: decide que cierra Esc cuando hay dos abiertas */
export type HudLayer = 'drawer' | 'flows';

const FLOWS_BAR_KEY = 'oficina.flujos-plegado';

function readFlowsPref(): FlowsDockPref {
  try {
    if (typeof window === 'undefined') return 'auto';
    return window.localStorage.getItem(FLOWS_BAR_KEY) === '1' ? 'bar' : 'auto';
  } catch {
    return 'auto';
  }
}

/** solo se recuerda que lo plego; desplegado o cerrado vuelve a 'auto' en la proxima carga */
function writeFlowsPref(pref: FlowsDockPref): void {
  try {
    if (typeof window === 'undefined') return;
    if (pref === 'bar') window.localStorage.setItem(FLOWS_BAR_KEY, '1');
    else window.localStorage.removeItem(FLOWS_BAR_KEY);
  } catch {
    // sin almacenamiento local: la preferencia dura hasta recargar
  }
}

const SPEND_KEY = 'oficina.mostrar-gasto';

/**
 * "Mostrar gasto": una sola preferencia para el ranking, las tareas, los flujos, el panel de la sala y
 * "Agentes ahora", recordada en este navegador. Visible por defecto (el foco de la herramienta es el costo);
 * "Ocultar gasto" guarda '0' para cuando la pantalla se proyecta.
 */
export function readShowSpend(): boolean {
  try {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(SPEND_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeShowSpend(shown: boolean): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SPEND_KEY, shown ? '1' : '0');
  } catch {
    // sin almacenamiento local: la preferencia dura hasta recargar
  }
}

function prefersWideLayout(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(min-width: 768px)').matches;
}

interface OfficeState {
  snapshot: OfficeSnapshot | null;
  connection: ConnectionState;
  selectedAgentId: string | null;
  /** sala con su panel abierto a la derecha; excluye a selectedAgentId (comparten el mismo lado) */
  selectedRoomId: string | null;
  /** agente bajo el puntero en la escena 3D: su etiqueta se despliega completa */
  hoveredAgentId: string | null;
  /** sala bajo el puntero, en la lista o en la escena: las dos la resaltan a la vez */
  hoveredRoomId: string | null;
  /** sala a la que la camara debe viajar (lo pide el HUD, lo ejecuta la escena); nonce fuerza repetir */
  focus: { roomId: string; nonce: number } | null;
  /** reloj del servidor - reloj del cliente (ms); los timers usan Date.now() + clockOffsetMs */
  clockOffsetMs: number;
  /** ?demo=1: snapshot simulado en el cliente, sin servidor */
  demo: boolean;
  historyOpen: boolean;
  historyTab: HistoryTab;
  /** periodo con que abre Habitos cuando lo pide otra pestana (el Comparador); null = En vivo */
  habitsRange: HabitsResponse['range'] | null;
  /** sala con el modal de notas abierto */
  notesRoomId: string | null;
  openNotes: (roomId: string) => void;
  closeNotes: () => void;
  /** lista de salas desplegada (en pantallas angostas arranca plegada) */
  roomListOpen: boolean;
  /** cambia cuando el HUD pide reconectar ya, sin esperar el backoff */
  reconnectNonce: number;
  /** lo escribe el HUD al medir sus paneles; lo lee CameraRig */
  hudInsets: HudInsets;
  setHudInsets: (insets: HudInsets) => void;
  flowsDock: FlowsDockPref;
  /** corrida elegida en el dock; null (o una que ya no esta) = la primera, activas primero */
  flowsRunId: string | null;
  lastLayer: HudLayer | null;
  /** despliega el dock de Flujos, opcionalmente en una corrida */
  openFlows: (runId?: string | null) => void;
  setFlowsDock: (pref: FlowsDockPref) => void;
  selectFlowsRun: (runId: string) => void;
  setLastLayer: (layer: HudLayer) => void;
  setSnapshot: (snapshot: OfficeSnapshot) => void;
  setConnection: (connection: ConnectionState) => void;
  selectAgent: (id: string | null) => void;
  selectRoom: (id: string | null) => void;
  /** cierra el panel derecho, sea de agente o de sala */
  closeDrawer: () => void;
  /** null solo suelta si el puntero dejo a ese agente (from); asi salir de uno y entrar a otro no se pisa */
  hoverAgent: (id: string | null, from?: string) => void;
  /** igual que hoverAgent: null con from solo suelta si el puntero dejo esa sala */
  hoverRoom: (id: string | null, from?: string) => void;
  focusRoom: (roomId: string) => void;
  setDemo: (demo: boolean) => void;
  /** sin tab conserva la ultima pestana vista; habitsRange solo vale para abrir Habitos en ese periodo */
  openHistory: (tab?: HistoryTab, habitsRange?: HabitsResponse['range']) => void;
  closeHistory: () => void;
  setRoomListOpen: (open: boolean) => void;
  requestReconnect: () => void;
  /** tokens y USD a la vista en ranking, tareas, flujos y panel de la sala; se recuerda (readShowSpend) */
  showSpend: boolean;
  toggleSpend: () => void;
  /** mini tutorial del HUD (hud/onboarding/Tour) */
  tourOpen: boolean;
  /** cierra historial y notas: el tutorial resalta la barra de arriba y no debe quedar tapado */
  openTour: () => void;
  closeTour: () => void;
  /** dialogo para cambiar el nombre del lead; el del primer arranque lo abre el snapshot (leadName null) */
  nameEditOpen: boolean;
  openNameEdit: () => void;
  closeNameEdit: () => void;
  /** tabla "Agentes ahora" (hud/AgentsNowModal, tecla L) */
  agentsOpen: boolean;
  toggleAgents: () => void;
  closeAgents: () => void;
  /** lista de pendientes general (hud/TodoModal, tecla P) */
  todoOpen: boolean;
  toggleTodo: () => void;
  closeTodo: () => void;
}

export const useOfficeStore = create<OfficeState>((set) => ({
  snapshot: null,
  connection: 'connecting',
  selectedAgentId: null,
  selectedRoomId: null,
  hoveredAgentId: null,
  hoveredRoomId: null,
  focus: null,
  clockOffsetMs: 0,
  demo: false,
  historyOpen: false,
  historyTab: 'budget',
  habitsRange: null,
  notesRoomId: null,
  openNotes: (notesRoomId) => set({ notesRoomId, historyOpen: false, agentsOpen: false, todoOpen: false }),
  closeNotes: () => set({ notesRoomId: null }),
  roomListOpen: prefersWideLayout(),
  reconnectNonce: 0,
  hudInsets: NO_INSETS,
  setHudInsets: (next) =>
    set((s) => {
      const cur = s.hudInsets;
      const same = cur.top === next.top && cur.right === next.right && cur.bottom === next.bottom && cur.left === next.left;
      return same ? s : { hudInsets: next };
    }),
  flowsDock: readFlowsPref(),
  flowsRunId: null,
  lastLayer: null,
  openFlows: (runId) => {
    writeFlowsPref('open');
    set((s) => ({ flowsDock: 'open', flowsRunId: runId ?? s.flowsRunId, lastLayer: 'flows' }));
  },
  setFlowsDock: (flowsDock) => {
    writeFlowsPref(flowsDock);
    // al cerrar se olvida la corrida elegida: la vista vuelve a abrir en lo que esta en curso
    set(flowsDock === 'open' ? { flowsDock, lastLayer: 'flows' } : { flowsDock, flowsRunId: null });
  },
  selectFlowsRun: (flowsRunId) => set({ flowsRunId }),
  setLastLayer: (lastLayer) => set((s) => (s.lastLayer === lastLayer ? s : { lastLayer })),
  // lo que llega igual conserva su identidad (lib/share): salas, agentes y paneles quietos no se re-renderizan
  setSnapshot: (snapshot) =>
    set((s) => ({ snapshot: shareEqual(s.snapshot, snapshot), clockOffsetMs: Date.parse(snapshot.generatedAt) - Date.now() })),
  setConnection: (connection) => set({ connection }),
  selectAgent: (selectedAgentId) =>
    set(selectedAgentId ? { selectedAgentId, selectedRoomId: null, lastLayer: 'drawer' } : { selectedAgentId }),
  selectRoom: (selectedRoomId) =>
    set(selectedRoomId ? { selectedRoomId, selectedAgentId: null, lastLayer: 'drawer' } : { selectedRoomId }),
  closeDrawer: () => set({ selectedAgentId: null, selectedRoomId: null }),
  hoverAgent: (id, from) =>
    set((s) => {
      if (id === null && from !== undefined && s.hoveredAgentId !== from) return s;
      return s.hoveredAgentId === id ? s : { hoveredAgentId: id };
    }),
  hoverRoom: (id, from) =>
    set((s) => {
      if (id === null && from !== undefined && s.hoveredRoomId !== from) return s;
      return s.hoveredRoomId === id ? s : { hoveredRoomId: id };
    }),
  focusRoom: (roomId) => set((s) => ({ focus: { roomId, nonce: (s.focus?.nonce ?? 0) + 1 } })),
  setDemo: (demo) => set({ demo }),
  openHistory: (tab, habitsRange) =>
    set((s) => ({
      historyOpen: true,
      historyTab: tab ?? s.historyTab,
      habitsRange: habitsRange ?? null,
      notesRoomId: null,
      agentsOpen: false,
      todoOpen: false,
    })),
  closeHistory: () => set({ historyOpen: false }),
  setRoomListOpen: (roomListOpen) => set({ roomListOpen }),
  requestReconnect: () => set((s) => ({ reconnectNonce: s.reconnectNonce + 1 })),
  showSpend: readShowSpend(),
  toggleSpend: () =>
    set((s) => {
      writeShowSpend(!s.showSpend);
      return { showSpend: !s.showSpend };
    }),
  tourOpen: false,
  openTour: () =>
    set({ tourOpen: true, historyOpen: false, notesRoomId: null, nameEditOpen: false, agentsOpen: false, todoOpen: false }),
  closeTour: () => set({ tourOpen: false }),
  nameEditOpen: false,
  openNameEdit: () =>
    set({ nameEditOpen: true, historyOpen: false, notesRoomId: null, tourOpen: false, agentsOpen: false, todoOpen: false }),
  closeNameEdit: () => set({ nameEditOpen: false }),
  agentsOpen: false,
  toggleAgents: () =>
    set((s) =>
      s.agentsOpen ? { agentsOpen: false } : { agentsOpen: true, historyOpen: false, notesRoomId: null, todoOpen: false },
    ),
  closeAgents: () => set({ agentsOpen: false }),
  todoOpen: false,
  toggleTodo: () =>
    set((s) =>
      s.todoOpen ? { todoOpen: false } : { todoOpen: true, historyOpen: false, notesRoomId: null, agentsOpen: false },
    ),
  closeTodo: () => set({ todoOpen: false }),
}));

/** hay un panel a la derecha (agente o sala) */
export function drawerOpen(s: Pick<OfficeState, 'selectedAgentId' | 'selectedRoomId'>): boolean {
  return s.selectedAgentId !== null || s.selectedRoomId !== null;
}

export function serverNow(): number {
  return Date.now() + useOfficeStore.getState().clockOffsetMs;
}

export function findAgent(
  snapshot: OfficeSnapshot | null,
  agentId: string | null,
): { room: OfficeRoom; agent: OfficeAgent } | null {
  if (!snapshot || !agentId) return null;
  for (const room of snapshot.rooms) {
    if (room.lead.id === agentId) return { room, agent: room.lead };
    const sub = room.subagents.find((a) => a.id === agentId);
    if (sub) return { room, agent: sub };
  }
  return null;
}
