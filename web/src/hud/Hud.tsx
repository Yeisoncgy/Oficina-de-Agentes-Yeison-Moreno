import { useEffect, useState } from 'react';
import { Moon, MousePointerClick, RefreshCw, WifiOff, X } from 'lucide-react';
import { APP_CREDIT, APP_NAME, tabTitle } from '@/lib/brand';
import { formatTimeOfDay } from '@/lib/format';
import { workingAgentsCount } from '@/lib/office';
import {
  activeRunCount,
  dockMode,
  escapeTarget,
  letterAction,
  prefAfterClose,
  toggleFlowRoom,
} from '@/lib/workflows';
import { drawerOpen, useOfficeStore } from '@/state/store';
import { AgentDrawer } from './AgentDrawer';
import { AgentsNowModal } from './AgentsNowModal';
import { FlowsDock } from './FlowsDock';
import { HistoryModal } from './HistoryModal';
import { useHudEdge, useHudInsetsRoot } from './hudInsets';
import { NotesModal } from './NotesModal';
import { useFirstRead } from './onboarding/firstRead';
import { FirstReadCard } from './onboarding/FirstReadCard';
import { Onboarding, useNeedsLeadName } from './onboarding/Onboarding';
import { HINT_KEY, readFlag, readTourSeen } from './onboarding/seen';
import { FlyingBee, HiveLoader } from './PixelArt';
import { IconButton, STROKE } from './primitives';
import { RoomDrawer } from './RoomDrawer';
import { RoomList, roomListIsOpen, stepRoom, toggleRoomList } from './RoomList';
import { TodoModal } from './TodoModal';
import { BrandCorner } from './BrandCorner';
import { PerfBadge } from './PerfBadge';
import { BudgetBanner } from './extras/BudgetBanner';
import { LiteView } from './extras/LiteView';
import { TopBar } from './TopBar';
import { useAlertNotifications } from './useAlertNotifications';
// alertas, identidad, habitos y tira de Flujos; va despues de index.css (main.tsx lo importa primero)
import './live.css';

/**
 * Capa 2D sobre la escena (D3). La raiz no recibe punteros (la camara sigue libre); solo los paneles
 * los activan. Medidas por pantalla en .hud (index.css). Cada panel publica el borde que tapa y la raiz
 * se lo pasa a la camara (hudInsets).
 */
export function Hud({ lite = false }: { lite?: boolean }) {
  useHudHotkeys();
  useDocumentTitle();
  useAlertNotifications();
  const rootRef = useHudInsetsRoot();

  if (lite) {
    // vista ligera (?lite=1): las barras, los paneles y los modales, sin la escena ni lo que vive sobre ella
    return (
      <div className="hud" ref={rootRef}>
        <LiteView />
        <TopBar />
        <AgentDrawer />
        <RoomDrawer />
        <BudgetBanner />
        <HistoryModal />
        <NotesModal />
        <AgentsNowModal />
        <TodoModal />
      </div>
    );
  }

  return (
    <div className="hud" ref={rootRef}>
      <TopBar />
      <RoomList />
      <BrandCorner />
      <PerfBadge />
      <FlowsDock />
      <AgentDrawer />
      <RoomDrawer />
      <CenterState />
      <BudgetBanner />
      <Hint />
      <HistoryModal />
      <NotesModal />
      <AgentsNowModal />
      <TodoModal />
      <Onboarding />
    </div>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** solo los modales se quedan con Tab; el panel del agente es un dialogo no modal y no cuenta */
function inModal(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && target.closest('[role="dialog"][aria-modal="true"], [role="alertdialog"]') !== null
  );
}

const ARROW_STEP: Readonly<Record<string, 1 | -1>> = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 };

/**
 * Esc cierra la capa de arriba (historial; luego, entre el dock de Flujos y el panel del agente, el
 * ultimo que se toco) · H abre/cierra el historial · A lo abre en Habitos · F abre o cierra la vista
 * grande de Flujos · L abre o cierra "Agentes ahora" · Tab despliega o pliega la lista de salas · con la lista desplegada, las flechas
 * pasan de sala
 */
