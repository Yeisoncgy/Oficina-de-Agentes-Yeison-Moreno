// Bandeja de alertas y avisos para Claude Code (Habitos > En vivo). Montaje real en jsdom con react-dom y
// TanStack Query; fetch responde con datos sinteticos de prueba (nada real) y guarda el descarte en memoria,
// como el server. Sin JSX: el archivo es .ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HabitFinding, HabitsInboxResponse, HabitsResponse, InboxGroup, InboxItem, InboxLevel } from '@shared/contract';
import { useOfficeStore } from '@/state/store';
import { HabitsTab } from '@/hud/HabitsTab';

// react-dom exige declarar el entorno de act()
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- datos sinteticos ----

const item = (key: string, level: InboxLevel, title: string): InboxItem => ({
  key,
  level,
  roomId: 's1',
  roomTitle: 'sala-prueba',
  projectName: 'proyecto-prueba',
  agentName: 'Bruno',
  title,
  instruction: 'Instrucción de prueba para el lead.',
});

const ALERTS: InboxItem[] = [
  item('f:rule:s1:agent_cost', 'critical', 'Costo del agente sobre el tope'),
  item('a:agent:a2:rule:agent_cost', 'critical', 'Otro agente sobre el tope'),
];
const WARNINGS: InboxItem[] = [item('f:repeated_read:s1:a1:archivo.ts', 'warning', 'Leyó archivo.ts 6 veces')];

function group(level: InboxLevel, items: InboxItem[]): InboxGroup {
  const head = level === 'critical' ? 'Alertas de la oficina' : 'Avisos de la oficina';
  const text = items.length > 0 ? `${head}\n${items.map((i, n) => `${n + 1}. ${i.title}: ${i.instruction}`).join('\n')}` : '';
  return { level, items, text };
}

/** estado del server falso: llaves descartadas */
let hidden = new Set<string>();
let alertsSource: InboxItem[] = ALERTS;
let warningsSource: InboxItem[] = WARNINGS;

function inboxNow(): HabitsInboxResponse {
  const visible = (items: InboxItem[]) => items.filter((i) => !hidden.has(i.key));
  return {
    generatedAt: '2026-09-29T15:00:00.000Z',
    alerts: group('critical', visible(alertsSource)),
    warnings: group('warning', visible(warningsSource)),
    dismissed: [...alertsSource, ...warningsSource].filter((i) => hidden.has(i.key)).length,
  };
}

const finding = (id: string, title: string, dismissed?: boolean): HabitFinding => ({
  id,
  kind: 'repeated_read',
  severity: 'warning',
  roomId: 's1',
  roomTitle: 'sala-prueba',
  projectName: 'proyecto-prueba',
  agentId: 'a1',
  agentName: 'Bruno',
  title,
  evidence: [],
  recommendation: 'Ubica con Grep y lee solo el tramo que necesitas.',
  copyText: 'Instrucción de prueba.',
  savingsUsd: null,
  detectedAt: '2026-09-29T14:00:00.000Z',
  live: false,
  ...(dismissed === undefined ? {} : { dismissed }),
});

function habits(range: HabitsResponse['range']): HabitsResponse {
  const findings =
    range === 'live'
      ? []
      : [finding('repeated_read:s1:a1:uno.ts', 'Leyó uno.ts 5 veces', true), finding('repeated_read:s1:a1:dos.ts', 'Leyó dos.ts 4 veces')];
  return {
    range,
    generatedAt: '2026-09-29T15:00:00.000Z',
    findings,
    byKind: findings.length > 0 ? [{ kind: 'repeated_read', count: findings.length, savingsUsd: 0 }] : [],
    totalSavingsUsd: 0,
  };
}

// ---- fetch falso ----

type Handler = (body: unknown, url: URL) => unknown;
let routes: Record<string, Handler> = {};
const calls: { method: string; path: string; body: unknown }[] = [];

function jsonResponse(status: number, data: unknown): Response {
  // basta lo que lee state/api.ts (ok, status, json)
  const res: Pick<Response, 'ok' | 'status' | 'json'> = { ok: status < 400, status, json: async () => data };
  return res as Response;
}

