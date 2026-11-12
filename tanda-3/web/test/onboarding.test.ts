// Bienvenida con el nombre del lead, guia del HUD y primera lectura. Lo puro sin DOM; los dialogos montados
// en jsdom (react-dom), sin JSX: el archivo es .ts. Datos sinteticos.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OfficeAgent, OfficeRoom, OfficeSnapshot, TokenBreakdown } from '@shared/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  FIRST_READ_ERROR_POLL_MS,
  FIRST_READ_POLL_MS,
  firstReadPollMs,
  firstReadView,
  useFirstRead,
  type HealthResponse,
} from '@/hud/onboarding/firstRead';
import { Onboarding } from '@/hud/onboarding/Onboarding';
import { HINT_KEY, TOUR_SEEN_KEY } from '@/hud/onboarding/seen';
import { Tour } from '@/hud/onboarding/Tour';
import { freeArea, placeCard, spotBox, unionBox } from '@/hud/onboarding/tourLayout';
import { pickTourAgent, tourSteps, type TourContext } from '@/hud/onboarding/tourSteps';
import { ChangeNameButton } from '@/hud/onboarding/Welcome';
import { useHudHotkeys } from '@/hud/Hud';
import { useOfficeStore } from '@/state/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tokens = (): TokenBreakdown => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function agent(id: string, partial: Partial<OfficeAgent> = {}): OfficeAgent {
  return {
    id,
    kind: 'subagent',
    agentType: 'Explore',
    displayName: id,
    status: 'idle',
    task: null,
    action: null,
    model: null,
    tokens: tokens(),
    costUsd: 0,
    deskIndex: 1,
    ...partial,
  };
}

function room(id: string, subagents: OfficeAgent[] = [], leadStatus: OfficeAgent['status'] = 'idle'): OfficeRoom {
  return {
    id,
    projectName: 'proyecto-prueba',
    title: 'proyecto-prueba',
    cwd: '/tmp/proyecto-prueba',
    open: true,
    busy: false,
    lastActivityAt: '2026-09-28T19:59:00Z',
    lead: agent(`${id}-lider`, { kind: 'lead', agentType: 'lead', displayName: 'Líder', deskIndex: 0, status: leadStatus }),
    subagents,
    tokens: tokens(),
    costUsd: 0,
  };
}

function office(partial: Partial<OfficeSnapshot> = {}): OfficeSnapshot {
  return {
    generatedAt: '2026-09-28T20:00:00Z',
    leadRoomId: null,
    rooms: [],
    today: { costUsd: 0, tokens: tokens() },
    ...partial,
  };
}

const ctx = (partial: Partial<TourContext> = {}): TourContext => ({
  name: 'Ana',
  demo: false,
  rooms: 2,
  agentId: 'ag-1',
  spotlight: true,
  ...partial,
});