export function useHudHotkeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const state = useOfficeStore.getState();
      const hasActive = activeRunCount(state.snapshot) > 0;
      if (event.key === 'Escape') {
        if (state.todoOpen) {
          state.closeTodo();
          event.preventDefault();
          return;
        }
        if (state.agentsOpen) {
          state.closeAgents();
          event.preventDefault();
          return;
        }
        if (state.notesRoomId !== null) {
          state.closeNotes();
          event.preventDefault();
          return;
        }
        const target = escapeTarget({
          historyOpen: state.historyOpen,
          drawerOpen: drawerOpen(state),
          dockOpen: dockMode(state.flowsDock, hasActive) === 'open',
          lastLayer: state.lastLayer,
        });
        if (target === 'history') state.closeHistory();
        else if (target === 'flows') state.setFlowsDock(prefAfterClose(hasActive));
        else if (target === 'drawer') state.closeDrawer();
        else return;
        event.preventDefault();
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) return;
      // Tab es de la lista de salas; Shift+Tab sigue moviendo el foco, y dentro de un modal Tab tambien
      if (event.key === 'Tab') {
        if (event.shiftKey || state.historyOpen || state.notesRoomId !== null || state.todoOpen || inModal(event.target)) return;
        event.preventDefault();
        toggleRoomList(window.innerWidth);
        return;
      }
      // con la lista desplegada, las flechas pasan de sala (arriba/izquierda = anterior, abajo/derecha = siguiente)
      const step = ARROW_STEP[event.key];
      if (step !== undefined) {
        if (state.historyOpen || state.notesRoomId !== null || state.todoOpen || state.tourOpen || inModal(event.target)) return;
        if (!roomListIsOpen(window.innerWidth)) return;
        if (stepRoom(step)) event.preventDefault();
        return;
      }
      // dejar presionada H o A no debe abrir y cerrar el historial en cada repeticion
      if (event.repeat) return;
      const action = letterAction(event.key, state);
      if (!action) return;
      // con notas o guia encima la tabla no abre
      if (action === 'toggle-agents' && (state.notesRoomId !== null || state.tourOpen)) return;
      // los pendientes tampoco abren sobre las notas de una sala ni sobre la guia
      if (action === 'toggle-todo' && (state.notesRoomId !== null || state.tourOpen)) return;
      event.preventDefault();
      if (action === 'toggle-agents') state.toggleAgents();
      else if (action === 'toggle-todo') state.toggleTodo();
      else if (action === 'close-history') state.closeHistory();
      else if (action === 'open-history') state.openHistory();
      else if (action === 'open-habits') state.openHistory('habits');
      else toggleFlowRoom();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

function useDocumentTitle(): void {
  const working = useOfficeStore((s) => workingAgentsCount(s.snapshot));
  useEffect(() => {
    document.title = tabTitle(working);
  }, [working]);
}

