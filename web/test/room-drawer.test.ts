// Panel derecho de la sala: se abre con un clic en la sala, comparte el lado derecho con el
// panel del agente y Esc lo cierra. Datos sinteticos; sin JSX: el archivo es .ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OfficeAgent, OfficeRoom, OfficeSnapshot, TokenBreakdown, WorkflowAgentRef, WorkflowRun } from '@shared/contract';
import { FlowsDock } from '@/hud/FlowsDock';
import { useHudHotkeys } from '@/hud/Hud';
import { RoomDrawer } from '@/hud/RoomDrawer';
import { nextRoomId, RoomList } from '@/hud/RoomList';
import { ROOM_ACCENTS } from '@/lib/roomIdentity';
import { escapeTarget, openFlowRoom, roomFlowRun, toggleFlowRoom } from '@/lib/workflows';
import { drawerOpen, useOfficeStore } from '@/state/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom no implementa scrollIntoView (la lista lleva a la vista la sala resaltada)
if (typeof Element.prototype.scrollIntoView !== 'function') Element.prototype.scrollIntoView = () => {};

const tokens = (total = 0): TokenBreakdown => ({ input: 0, output: total, cacheRead: 0, cacheWrite: 0, total });

function agent(id: string, partial: Partial<OfficeAgent> = {}): OfficeAgent {
  return {
    id,
    kind: 'subagent',
    agentType: 'tr-builder',
    displayName: id,
    status: 'working',
    task: null,
    action: null,
    model: 'claude-opus-5-5',
    tokens: tokens(),
    costUsd: 0,
    deskIndex: 6,
    ...partial,
  };
}

function room(id: string, title: string, partial: Partial<OfficeRoom> = {}): OfficeRoom {
  return {
    id,
    projectName: 'proyecto-prueba',
    title,
    cwd: '/tmp/proyecto-prueba',
    open: true,
    busy: false,
    lastActivityAt: '2026-09-28T19:59:00Z',
    lead: agent(id, { kind: 'lead', agentType: 'lead', displayName: 'Ana', deskIndex: 0, status: 'idle' }),
    subagents: [],
    tokens: tokens(1200),
    costUsd: 0.5,
    ...partial,
  };
}