describe('pasos de la guia', () => {
  it('nueve pasos en el orden del HUD (sin Historial: vive dentro de Hábitos)', () => {
    expect(tourSteps(ctx()).map((s) => s.id)).toEqual([
      'welcome',
      'connection',
      'spend',
      'rooms',
      'scene',
      'agent',
      'flows',
      'habits',
      'done',
    ]);
  });

  it('textos cortos: a lo sumo dos frases por paso', () => {
    for (const step of tourSteps(ctx())) expect(step.body.length).toBeLessThanOrEqual(2);
  });

  it('resalta cada zona y el primero va al centro', () => {
    const byId = new Map(tourSteps(ctx()).map((s) => [s.id, s]));
    expect(byId.get('welcome')?.target).toEqual({ kind: 'none' });
    expect(byId.get('connection')?.target).toEqual({ kind: 'element', selector: '.hud-bar--left' });
    expect(byId.get('rooms')?.target).toEqual({ kind: 'element', selector: '#room-list' });
    expect(byId.get('scene')?.target).toEqual({ kind: 'scene' });
    expect(byId.get('agent')?.target).toEqual({ kind: 'element', selector: '.hud-drawer' });
    expect(byId.get('flows')?.keys).toEqual(['F']);
    expect(byId.get('habits')?.keys).toEqual(['A']);
    expect(byId.get('rooms')?.keys).toEqual(['Tab']);
    // el boton Guia vive dentro de Hábitos (cerrado durante la guia): el cierre señala Hábitos
    expect(byId.get('done')?.target).toEqual({ kind: 'element', selector: '[data-tour="habits"]' });
  });

  it('con agentes, el paso del panel abre uno; sin salas lo explica sin abrir y ofrece el demo', () => {
    const withAgents = tourSteps(ctx()).find((s) => s.id === 'agent');
    expect(withAgents?.openAgentId).toBe('ag-1');
    expect(withAgents?.offerDemo).toBe(false);

    const empty = tourSteps(ctx({ rooms: 0, agentId: 'ag-1' }));
    const rooms = empty.find((s) => s.id === 'rooms');
    const panel = empty.find((s) => s.id === 'agent');
    expect(rooms?.offerDemo).toBe(true);
    expect(rooms?.body.join(' ')).toContain('Todavía no hay ninguna');
    expect(panel?.openAgentId).toBeNull();
    expect(panel?.target).toEqual({ kind: 'none' });
    expect(panel?.offerDemo).toBe(true);
    // en el demo ya son datos de ejemplo: no se ofrece otra vez
    expect(tourSteps(ctx({ rooms: 0, demo: true })).some((s) => s.offerDemo)).toBe(false);
  });

  it('usa el nombre del usuario donde tiene sentido, y sin nombre no deja huecos', () => {
    const steps = tourSteps(ctx({ name: 'Ana' }));
    expect(steps[0]?.body[0]).toMatch(/^Ana, esta es tu oficina/);
    expect(steps.find((s) => s.id === 'scene')?.body.join(' ')).toContain('Tú eres Ana');
    expect(steps.find((s) => s.id === 'done')?.body[0]).toContain('Ana');

    const anon = tourSteps(ctx({ name: null }));
    expect(anon[0]?.body[0]).toMatch(/^Esta es tu oficina/);
    const text = anon.flatMap((s) => [s.title, ...s.body]).join(' ');
    expect(text).not.toMatch(/null|undefined/);
  });

  it('el cierre lista los atajos y ofrece cambiar el nombre solo fuera del demo', () => {
    const done = tourSteps(ctx()).at(-1);
    expect(done?.id).toBe('done');
    expect(done?.shortcuts.map((s) => s.key)).toEqual(['A', 'F', 'Tab', 'Esc']);
    expect(done?.offerRename).toBe(true);
    expect(done?.body.join(' ')).toContain('Guía');
    expect(tourSteps(ctx({ demo: true, name: null })).at(-1)?.offerRename).toBe(false);
    expect(tourSteps(ctx()).filter((s) => s.offerRename)).toHaveLength(1);
  });

  it('en pantallas angostas solo tarjetas al centro: nada se resalta ni se abre', () => {
    const steps = tourSteps(ctx({ spotlight: false }));
    expect(steps).toHaveLength(9);
    expect(steps.every((s) => s.target.kind === 'none' && s.openAgentId === null)).toBe(true);
  });

  it('elige un agente trabajando, si no el lider de la sala del usuario', () => {
    expect(pickTourAgent(null)).toBeNull();
    expect(pickTourAgent(office())).toBeNull();
    const busy = office({ rooms: [room('s1'), room('s2', [agent('ag-9', { status: 'working' })])] });
    expect(pickTourAgent(busy)).toBe('ag-9');
    const calm = office({ leadRoomId: 's2', rooms: [room('s1'), room('s2')] });
    expect(pickTourAgent(calm)).toBe('s2-lider');
    expect(pickTourAgent(office({ leadRoomId: 'otra', rooms: [room('s1')] }))).toBe('s1-lider');
  });
});