/** Estados de pantalla completa (D3 E1-E3): cargando, sin conexion, primera lectura y oficina vacia */
function CenterState() {
  const snapshot = useOfficeStore((s) => s.snapshot);
  const connection = useOfficeStore((s) => s.connection);
  const demo = useOfficeStore((s) => s.demo);
  const covered = useOfficeStore((s) => s.historyOpen || drawerOpen(s));
  const requestReconnect = useOfficeStore((s) => s.requestReconnect);
  const reading = useFirstRead(!demo);

  if (!demo && connection === 'offline') {
    return (
      <div className="center-card is-error" role="alert">
        <WifiOff size={24} strokeWidth={STROKE} aria-hidden className="center-card-icon" />
        <h3 className="center-card-title display">Sin conexión</h3>
        <p className="center-card-text">
          {snapshot ? (
            <>
              No llegan datos del servidor de la oficina desde las {formatTimeOfDay(snapshot.generatedAt)}. La escena
              muestra el último estado conocido.
            </>
          ) : (
            <>
              El servidor de la oficina no responde. ¿Está corriendo <code>npm run dev</code>? Se reconecta solo en
              cuanto responda.
            </>
          )}
        </p>
        <div className="center-card-actions">
          <button type="button" className="btn btn--primary" onClick={requestReconnect}>
            <RefreshCw size={14} strokeWidth={STROKE} aria-hidden />
            Reintentar
          </button>
          <a className="link" href="?demo=1">
            Abrir el modo demo
          </a>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="center-card boot-card" role="status" aria-label={`Cargando ${APP_NAME}`}>
        <FlyingBee />
        <h3 className="center-card-title display">Despertando la colmena…</h3>
        <HiveLoader />
        <span className="brand-credit">{APP_CREDIT}</span>
      </div>
    );
  }

  const allClosed = snapshot.rooms.length > 0 && snapshot.rooms.every((r) => !r.open);
  if (covered || (snapshot.rooms.length > 0 && !allClosed)) return null;
  // mientras el server lee el historial, "sin agentes" diria algo que todavia no se sabe
  if (reading) return <FirstReadCard view={reading} />;
  return (
    <div className="center-card" role="status">
      <Moon size={24} strokeWidth={STROKE} aria-hidden className="center-card-icon" />
      <h3 className="center-card-title display">
        {snapshot.rooms.length === 0 ? 'Sin agentes trabajando hoy' : 'Sin agentes trabajando ahora'}
      </h3>
      <p className="center-card-text">
        {snapshot.rooms.length === 0
          ? 'Cuando un agente empiece una tarea, se enciende su pantalla y aparece su tarjeta.'
          : 'Las sesiones de hoy ya cerraron. Cuando un agente empiece una tarea, se enciende su pantalla y aparece su tarjeta.'}
      </p>
    </div>
  );
}

const readHintDismissed = (): boolean => readFlag(HINT_KEY);

/**
 * Pista inicial (D3 E4): se ve hasta que el usuario la cierra o abre su primer agente. Comparte el borde
 * de abajo con el dock de Flujos: mientras el dock se ve, la pista espera. Tambien espera al nombre y a la
 * guia; la guia, al terminar u omitirse, la da por vista.
 */
function Hint() {
  const [dismissed, setDismissed] = useState(readHintDismissed);
  const hasRooms = useOfficeStore((s) => (s.snapshot?.rooms.length ?? 0) > 0);
  const dockShown = useOfficeStore((s) => dockMode(s.flowsDock, activeRunCount(s.snapshot) > 0) !== 'hidden');
  const needsName = useNeedsLeadName();
  const tourOpen = useOfficeStore((s) => s.tourOpen);
  // en el demo la guia arranca sola al rato: la pista no se asoma antes para irse enseguida
  const tourPending = useOfficeStore((s) => s.demo) && !readTourSeen();
  const busy =
    useOfficeStore((s) => drawerOpen(s) || s.historyOpen) || dockShown || needsName || tourOpen || tourPending;
  const selected = useOfficeStore((s) => s.selectedAgentId !== null);
  const shown = !dismissed && hasRooms && !busy;
  const edgeRef = useHudEdge('bottom', shown);

  useEffect(() => {
    if (!tourOpen) setDismissed((was) => was || readHintDismissed());
  }, [tourOpen]);

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(HINT_KEY, '1');
    } catch {
      // sin almacenamiento local: la pista vuelve en la proxima carga
    }
  };

  useEffect(() => {
    if (selected && !dismissed) dismiss();
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown) return null;
  return (
    <div className="hint" role="note" ref={edgeRef}>
      <MousePointerClick size={16} strokeWidth={STROKE} aria-hidden />
      <span>Haz clic en un agente para ver qué está haciendo</span>
      <IconButton label="Entendido" onClick={dismiss}>
        <X size={14} strokeWidth={STROKE} />
      </IconButton>
    </div>
  );
}