function office(): OfficeSnapshot {
  return {
    generatedAt: '2026-09-28T20:00:00Z',
    leadRoomId: 'sala-1',
    rooms: [
      room('sala-1', 'Fase 2', { busy: true, subagents: [agent('ag-1', { displayName: 'Bruno' })], gitBranch: 'main', slot: 0 }),
      room('sala-2', 'Notas', { slot: 1 }),
    ],
    today: { costUsd: 0, tokens: tokens() },
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(element: ReactElement): HTMLDivElement {
  const div = document.createElement('div');
  document.body.appendChild(div);
  const r = createRoot(div);
  act(() => r.render(element));
  root = r;
  host = div;
  return div;
}

const click = (el: Element | null | undefined) =>
  act(() => {
    if (!el) throw new Error('sin elemento');
    (el as HTMLElement).click();
  });

beforeEach(() => {
  useOfficeStore.setState({
    snapshot: office(),
    demo: true,
    selectedAgentId: null,
    selectedRoomId: null,
    hoveredAgentId: null,
    hoveredRoomId: null,
    showSpend: false,
    focus: null,
    historyOpen: false,
    notesRoomId: null,
    roomListOpen: true,
    flowsDock: 'auto',
    flowsRunId: null,
    lastLayer: null,
  });
});

afterEach(() => {
  const r = root;
  if (r) act(() => r.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('seleccion del panel derecho', () => {
  it('sala y agente se excluyen: abrir uno cierra el otro; closeDrawer cierra cualquiera', () => {
    const s = () => useOfficeStore.getState();
    act(() => s().selectRoom('sala-1'));
    expect(s()).toMatchObject({ selectedRoomId: 'sala-1', selectedAgentId: null, lastLayer: 'drawer' });
    act(() => s().selectAgent('ag-1'));
    expect(s()).toMatchObject({ selectedRoomId: null, selectedAgentId: 'ag-1' });
    act(() => s().selectRoom('sala-2'));
    expect(s()).toMatchObject({ selectedRoomId: 'sala-2', selectedAgentId: null });
    expect(drawerOpen(s())).toBe(true);
    act(() => s().closeDrawer());
    expect(drawerOpen(s())).toBe(false);
  });

  it('Esc cierra el panel de la sala; con Flujos abierto encima, primero Flujos', () => {
    expect(escapeTarget({ historyOpen: false, drawerOpen: true, dockOpen: false, lastLayer: 'drawer' })).toBe('drawer');
    expect(escapeTarget({ historyOpen: false, drawerOpen: true, dockOpen: true, lastLayer: 'flows' })).toBe('flows');
    function Hotkeys() {
      useHudHotkeys();
      return null;
    }
    render(createElement(Hotkeys));
    act(() => useOfficeStore.getState().selectRoom('sala-1'));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(useOfficeStore.getState().selectedRoomId).toBeNull();
  });
});

describe('panel de la sala', () => {
  it('muestra nombre, rama, estado, quien esta y herramientas', () => {
    act(() => useOfficeStore.getState().selectRoom('sala-1'));
    const view = render(createElement(RoomDrawer));
    const panel = view.querySelector('aside.hud-drawer');
    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.getAttribute('aria-modal')).toBe('false');
    expect(panel?.querySelector('h2')?.textContent).toBe('Fase 2');
    const text = panel?.textContent ?? '';
    expect(text).toContain('proyecto-prueba');
    expect(text).toContain('main');
    expect(text).toContain('Trabajando');
    expect(text).toContain('1 de 2 trabajando');
    expect(text).toContain('Renombrar');
    expect(text).toContain('Notas');
    // el lider va primero, marcado, y dice que Ana esta aqui (leadRoomId)
    const faces = Array.from(panel?.querySelectorAll('button.rd-face') ?? []);
    expect(faces.map((f) => f.textContent)).toEqual(['Ana', 'Bruno']);
    expect(faces[0]?.className).toContain('is-lead');
    expect(faces[0]?.getAttribute('aria-label')).toContain('está aquí');
    expect(faces[0]?.querySelector('.rd-face-here')).not.toBeNull();
    expect(faces[1]?.querySelector('.rd-face-led')).not.toBeNull();
    // la linea de abajo cuenta al que trabaja (sin tarea: su actividad), nunca un prompt
    expect(panel?.querySelector('.rd-doing')?.textContent).toContain('Bruno');
  });

  it('la cabecera lleva el numero y el color de la sala (roomIdentity)', () => {
    act(() => useOfficeStore.getState().selectRoom('sala-2'));
    const view = render(createElement(RoomDrawer));
    const panel = view.querySelector<HTMLElement>('aside.hud-drawer');
    expect(panel?.querySelector('.rd-num')?.textContent).toBe('02');
    expect(panel?.style.getPropertyValue('--room')).toBe(ROOM_ACCENTS[1]);
    // el nombre accesible del panel incluye "Sala 2" sin repetirlo en pantalla
    const labelIds = (panel?.getAttribute('aria-labelledby') ?? '').split(' ');
    expect(labelIds.map((id) => document.getElementById(id)?.textContent)).toEqual(['Sala 2', 'Notas']);
    expect(panel?.querySelector('h2')?.textContent).toBe('Notas');
  });

  it('el gasto sale oculto hasta "Mostrar gasto" y se recuerda al volver a abrir el panel', () => {
    act(() => useOfficeStore.getState().selectRoom('sala-1'));
    const view = render(createElement(RoomDrawer));
    const toggle = () =>
      Array.from(view.querySelectorAll('.rd-spend button')).find((b) => /(Mostrar|Ocultar) gasto/.test(b.textContent ?? ''));
    expect(view.querySelector('.tok-grid')).toBeNull();
    expect(view.textContent).not.toContain('$');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    click(toggle());
    expect(view.querySelector('.tok-grid')).not.toBeNull();
    expect(toggle()?.textContent).toContain('Ocultar gasto');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    // cerrar y volver a abrir el panel: sigue a la vista hasta ocultarlo
    act(() => useOfficeStore.getState().closeDrawer());
    act(() => useOfficeStore.getState().selectRoom('sala-2'));
    act(() => useOfficeStore.getState().selectRoom('sala-1'));
    expect(view.querySelector('.tok-grid')).not.toBeNull();
    click(toggle());
    expect(view.querySelector('.tok-grid')).toBeNull();
    expect(useOfficeStore.getState().showSpend).toBe(false);
  });

  it('clic en una cara abre el panel de ese agente; pasar el puntero lo resalta en la escena', () => {
    act(() => useOfficeStore.getState().selectRoom('sala-1'));
    const view = render(createElement(RoomDrawer));
    const bruno = Array.from(view.querySelectorAll('button.rd-face')).find((b) => b.textContent === 'Bruno');
    act(() => (bruno as HTMLElement | undefined)?.focus());
    expect(useOfficeStore.getState().hoveredAgentId).toBe('ag-1');
    click(bruno);
    expect(useOfficeStore.getState()).toMatchObject({ selectedAgentId: 'ag-1', selectedRoomId: null });
  });

  it('una sala que sale del snapshot (archivada) no deja el panel abierto', () => {
    act(() => useOfficeStore.getState().selectRoom('sala-2'));
    const view = render(createElement(RoomDrawer));
    expect(view.querySelector('aside.hud-drawer h2')?.textContent).toBe('Notas');
    const snap = office();
    act(() => useOfficeStore.getState().setSnapshot({ ...snap, rooms: snap.rooms.slice(0, 1) }));
    // sale con la animacion de cierre
    expect(view.querySelector('aside.hud-drawer')?.className ?? 'is-leaving').toContain('is-leaving');
  });
});

function flowRun(runId: string, partial: Partial<WorkflowRun> = {}): WorkflowRun {
  const ref = (agentId: string, displayName: string, phase: string, status: WorkflowAgentRef['status']): WorkflowAgentRef => ({
    agentId,
    label: `tarea-${agentId}`,
    phase,
    displayName,
    agentType: 'workflow-subagent',
    status,
    model: 'claude-opus-5-5',
    tokens: tokens(),
    costUsd: 0,
    startedAt: '2026-09-28T19:50:00Z',
    endedAt: status === 'working' ? null : '2026-09-28T19:55:00Z',
  });
  return {
    runId,
    name: 'revision-falsa',
    description: '',
    status: 'running',
    startedAt: '2026-09-28T19:50:00Z',
    endedAt: null,
    phases: [
      { title: 'Explorar', status: 'done', agentsStarted: 1, agentsDone: 1 },
      { title: 'Construir', status: 'running', agentsStarted: 1, agentsDone: 0 },
      { title: 'Revisar', status: 'pending', agentsStarted: 0, agentsDone: 0 },
    ],
    agents: [ref('wf-1', 'Elena', 'Explorar', 'done'), ref('wf-2', 'Iris', 'Construir', 'working')],
    tokens: tokens(),
    costUsd: 0,
    ...partial,
  };
}

function officeWithFlow(): OfficeSnapshot {
  const snap = office();
  const [first, second] = snap.rooms;
  if (!first || !second) throw new Error('faltan salas');
  const finished = flowRun('wf-viejo', { name: 'flujo-de-la-manana', status: 'done', endedAt: '2026-09-28T12:00:00Z' });
  return { ...snap, rooms: [first, { ...second, workflows: [finished, flowRun('wf-vivo')] }] };
}

describe('el flujo vive en su sala', () => {
  it('la sala cuenta su flujo en curso: que pasa ahora y las fases con quien trabaja', () => {
    act(() => useOfficeStore.setState({ snapshot: officeWithFlow() }));
    act(() => useOfficeStore.getState().selectRoom('sala-2'));
    const view = render(createElement(RoomDrawer));
    const flow = view.querySelector('section.rf');
    expect(flow?.querySelector('.rf-name')?.textContent).toBe('Revision falsa');
    expect(flow?.querySelector('.rf-headline')?.textContent).toBe('Fase 2 de 3 · Construir');
    expect(flow?.querySelector('.rf-detail')?.textContent).toContain('Iris está trabajando');
    const steps = Array.from(flow?.querySelectorAll('.rf-step') ?? []);
    expect(steps.map((s) => s.className.match(/is-(done|running|pending|failed)/)?.[1])).toEqual(['done', 'running', 'pending']);
    // la fase terminada va plegada mientras el flujo corre; la actual muestra a Iris; la siguiente dice "Sigue"
    expect(steps[0]?.querySelector('.rf-agents')).toBeNull();
    expect(steps[1]?.textContent).toContain('Iris');
    expect(steps[2]?.textContent).toContain('Sigue');
    // el flujo terminado de la mañana queda abajo y se puede contar arriba
    const other = flow?.querySelector('.rf-other');
    expect(other?.textContent).toContain('Flujo de la manana');
    click(other);
    expect(view.querySelector('.rf-name')?.textContent).toBe('Flujo de la manana');
    // "Ver detalle" abre la vista grande en esa corrida
    click(Array.from(view.querySelectorAll('button')).find((b) => b.textContent?.includes('Ver detalle')));
    expect(useOfficeStore.getState()).toMatchObject({ flowsDock: 'open', flowsRunId: 'wf-viejo' });
  });

  it('F y las fichas llevan a la sala del flujo; F otra vez cierra su panel', () => {
    act(() => useOfficeStore.setState({ snapshot: officeWithFlow(), flowsRunId: null }));
    expect(roomFlowRun(officeWithFlow().rooms[1] as OfficeRoom, null)?.runId).toBe('wf-vivo');
    act(() => toggleFlowRoom());
    expect(useOfficeStore.getState()).toMatchObject({ selectedRoomId: 'sala-2', focus: { roomId: 'sala-2' } });
    act(() => toggleFlowRoom());
    expect(useOfficeStore.getState().selectedRoomId).toBeNull();
    // con la vista grande abierta, ir a la sala la cierra
    act(() => useOfficeStore.getState().setFlowsDock('open'));
    expect(openFlowRoom('wf-viejo')).toBe(true);
    expect(useOfficeStore.getState()).toMatchObject({ selectedRoomId: 'sala-2', flowsRunId: 'wf-viejo', flowsDock: 'bar' });
    expect(openFlowRoom('no-existe')).toBe(false);
  });

  it('la barra de abajo: una ficha por flujo en curso con su sala y que pasa ahora', () => {
    act(() => useOfficeStore.setState({ snapshot: officeWithFlow(), flowsDock: 'auto' }));
    const view = render(createElement(FlowsDock));
    const tickets = Array.from(view.querySelectorAll('button.fx-ticket'));
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.textContent).toContain('Notas');
    expect(tickets[0]?.textContent).toContain('Fase 2 de 3 · Construir');
    click(tickets[0]);
    expect(useOfficeStore.getState().selectedRoomId).toBe('sala-2');
  });
});

describe('lista de salas', () => {
  it('clic en una sala lleva la camara y abre su panel; otro clic lo cierra', () => {
    const view = render(createElement(RoomList));
    const button = Array.from(view.querySelectorAll('button.room')).find((b) => b.textContent?.includes('Notas'));
    click(button);
    expect(useOfficeStore.getState()).toMatchObject({ selectedRoomId: 'sala-2', focus: { roomId: 'sala-2' } });
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    // los agentes y las herramientas ya no se despliegan en la lista: van en el panel
    expect(view.querySelector('.room-agents')).toBeNull();
    expect(view.querySelector('.room-tools')).toBeNull();
    click(button);
    expect(useOfficeStore.getState().selectedRoomId).toBeNull();
  });

  it('con la lista desplegada, las flechas pasan de sala y dan la vuelta; plegada, no hacen nada', () => {
    expect(nextRoomId(['a', 'b', 'c'], null, 1)).toBe('a');
    expect(nextRoomId(['a', 'b', 'c'], null, -1)).toBe('c');
    expect(nextRoomId(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(nextRoomId(['a', 'b', 'c'], 'a', -1)).toBe('c');
    expect(nextRoomId([], 'a', 1)).toBeNull();
    function Hotkeys() {
      useHudHotkeys();
      return null;
    }
    render(createElement(Hotkeys));
    const press = (key: string) =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    press('ArrowDown');
    expect(useOfficeStore.getState()).toMatchObject({ selectedRoomId: 'sala-1', focus: { roomId: 'sala-1' } });
    press('ArrowRight');
    expect(useOfficeStore.getState().selectedRoomId).toBe('sala-2');
    press('ArrowDown');
    expect(useOfficeStore.getState().selectedRoomId).toBe('sala-1');
    press('ArrowUp');
    expect(useOfficeStore.getState().selectedRoomId).toBe('sala-2');
    act(() => useOfficeStore.setState({ roomListOpen: false }));
    press('ArrowDown');
    expect(useOfficeStore.getState().selectedRoomId).toBe('sala-2');
  });

  const items = (view: HTMLElement) => Array.from(view.querySelectorAll<HTMLLIElement>('li.room-item'));
  const itemOf = (view: HTMLElement, title: string) => items(view).find((li) => li.textContent?.includes(title));

  it('ficha con poco texto: numero y color de la sala, caras, sin costo ni tokens; la inactiva queda en una linea', () => {
    const view = render(createElement(RoomList));
    const busy = itemOf(view, 'Fase 2');
    const quiet = itemOf(view, 'Notas');
    expect(busy?.querySelector('.room-num')?.textContent).toBe('01');
    expect(quiet?.querySelector('.room-num')?.textContent).toBe('02');
    expect(busy?.style.getPropertyValue('--room')).toBe(ROOM_ACCENTS[0]);
    expect(quiet?.style.getPropertyValue('--room')).toBe(ROOM_ACCENTS[1]);
    // las caras: primero quien trabaja
    const faces = Array.from(busy?.querySelectorAll('.room-face') ?? []);
    expect(faces.map((f) => f.getAttribute('title'))).toEqual(['Bruno', 'Ana']);
    expect(faces[0]?.classList.contains('is-working')).toBe(true);
    expect(busy?.querySelector('.room-status')?.textContent).toBe('1 trabajando');
    // Ana esta en esta sala: un icono, con el nombre en el title
    expect(busy?.querySelector('.room-sig--here')?.getAttribute('title')).toBe('Ana está aquí');
    expect(busy?.classList.contains('is-compact')).toBe(false);
    expect(quiet?.classList.contains('is-compact')).toBe(true);
    expect(quiet?.querySelector('.room-faces')).toBeNull();
    const text = view.querySelector('.rooms-list')?.textContent ?? '';
    expect(text).not.toContain('$');
    expect(text).not.toContain('tok');
  });

  it('el puntero o el foco en una ficha resalta su sala; la sala resaltada desde la escena resalta su ficha', () => {
    const view = render(createElement(RoomList));
    const quiet = itemOf(view, 'Notas');
    act(() => {
      quiet?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    expect(useOfficeStore.getState().hoveredRoomId).toBe('sala-2');
    act(() => {
      quiet?.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(useOfficeStore.getState().hoveredRoomId).toBeNull();
    const button = quiet?.querySelector<HTMLButtonElement>('button.room');
    act(() => button?.focus());
    expect(useOfficeStore.getState().hoveredRoomId).toBe('sala-2');
    act(() => button?.blur());
    expect(useOfficeStore.getState().hoveredRoomId).toBeNull();
    act(() => useOfficeStore.getState().hoverRoom('sala-1'));
    expect(itemOf(view, 'Fase 2')?.classList.contains('is-hovered')).toBe(true);
    expect(itemOf(view, 'Notas')?.classList.contains('is-hovered')).toBe(false);
  });

  it('flujo en curso: chip compacto con la fase, que lleva al flujo en el panel de la sala', () => {
    act(() => useOfficeStore.setState({ snapshot: officeWithFlow() }));
    const view = render(createElement(RoomList));
    const item = itemOf(view, 'Notas');
    // un flujo en curso no deja la ficha en una linea
    expect(item?.classList.contains('is-compact')).toBe(false);
    const chip = item?.querySelector('button.room-flow');
    expect(chip?.textContent).toBe('2/3');
    expect(chip?.getAttribute('aria-label')).toContain('Revision falsa · Fase 2 de 3');
    click(chip);
    expect(useOfficeStore.getState()).toMatchObject({ selectedRoomId: 'sala-2', flowsRunId: 'wf-vivo' });
  });

  it('riel: numero de la sala, cuantos trabajan y aria-pressed con su panel abierto', () => {
    act(() => useOfficeStore.setState({ roomListOpen: false }));
    const view = render(createElement(RoomList));
    const tiles = Array.from(view.querySelectorAll('button.rail-tile'));
    expect(tiles.map((t) => t.firstElementChild?.textContent)).toEqual(['01', '02']);
    expect(tiles[0]?.querySelector('.rail-badge')?.textContent).toBe('1');
    click(tiles[1]);
    expect(useOfficeStore.getState().selectedRoomId).toBe('sala-2');
    expect(tiles[1]?.getAttribute('aria-pressed')).toBe('true');
  });
});