describe('geometria de la guia', () => {
  const viewport = { width: 1440, height: 900 };
  const card = { width: 380, height: 240 };

  it('sin objetivo, la tarjeta va al centro', () => {
    expect(placeCard(null, card, viewport)).toEqual({ x: 530, y: 330 });
  });

  it('debajo de la barra de arriba, a la derecha de la lista y a la izquierda del panel, sin taparlos', () => {
    const bar = { x: 900, y: 12, width: 528, height: 40 };
    const below = placeCard(bar, card, viewport);
    expect(below.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    expect(below.x + card.width).toBeLessThanOrEqual(viewport.width - 12);

    const list = { x: 12, y: 62, width: 272, height: 826 };
    const right = placeCard(list, card, viewport);
    expect(right.x).toBeGreaterThanOrEqual(list.x + list.width);

    const drawer = { x: 1028, y: 62, width: 400, height: 826 };
    const left = placeCard(drawer, card, viewport);
    expect(left.x + card.width).toBeLessThanOrEqual(drawer.x);
  });

  it('un objetivo que llena la ventana (la escena) lleva la tarjeta adentro, abajo y sin salirse', () => {
    const scene = { x: 290, y: 60, width: 1140, height: 830 };
    const pos = placeCard(scene, card, viewport);
    expect(pos.y + card.height).toBeLessThanOrEqual(viewport.height - 12);
    expect(pos.y).toBeGreaterThan(viewport.height / 2);
  });

  it('une las cajas visibles e ignora las ocultas; el area libre sale de hudInsets', () => {
    expect(
      unionBox([
        { x: 10, y: 10, width: 100, height: 40 },
        { x: 0, y: 0, width: 0, height: 0 },
        { x: 120, y: 12, width: 60, height: 40 },
      ]),
    ).toEqual({ x: 10, y: 10, width: 170, height: 42 });
    expect(unionBox([{ x: 5, y: 5, width: 0, height: 20 }])).toBeNull();
    expect(freeArea({ top: 60, right: 400, bottom: 0, left: 290 }, viewport)).toEqual({
      x: 290,
      y: 60,
      width: 750,
      height: 840,
    });
    expect(freeArea({ top: 900, right: 0, bottom: 0, left: 0 }, viewport)).toBeNull();
    expect(spotBox({ x: 0, y: 0, width: 50, height: 20 }, viewport)).toEqual({ x: 2, y: 2, width: 54, height: 24 });
  });
});

describe('primera lectura del historial', () => {
  const health = (partial: Partial<HealthResponse>): HealthResponse => ({
    ok: true,
    backfill: 'en curso',
    filesTotal: 480,
    filesDone: 120,
    sseClients: 1,
    ...partial,
  });

  it('muestra el avance mientras lee y nada cuando termino o fallo', () => {
    expect(firstReadView(health({}))).toEqual({ done: 120, total: 480, ratio: 0.25, text: '120 de 480 archivos' });
    expect(firstReadView(health({ backfill: 'pendiente', filesTotal: 0, filesDone: 0 }))).toEqual({
      done: 0,
      total: 0,
      ratio: null,
      text: 'Buscando archivos…',
    });
    expect(firstReadView(health({ filesDone: 999 }))?.ratio).toBe(1);
    expect(firstReadView(health({ backfill: 'listo' }))).toBeNull();
    expect(firstReadView(health({ backfill: 'error' }))).toBeNull();
    expect(firstReadView(undefined)).toBeNull();
  });

  it('pregunta cada 2 s mientras lee, cada 10 s si falla y nunca al terminar', () => {
    expect(firstReadPollMs('pending', undefined)).toBe(FIRST_READ_POLL_MS);
    expect(firstReadPollMs('success', health({}))).toBe(FIRST_READ_POLL_MS);
    expect(firstReadPollMs('success', health({ backfill: 'pendiente' }))).toBe(FIRST_READ_POLL_MS);
    expect(firstReadPollMs('success', health({ backfill: 'listo' }))).toBe(false);
    expect(firstReadPollMs('success', health({ backfill: 'error' }))).toBe(false);
    expect(firstReadPollMs('error', undefined)).toBe(FIRST_READ_ERROR_POLL_MS);
    expect(firstReadPollMs('error', health({}))).toBe(FIRST_READ_ERROR_POLL_MS);
  });
});

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

function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"][aria-modal="true"]');

beforeEach(() => {
  window.localStorage.clear();
  useOfficeStore.setState({
    snapshot: null,
    connection: 'connecting',
    demo: false,
    historyOpen: false,
    notesRoomId: null,
    selectedAgentId: null,
    tourOpen: false,
    nameEditOpen: false,
  });
});

afterEach(() => {
  const r = root;
  if (r) act(() => r.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('bienvenida', () => {
  it('aparece con leadName null y Empezar se habilita al escribir', () => {
    useOfficeStore.setState({ snapshot: office({ leadName: null }) });
    render(createElement(Onboarding));
    const box = dialog();
    expect(box?.textContent).toContain('Bienvenido a Colmena');
    expect(box?.textContent).toContain('Tus agentes de Claude Code, trabajando en vivo.');
    const input = box?.querySelector('input');
    const start = Array.from(box?.querySelectorAll('button') ?? []).find((b) => b.textContent === 'Empezar');
    expect(input?.maxLength).toBe(24);
    expect(document.activeElement).toBe(input);
    expect(start?.disabled).toBe(true);
    if (!input) throw new Error('sin campo');
    typeInto(input, '   ');
    expect(start?.disabled).toBe(true);
    typeInto(input, 'Ana');
    expect(start?.disabled).toBe(false);
  });

  it('no aparece con nombre, ni en el demo, ni sin snapshot', () => {
    useOfficeStore.setState({ snapshot: office({ leadName: 'Ana' }) });
    render(createElement(Onboarding));
    expect(dialog()).toBeNull();
    act(() => useOfficeStore.setState({ demo: true, snapshot: office({ leadName: null }) }));
    expect(dialog()).toBeNull();
    act(() => useOfficeStore.setState({ demo: false, snapshot: null }));
    expect(dialog()).toBeNull();
    // un server viejo o un fixture sin el campo tampoco lo pide
    act(() => useOfficeStore.setState({ snapshot: office() }));
    expect(dialog()).toBeNull();
  });

  it('Esc no lo cierra ni llega a los paneles de atras', () => {
    useOfficeStore.setState({ snapshot: office({ leadName: null, rooms: [room('s1')] }), selectedAgentId: 's1-lider' });
    function Probe() {
      useHudHotkeys();
      return createElement(Onboarding);
    }
    render(createElement(Probe));
    const input = dialog()?.querySelector('input');
    if (!input) throw new Error('sin campo');
    press(input, 'Escape');
    expect(dialog()).not.toBeNull();
    expect(useOfficeStore.getState().selectedAgentId).toBe('s1-lider');
  });

  it('guarda con PUT, muestra el error del server y al llegar el nombre se cierra y arranca la guia', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    let reply = new Response(JSON.stringify({ error: 'Escribe un nombre' }), { status: 400 });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return reply;
    });
    useOfficeStore.setState({ snapshot: office({ leadName: null, rooms: [room('s1')] }) });
    render(createElement(Onboarding));
    const input = dialog()?.querySelector('input');
    const form = dialog()?.querySelector('form');
    if (!input || !form) throw new Error('sin formulario');
    typeInto(input, '  Ana   María ');
    const submit = async () => {
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    await submit();
    expect(calls[0]?.url).toBe('/api/settings/lead-name');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: 'Ana María' });
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Escribe un nombre');

    reply = new Response(JSON.stringify({ name: 'Ana María' }), { status: 200 });
    await submit();
    expect(calls).toHaveLength(2);
    // sin esperar al SSE (puede estar caido): la respuesta del PUT cierra el dialogo y, como la guia no se
    // vio, arranca
    expect(useOfficeStore.getState().snapshot?.leadName).toBe('Ana María');
    expect(document.body.textContent).not.toContain('Bienvenido a Colmena');
    expect(useOfficeStore.getState().tourOpen).toBe(true);
    expect(document.querySelector('.ob-card')?.textContent).toContain('Ana María, esta es tu oficina');
    // despues el SSE trae el mismo nombre: nada se reabre
    act(() => useOfficeStore.getState().setSnapshot(office({ leadName: 'Ana María', rooms: [room('s1')] })));
    expect(document.body.textContent).not.toContain('Bienvenido a Colmena');
    expect(useOfficeStore.getState().tourOpen).toBe(true);
  });

  it('si el SSE ya trajo el nombre, la respuesta del PUT no toca el snapshot', async () => {
    const fromStream = office({ leadName: 'Ana' });
    vi.stubGlobal('fetch', async () => {
      // el server manda el snapshot por SSE antes de responder el PUT
      useOfficeStore.getState().setSnapshot(fromStream);
      return new Response(JSON.stringify({ name: 'Ana' }), { status: 200 });
    });
    useOfficeStore.setState({ snapshot: office({ leadName: 'Beto' }), nameEditOpen: true });
    render(createElement(Onboarding));
    const input = dialog()?.querySelector('input');
    const form = dialog()?.querySelector('form');
    if (!input || !form) throw new Error('sin formulario');
    typeInto(input, 'Ana');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useOfficeStore.getState().snapshot).toBe(fromStream);
    expect(useOfficeStore.getState().nameEditOpen).toBe(false);
  });

  it('cambiar el nombre: parte del actual, Guardar espera un cambio y Esc cancela', () => {
    useOfficeStore.setState({ snapshot: office({ leadName: 'Ana' }), nameEditOpen: true });
    render(createElement(Onboarding));
    const box = dialog();
    expect(box?.textContent).toContain('Cambiar tu nombre');
    const input = box?.querySelector('input');
    const save = Array.from(box?.querySelectorAll('button') ?? []).find((b) => b.textContent === 'Guardar');
    expect(input?.value).toBe('Ana');
    expect(save?.disabled).toBe(true);
    if (!input) throw new Error('sin campo');
    typeInto(input, 'Ana Sofía');
    expect(save?.disabled).toBe(false);
    press(input, 'Escape');
    expect(useOfficeStore.getState().nameEditOpen).toBe(false);
    expect(dialog()).toBeNull();
  });

  it('el boton del panel del lider no existe en el demo', () => {
    useOfficeStore.setState({ demo: true });
    const view = render(createElement(ChangeNameButton));
    expect(view.querySelector('button')).toBeNull();
    act(() => useOfficeStore.setState({ demo: false }));
    const button = view.querySelector<HTMLButtonElement>('button[aria-label="Cambiar mi nombre"]');
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(useOfficeStore.getState().nameEditOpen).toBe(true);
  });
});