function defaultRoutes(): Record<string, Handler> {
  return {
    'GET /api/habits': (_, url) => habits((url.searchParams.get('range') ?? 'live') as HabitsResponse['range']),
    'GET /api/habits/inbox': () => inboxNow(),
    'POST /api/habits/inbox/dismiss': (body) => {
      for (const key of (body as { keys: string[] }).keys) hidden.add(key);
      return inboxNow();
    },
    'POST /api/habits/inbox/restore': (body) => {
      for (const key of (body as { keys: string[] }).keys) hidden.delete(key);
      return inboxNow();
    },
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  calls.length = 0;
  hidden = new Set();
  alertsSource = ALERTS;
  warningsSource = WARNINGS;
  routes = defaultRoutes();
  useOfficeStore.setState({ demo: false, habitsRange: null });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://127.0.0.1');
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      const handler = routes[`${method} ${url.pathname}`];
      return handler ? jsonResponse(200, handler(body, url)) : jsonResponse(404, {});
    }),
  );
});

afterEach(() => {
  const r = root;
  if (r) act(() => r.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

function render(element: ReactElement): HTMLDivElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  const div = document.createElement('div');
  document.body.appendChild(div);
  const r = createRoot(div);
  act(() => r.render(createElement(QueryClientProvider, { client }, element)));
  root = r;
  host = div;
  return div;
}

/** deja correr fetch, TanStack Query y los renders que disparan */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('no se encontro el elemento');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

function byText<T extends Element = HTMLElement>(root: ParentNode, selector: string, text: string): T | undefined {
  return Array.from(root.querySelectorAll<T>(selector)).find((el) => el.textContent?.includes(text));
}

function clipboard(ok: boolean) {
  const writeText = vi.fn(async (_text: string) => {
    if (!ok) throw new Error('sin permiso');
  });
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);
const statusOf = (view: HTMLElement) => view.querySelector('.inbox [role="status"]')?.textContent ?? '';

// ---- pruebas ----

describe('bandeja de alertas', () => {
  it('copiar alertas copia el texto del server y descarta esas llaves', async () => {
    const writeText = clipboard(true);
    const view = render(createElement(HabitsTab));
    await flush();
    const text = inboxNow().alerts.text;
    await click(byText(view, '.inbox button', 'Copiar alertas (2)'));
    expect(writeText).toHaveBeenCalledWith(text);
    expect(posts('/api/habits/inbox/dismiss').map((c) => c.body)).toEqual([
      { level: 'critical', keys: ALERTS.map((i) => i.key) },
    ]);
    expect(statusOf(view)).toBe('Copiadas 2 alertas. Pégalas en Claude Code.');
    // sin alertas pendientes su boton sale de la cabecera
    expect(byText(view, '.inbox button', 'Copiar alertas')).toBeUndefined();
    // los avisos no se tocan
    expect(byText<HTMLButtonElement>(view, '.inbox button', 'Copiar avisos (1)')?.disabled).toBe(false);
    expect(view.querySelector('.inbox-hidden')?.textContent).toBe('2 ocultas hasta que salga algo nuevo');
  });

  it('va en la cabecera, junto al periodo: alertas como accion primaria y avisos como secundaria', async () => {
    const view = render(createElement(HabitsTab));
    await flush();
    const top = view.querySelector('.habit-top');
    expect(top?.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(top?.querySelector('.inbox')).not.toBeNull();
    expect(byText(view, '.inbox button', 'Copiar alertas (2)')?.className).toContain('btn--primary');
    expect(byText(view, '.inbox button', 'Copiar avisos (1)')?.className).not.toContain('btn--primary');
    // sin caja ni texto de ayuda: solo los botones
    expect(view.querySelector('.inbox h3')).toBeNull();
    expect(view.querySelector('.inbox details')).toBeNull();
  });

  it('Deshacer restaura las mismas llaves y vuelven a la lista', async () => {
    clipboard(true);
    const view = render(createElement(HabitsTab));
    await flush();
    await click(byText(view, '.inbox button', 'Copiar alertas (2)'));
    await click(byText(view, '.inbox button', 'Deshacer'));
    expect(posts('/api/habits/inbox/restore').map((c) => c.body)).toEqual([{ keys: ALERTS.map((i) => i.key) }]);
    expect(byText<HTMLButtonElement>(view, '.inbox button', 'Copiar alertas (2)')?.disabled).toBe(false);
    expect(statusOf(view)).toBe('Volvieron 2 alertas a la lista.');
    expect(byText(view, '.inbox button', 'Deshacer')).toBeUndefined();
    expect(view.querySelector('.inbox-hidden')).toBeNull();
  });

  it('un solo aviso: mensaje en singular y nivel warning', async () => {
    const writeText = clipboard(true);
    const view = render(createElement(HabitsTab));
    await flush();
    const text = inboxNow().warnings.text;
    await click(byText(view, '.inbox button', 'Copiar avisos (1)'));
    expect(writeText).toHaveBeenCalledWith(text);
    expect(posts('/api/habits/inbox/dismiss').map((c) => c.body)).toEqual([
      { level: 'warning', keys: WARNINGS.map((i) => i.key) },
    ]);
    expect(statusOf(view)).toBe('Copiado 1 aviso. Pégalo en Claude Code.');
    expect(view.querySelector('.inbox-hidden')?.textContent).toBe('1 oculta hasta que salga algo nuevo');
  });

  it('si el navegador no deja copiar no descarta, muestra el texto y "Ya lo copié" descarta', async () => {
    clipboard(false);
    const view = render(createElement(HabitsTab));
    await flush();
    const text = inboxNow().alerts.text;
    await click(byText(view, '.inbox button', 'Copiar alertas (2)'));
    expect(posts('/api/habits/inbox/dismiss')).toHaveLength(0);
    const alert = view.querySelector('.inbox [role="alert"]');
    expect(alert?.textContent).toContain('El navegador no dejó copiar');
    expect(alert?.querySelector('code')?.textContent).toBe(text);
    expect(byText<HTMLButtonElement>(view, '.inbox button', 'Copiar alertas (2)')?.disabled).toBe(false);
    await click(byText(view, '.inbox button', 'Ya lo copié, ocultarlas'));
    expect(posts('/api/habits/inbox/dismiss').map((c) => c.body)).toEqual([
      { level: 'critical', keys: ALERTS.map((i) => i.key) },
    ]);
    expect(view.querySelector('.inbox [role="alert"]')).toBeNull();
    expect(byText(view, '.inbox button', 'Copiar alertas')).toBeUndefined();
  });

  it('con 0 items no muestra botones ni la linea de ocultas', async () => {
    alertsSource = [];
    warningsSource = [];
    const view = render(createElement(HabitsTab));
    await flush();
    expect(view.querySelector('.inbox')).not.toBeNull();
    expect(view.querySelectorAll('.inbox button')).toHaveLength(0);
    expect(view.querySelector('.inbox-hidden')).toBeNull();
  });

  it('no aparece fuera de En vivo', async () => {
    const view = render(createElement(HabitsTab));
    await flush();
    expect(view.querySelector('.inbox')).not.toBeNull();
    await click(byText(view, '[role="radio"]', 'Hoy'));
    expect(view.querySelector('.inbox')).toBeNull();
  });

  it('no aparece en demo ni pide la bandeja', async () => {
    useOfficeStore.setState({ demo: true });
    const view = render(createElement(HabitsTab));
    await flush();
    expect(view.querySelector('.inbox')).toBeNull();
    expect(calls.some((c) => c.path.startsWith('/api/habits/inbox'))).toBe(false);
  });

  it('en un rango historico lo ya copiado lleva la etiqueta "Enviada"', async () => {
    useOfficeStore.setState({ habitsRange: 'today' });
    const view = render(createElement(HabitsTab));
    await flush();
    expect(view.querySelector('.inbox')).toBeNull();
    expect(byText(view, 'li.habit', 'uno.ts')?.querySelector('.habit-sent')?.textContent).toBe('Enviada');
    expect(byText(view, 'li.habit', 'dos.ts')?.querySelector('.habit-sent')).toBeNull();
  });
});