describe('primera lectura montada', () => {
  function Probe() {
    return createElement('output', null, useFirstRead(true)?.text ?? 'nada');
  }

  // fetch, json y el aviso de TanStack Query pasan por varias vueltas de la cola
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it('solo pregunta con el SSE vivo y vuelve a preguntar al reconectar', async () => {
    const urls: string[] = [];
    let backfill: HealthResponse['backfill'] = 'listo';
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const body: HealthResponse = { ok: true, backfill, filesTotal: 480, filesDone: 120, sseClients: 1 };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    // mismo staleTime que main.tsx; gcTime infinito para no dejar timers de limpieza
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, gcTime: Infinity } } });
    useOfficeStore.setState({ connection: 'offline' });
    const view = render(createElement(QueryClientProvider, { client }, createElement(Probe)));
    await settle();
    // server caido: ni una pregunta
    expect(urls).toEqual([]);

    act(() => useOfficeStore.setState({ connection: 'live' }));
    await settle();
    expect(urls).toEqual(['/api/health']);
    expect(view.textContent).toBe('nada');

    // el server se reinicia y relee el historial: al volver el SSE pregunta otra vez, aunque ya vio 'listo'
    backfill = 'en curso';
    act(() => useOfficeStore.setState({ connection: 'connecting' }));
    act(() => useOfficeStore.setState({ connection: 'live' }));
    await settle();
    expect(urls).toHaveLength(2);
    expect(view.textContent).toBe('120 de 480 archivos');
  });
});

describe('guia montada', () => {
  function Probe() {
    useHudHotkeys();
    return createElement(Tour);
  }

  it('avanza con flechas, abre un agente real en su paso y al salir deja todo como estaba', () => {
    const snapshot = office({ leadName: 'Ana', rooms: [room('s1', [agent('ag-1', { status: 'working' })])] });
    useOfficeStore.setState({ snapshot, tourOpen: true });
    render(createElement(Probe));
    const card = (): HTMLElement | null => document.querySelector('.ob-card');
    expect(card()?.dataset.step).toBe('welcome');
    expect(card()?.textContent).toContain('Paso 1 de 9');
    expect(card()?.contains(document.activeElement)).toBe(true);

    const el = card();
    if (!el) throw new Error('sin tarjeta');
    press(el, 'ArrowLeft');
    expect(card()?.dataset.step).toBe('welcome');
    for (let i = 0; i < 5; i++) press(el, 'ArrowRight');
    expect(card()?.dataset.step).toBe('agent');
    expect(useOfficeStore.getState().selectedAgentId).toBe('ag-1');
    press(el, 'ArrowRight');
    expect(card()?.dataset.step).toBe('flows');
    expect(useOfficeStore.getState().selectedAgentId).toBeNull();

    // H, A y F no abren nada detras de la guia
    press(el, 'h');
    press(el, 'a');
    expect(useOfficeStore.getState().historyOpen).toBe(false);

    press(el, 'ArrowLeft');
    expect(useOfficeStore.getState().selectedAgentId).toBe('ag-1');
    press(el, 'Escape');
    expect(useOfficeStore.getState().tourOpen).toBe(false);
    expect(useOfficeStore.getState().selectedAgentId).toBeNull();
    expect(card()).toBeNull();
    expect(window.localStorage.getItem(TOUR_SEEN_KEY)).toBe('1');
    expect(window.localStorage.getItem(HINT_KEY)).toBe('1');
  });

  it('sin salas explica el panel sin abrir nada y ofrece el demo; el cierre ofrece cambiar el nombre', () => {
    useOfficeStore.setState({ snapshot: office({ leadName: 'Ana' }), tourOpen: true });
    render(createElement(Probe));
    const el = document.querySelector('.ob-card');
    if (!el) throw new Error('sin tarjeta');
    for (let i = 0; i < 3; i++) press(el, 'ArrowRight');
    expect(el.querySelector('a[href="?demo=1"]')?.textContent).toBe('Ver con datos de ejemplo');
    for (let i = 0; i < 2; i++) press(el, 'ArrowRight');
    expect((el as HTMLElement).dataset.step).toBe('agent');
    expect(useOfficeStore.getState().selectedAgentId).toBeNull();
    for (let i = 0; i < 10; i++) press(el, 'ArrowRight');
    expect((el as HTMLElement).dataset.step).toBe('done');
    const rename = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Cambiar mi nombre');
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent === 'Terminar')).toBe(true);
    act(() => rename?.click());
    expect(useOfficeStore.getState().tourOpen).toBe(false);
    expect(useOfficeStore.getState().nameEditOpen).toBe(true);
    expect(window.localStorage.getItem(TOUR_SEEN_KEY)).toBe('1');
  });
});
