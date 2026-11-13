// Historial agrupado y pestanas de eficiencia (W2a). Montaje real en jsdom con react-dom y TanStack
// Query; fetch responde con datos sinteticos de prueba (nada real). Sin JSX: el archivo es .ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  riskOf,
  type BudgetResponse,
  type CompareResponse,
  type CostsResponse,
  type HabitsResponse,
  type RuleConfig,
  type RulesResponse,
  type SimulatorResponse,
  type TokenBreakdown,
} from '@shared/contract';
import { currentMonth, dailyPace, isWeekend, monthCalendar, monthDays, parseEsNumber } from '@/lib/history';
import { readShowSpend, useOfficeStore, type HistoryTab } from '@/state/store';
import { STATE } from '@/theme';
import { BudgetTab } from '@/hud/BudgetTab';
import { CompareTab } from '@/hud/CompareTab';
import { CostsTab } from '@/hud/CostsTab';
import { HabitsTab } from '@/hud/HabitsTab';
import { HISTORY_GROUPS, HistoryModal, historyGroupOf } from '@/hud/HistoryModal';
import { RankingTab } from '@/hud/RankingTab';
import { RulesTab } from '@/hud/RulesTab';
import { SimulatorTab } from '@/hud/SimulatorTab';
import { TasksTab } from '@/hud/TasksTab';
import {
  compareRowPricing,
  costRowPricing,
  formatEvidence,
  RISK_COLOR,
  scenarioRisk,
  simulateScenario,
  simVerdict,
  unpricedCostTokens,
} from '@/hud/insights/model';

// react-dom exige declarar el entorno de act()
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- datos sinteticos ----

const tokens = (total: number): TokenBreakdown => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, total });

const HABITS: HabitsResponse = {
  range: 'live',
  generatedAt: '2026-09-29T15:00:00.000Z',
  findings: [
    {
      id: 'repeated_read:s1:a1:archivo.ts',
      kind: 'repeated_read',
      severity: 'warning',
      roomId: 's1',
      roomTitle: 'proyecto-prueba',
      projectName: 'proyecto-prueba',
      agentId: 'a1',
      agentName: 'Bruno',
      title: 'Leyó archivo.ts 6 veces sin editarlo',
      evidence: [
        { label: 'Lecturas', value: 6, unit: 'count' },
        { label: 'Tokens por lectura', value: 12_300, unit: 'tokens', estimated: true },
      ],
      recommendation: 'Ubica con Grep y lee solo el tramo que necesitas.',
      copyText: 'No vuelvas a leer completo archivo.ts: usa Grep y lee con offset/limit.',
      savingsUsd: 0.42,
      detectedAt: '2026-09-29T14:00:00.000Z',
      live: true,
    },
    {
      id: 'rule:s2:agent_cost',
      kind: 'rule',
      ruleId: 'agent_cost',
      severity: 'critical',
      roomId: 's2',
      roomTitle: 'Sala B',
      projectName: 'otro-proyecto',
      agentId: null,
      agentName: null,
      title: 'Costo $3,40 > $2,00',
      evidence: [{ label: 'Costo del agente', value: 3.4, unit: 'usd' }],
      recommendation: 'Divide el encargo en partes más chicas.',
      copyText: 'Divide la tarea en partes.',
      savingsUsd: null,
      detectedAt: '2026-09-29T14:30:00.000Z',
      live: false,
    },
  ],
  byKind: [
    { kind: 'repeated_read', count: 1, savingsUsd: 0.42 },
    { kind: 'rule', count: 1, savingsUsd: 0 },
  ],
  totalSavingsUsd: 0.42,
};

const rule = (partial: Partial<RuleConfig> & Pick<RuleConfig, 'id' | 'label' | 'unit' | 'value'>): RuleConfig => ({
  source: 'calibrated',
  calibratedValue: partial.value,
  samples: 20,
  floor: 1,
  enabled: true,
  ...partial,
});

function rulesFixture(notifyBrowser = false): RulesResponse {
  return {
    rules: [
      rule({ id: 'agent_cost', label: 'Costo de un agente', unit: 'usd', value: 0.5, source: 'floor', calibratedValue: null, samples: 4, floor: 0.5 }),
      rule({ id: 'session_day_cost', label: 'Costo de una sesión en el día', unit: 'usd', value: 7.25, samples: 22, floor: 5 }),
      rule({ id: 'workflow_cost', label: 'Costo de un workflow', unit: 'usd', value: 3, source: 'custom', calibratedValue: 2.4, samples: 12, floor: 2 }),
      rule({ id: 'turns_without_compact', label: 'Turnos sin compactar', unit: 'count', value: 30, source: 'floor', calibratedValue: null, samples: 3, floor: 30 }),
      rule({ id: 'subagents_per_turn', label: 'Subagentes por turno', unit: 'count', value: 6, samples: 40, floor: 4 }),
      rule({ id: 'loop_repeats', label: 'Repeticiones seguidas', unit: 'count', value: 3, samples: 11, floor: 3, enabled: false }),
    ],
    notifyBrowser,
    windowDays: 30,
    calibratedAt: '2026-09-29T14:00:00.000Z',
  };
}

const MONTH = currentMonth(Date.now());

/** primer dia habil del mes a partir del dia `from` */
function weekdayOfMonth(from: number): string {
  for (let d = from; d <= 28; d++) {
    const date = `${MONTH}-${String(d).padStart(2, '0')}`;
    if (!isWeekend(date)) return date;
  }
  return `${MONTH}-${String(from).padStart(2, '0')}`;
}

const OFF_DAY = weekdayOfMonth(2);

function budgetFixture(month: string, daysOff: string[] = [OFF_DAY], partial: Partial<BudgetResponse> = {}): BudgetResponse {
  return {
    month,
    budgetUsd: 500,
    spentUsd: 125,
    projectedUsd: 400,
    daily: [],
    unpricedTokens: 0,
    budgetSource: 'default',
    daysOff,
    workdays: { total: 21, elapsed: 10, remaining: 12 },
    burnRateUsd: 12.5,
    trend5dUsd: 18,
    recommendedPerDayUsd: 20.83,
    cachePct: 0.72,
    discardedUsd: 3.2,
    ...partial,
  };
}

const COSTS: CostsResponse = {
  range: 'month',
  totals: { tokens: tokens(2_000_000), costUsd: 42.5, cachePct: 0.72 },
  byModel: [
    { key: 'claude-opus-5-5', label: 'claude-opus-5-5', tokens: tokens(1_500_000), costUsd: 30, cachePct: 0.8, tasks: 12 },
    { key: 'claude-sonnet-5', label: 'claude-sonnet-5', tokens: tokens(500_000), costUsd: 12.5, cachePct: null, tasks: 4 },
  ],
  byProject: [{ key: 'proyecto-prueba', label: 'proyecto-prueba', tokens: tokens(2_000_000), costUsd: 42.5, cachePct: 0.72, tasks: 16 }],
  byRole: [{ key: 'builder', label: 'builder', tokens: tokens(900_000), costUsd: 20, cachePct: 0.7, tasks: 6 }],
  discarded: {
    costUsd: 3.2,
    tokens: tokens(80_000),
    count: 2,
    items: [
      {
        agentId: 'x1',
        agentType: 'tr-builder',
        role: 'builder',
        roomTitle: 'proyecto-prueba',
        projectName: 'proyecto-prueba',
        reason: 'failed',
        tokens: tokens(50_000),
        costUsd: 2.2,
        endedAt: '2026-09-28T10:00:00.000Z',
      },
      {
        agentId: 'x2',
        agentType: 'Explore',
        role: null,
        roomTitle: 'proyecto-prueba',
        projectName: 'proyecto-prueba',
        reason: 'retry',
        tokens: tokens(30_000),
        costUsd: null,
        endedAt: null,
      },
    ],
  },
};

const summary = { tasks: 4, costPerCompletedUsd: 0.8, avgDurationMs: 90_000, errors: 1, cachePct: 0.6 };

const COMPARE: CompareResponse = {
  range: 'month',
  rows: [
    {
      key: 'sonnet:builder',
      family: 'sonnet',
      role: 'builder',
      tasks: 5,
      completed: 4,
      costUsd: 3,
      costPerCompletedUsd: 0.75,
      filesChanged: 7,
      tokensPerFileChanged: 45_000,
      avgDurationMs: 120_000,
      errors: 2,
      retries: 1,
      testRuns: 4,
      testPassPct: 0.75,
      cachePct: 0.66,
      discardedUsd: 0.3,
    },
    {
      key: 'opus:explorer',
      family: 'opus',
      role: 'explorer',
      tasks: 3,
      completed: 3,
      costUsd: 2,
      costPerCompletedUsd: null,
      filesChanged: 0,
      tokensPerFileChanged: null,
      avgDurationMs: null,
      errors: 0,
      retries: 0,
      testRuns: 0,
      testPassPct: null,
      cachePct: null,
      discardedUsd: 0,
    },
  ],
  skill: { with: summary, without: { ...summary, tasks: 9 } },
  workflows: { runs: 3, avgDurationMs: 600_000, avgCostUsd: 1.8, p50CostUsd: 1.5 },
  potentialSavingsUsd: 1.5,
};

const SIMULATOR: SimulatorResponse = {
  windowDays: 30,
  rows: [
    { role: 'builder', family: 'opus', samples: 12, p25Usd: 0.4, p50Usd: 0.6, p75Usd: 0.9 },
    { role: 'explorer', family: 'haiku', samples: 2, p25Usd: null, p50Usd: null, p75Usd: null },
  ],
  availableUsd: 10,
  workflowBudgetUsd: 2,
};

// ---- fetch falso: rutas por metodo + ruta (':id' comodin del ultimo segmento) ----

type Handler = (body: unknown, url: URL) => unknown;
let routes: Record<string, Handler> = {};
const calls: { method: string; path: string; body: unknown }[] = [];

function jsonResponse(status: number, data: unknown): Response {
  // basta lo que lee state/api.ts (ok, status, json)
  const res: Pick<Response, 'ok' | 'status' | 'json'> = { ok: status < 400, status, json: async () => data };
  return res as Response;
}

let daysOffState: string[] = [OFF_DAY];
let amountState: number | null = null;

const budgetNow = (month: string): BudgetResponse =>
  budgetFixture(month, daysOffState, amountState === null ? {} : { budgetUsd: amountState, budgetSource: 'custom' });

function defaultRoutes(): Record<string, Handler> {
  return {
    'GET /api/history/budget': (_, url) => budgetNow(url.searchParams.get('month') ?? MONTH),
    'GET /api/history/ranking': () => ({ range: 'month', byAgent: [], byProject: [] }),
    'GET /api/history/tasks': () => ({ items: [], nextCursor: null }),
    'GET /api/history/costs': () => COSTS,
    'GET /api/history/compare': () => COMPARE,
    'GET /api/history/simulator': () => SIMULATOR,
    'GET /api/habits': () => HABITS,
    // la bandeja (En vivo) se prueba en inbox.test.ts; aca va vacia
    'GET /api/habits/inbox': () => ({
      generatedAt: '2026-09-29T15:00:00.000Z',
      alerts: { level: 'critical', items: [], text: '' },
      warnings: { level: 'warning', items: [], text: '' },
      dismissed: 0,
    }),
    'GET /api/rules': () => rulesFixture(),
    'PUT /api/rules/:id': () => rulesFixture(),
    'PUT /api/rules/notify': (body) => rulesFixture((body as { enabled: boolean }).enabled),
    'PUT /api/budget/amount': (body) => {
      amountState = (body as { amountUsd: number }).amountUsd;
      return budgetNow(MONTH);
    },
    'DELETE /api/budget/amount': () => {
      amountState = null;
      return budgetNow(MONTH);
    },
    'PUT /api/budget/days-off': (body) => {
      const { date, off } = body as { date: string; off: boolean };
      daysOffState = off ? [...daysOffState, date] : daysOffState.filter((d) => d !== date);
      return budgetNow(MONTH);
    },
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  calls.length = 0;
  daysOffState = [OFF_DAY];
  amountState = null;
  routes = defaultRoutes();
  useOfficeStore.setState({ historyOpen: false, historyTab: 'budget', demo: false, showSpend: false });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://127.0.0.1');
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      const handler = routes[`${method} ${url.pathname}`] ?? routes[`${method} ${url.pathname.replace(/[^/]+$/, ':id')}`];
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

async function press(el: Element | null | undefined, key: string): Promise<void> {
  if (!el) throw new Error('no se encontro el elemento');
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  await flush();
}

async function typeInto(input: Element | null | undefined, value: string): Promise<void> {
  if (!(input instanceof HTMLInputElement)) throw new Error('no es un input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(select: Element | null | undefined, value: string): Promise<void> {
  if (!(select instanceof HTMLSelectElement)) throw new Error('no es un select');
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function byText<T extends Element = HTMLElement>(root: ParentNode, selector: string, text: string): T | undefined {
  return Array.from(root.querySelectorAll<T>(selector)).find((el) => el.textContent?.includes(text));
}

// ---- pestanas agrupadas ----

describe('historial agrupado', () => {
  const ALL_TABS: HistoryTab[] = [
  'budget',
  'costs',
  'ranking',
  'tasks',
  'sessions',
  'habits',
  'compare',
  'simulator',
  'report',
  'rules',
  'prices',
  'system',
];

  it('agrupa en Gasto, Eficiencia y Reglas, cada pestana en un solo grupo', () => {
    expect(HISTORY_GROUPS.map((g) => g.label)).toEqual(['Gasto', 'Eficiencia', 'Reglas']);
    expect(HISTORY_GROUPS.map((g) => g.tabs.map((t) => t.label))).toEqual([
      ['Presupuesto', 'Costos', 'Ranking', 'Tareas', 'Sesiones'],
      ['Hábitos', 'Comparador', 'Simulador', 'Informe'],
      ['Reglas', 'Precios', 'Sistema'],
    ]);
    expect(HISTORY_GROUPS.flatMap((g) => g.tabs.map((t) => t.id)).sort()).toEqual([...ALL_TABS].sort());
    expect(historyGroupOf('habits').id).toBe('efficiency');
    expect(historyGroupOf('tasks').id).toBe('spend');
    expect(historyGroupOf('rules').id).toBe('rules');
  });

  it("openHistory('habits') abre Eficiencia > Habitos y no cae en Tareas", async () => {
    useOfficeStore.getState().openHistory('habits');
    const view = render(createElement(HistoryModal));
    await flush();
    const group = view.querySelector('#history-group-efficiency');
    expect(group?.getAttribute('aria-selected')).toBe('true');
    expect(view.querySelector('#history-tab-habits')?.getAttribute('aria-selected')).toBe('true');
    expect(view.querySelector('[data-tab]')?.getAttribute('data-tab')).toBe('habits');
    expect(view.textContent).toContain('Leyó archivo.ts 6 veces sin editarlo');
    expect(view.textContent).not.toContain('Todavía no hay tareas');
  });

  it.each([
    ['budget', 'Presupuesto mensual'],
    ['costs', 'Trabajo descartado'],
    ['ranking', 'Sin datos para este periodo'],
    ['tasks', 'Todavía no hay tareas terminadas'],
    ['habits', 'Ahorro posible'],
    ['compare', 'Por modelo y rol'],
    ['simulator', 'Escenario'],
    ['rules', 'Aviso del navegador'],
  ] as const)('la pestana %s muestra su propio contenido', async (tab, signature) => {
    useOfficeStore.getState().openHistory(tab);
    const view = render(createElement(HistoryModal));
    await flush();
    const panel = view.querySelector('[data-tab]');
    expect(panel?.getAttribute('data-tab')).toBe(tab);
    expect(panel?.textContent).toContain(signature);
    if (tab !== 'tasks') expect(panel?.textContent).not.toContain('Todavía no hay tareas');
  });

  it('las flechas cambian de grupo y el grupo recuerda su ultima pestana', async () => {
    useOfficeStore.getState().openHistory('compare');
    const view = render(createElement(HistoryModal));
    await flush();
    await press(view.querySelector('#history-group-efficiency'), 'ArrowRight');
    expect(useOfficeStore.getState().historyTab).toBe('rules');
    // Reglas tambien tiene su fila: Reglas, Precios y Sistema
    expect(view.querySelectorAll('.subtabs [role="tab"]')).toHaveLength(3);
    await press(view.querySelector('#history-group-rules'), 'ArrowLeft');
    expect(useOfficeStore.getState().historyTab).toBe('compare');
    await press(view.querySelector('#history-group-efficiency'), 'Home');
    expect(useOfficeStore.getState().historyTab).toBe('budget');
    await press(view.querySelector('#history-tab-budget'), 'End');
    expect(useOfficeStore.getState().historyTab).toBe('sessions');
    expect(document.activeElement?.id).toBe('history-tab-sessions');
  });

  it('en modo demo avisa que necesita el servidor', async () => {
    useOfficeStore.setState({ demo: true });
    useOfficeStore.getState().openHistory('rules');
    const view = render(createElement(HistoryModal));
    await flush();
    expect(view.textContent).toContain('El historial necesita el servidor');
    expect(calls).toHaveLength(0);
  });
});

// ---- habitos ----

describe('habitos', () => {
  /** despliega la fila del hallazgo que contiene `text` y devuelve su <li> */
  async function openFinding(view: HTMLElement, text: string): Promise<HTMLElement | undefined> {
    const item = byText(view, 'li.habit', text);
    await click(item?.querySelector('button.habit-row'));
    return item;
  }

  it('muestra resumen y filas planas con sala · agente; la evidencia sale al desplegar', async () => {
    const view = render(createElement(HabitsTab));
    await flush();
    // En vivo tambien pide la bandeja (/api/habits/inbox): el orden entre las dos no importa
    expect(calls.map((c) => c.path)).toContain('/api/habits');
    expect(view.querySelector('.habit-total .ui-stat-value')?.textContent).toBe('~$0,42');
    expect(view.textContent).not.toContain('Reglas fijas sobre los transcripts');
    const item = byText(view, 'li.habit', 'archivo.ts');
    // la severidad es un LED: la palabra queda para lectores de pantalla
    expect(item?.textContent).toContain('Aviso');
    expect(item?.querySelector('.habit-sev')?.getAttribute('title')).toBe('Aviso');
    expect(item?.querySelector('.habit-meta')?.textContent).toBe('proyecto-prueba · Bruno · en vivo · Relecturas');
    expect(item?.querySelector('.habit-save')?.textContent).toBe('~$0,42');
    expect(item?.textContent).not.toContain('~12,3 k');
    expect(item?.textContent).not.toContain('Ubica con Grep');
    await openFinding(view, 'archivo.ts');
    expect(item?.textContent).toContain('~12,3 k');
    expect(item?.textContent).toContain('Ubica con Grep');
    const critical = byText(view, 'li.habit', 'Costo $3,40');
    expect(critical?.className).toContain('is-critical');
    expect(critical?.textContent).toContain('Sala B (otro-proyecto)');
    // sin ahorro no hay cifra a la derecha
    expect(critical?.querySelector('.habit-save')).toBeNull();
  });

  it('filtra por tipo con los chips; con filtro activo la fila no repite el tipo', async () => {
    const view = render(createElement(HabitsTab));
    await flush();
    expect(byText(view, 'button.habit-kind', 'Todos')?.getAttribute('aria-pressed')).toBe('true');
    // sin ahorro por chip: solo nombre y conteo
    expect(byText(view, 'button.habit-kind', 'Relecturas')?.textContent).toBe('Relecturas1');
    await click(byText(view, 'button.habit-kind', 'Reglas'));
    expect(view.querySelectorAll('li.habit')).toHaveLength(1);
    expect(view.textContent).not.toContain('Leyó archivo.ts');
    expect(view.querySelector('li.habit .habit-meta')?.textContent).toBe('Sala B (otro-proyecto)');
    expect(byText(view, 'button.habit-kind', 'Todos')?.getAttribute('aria-pressed')).toBe('false');
    await click(byText(view, 'button.habit-kind', 'Reglas'));
    expect(view.querySelectorAll('li.habit')).toHaveLength(2);
    expect(byText(view, 'li.habit', 'Costo $3,40')?.querySelector('.habit-meta')?.textContent).toContain('· Reglas');
  });

  it('la fila se despliega con "Copiar instrucción" y solo una queda abierta', async () => {
    const view = render(createElement(HabitsTab));
    await flush();
    expect(byText(view, 'button', 'Copiar instrucción')).toBeUndefined();
    const first = await openFinding(view, 'archivo.ts');
    expect(first?.querySelector('button.habit-row')?.getAttribute('aria-expanded')).toBe('true');
    expect(byText(first ?? view, 'button', 'Copiar instrucción')).toBeDefined();
    const second = await openFinding(view, 'Costo $3,40');
    expect(second?.querySelector('button.habit-row')?.getAttribute('aria-expanded')).toBe('true');
    expect(first?.querySelector('button.habit-row')?.getAttribute('aria-expanded')).toBe('false');
    expect(view.querySelectorAll('.habit-body')).toHaveLength(1);
    // otro clic en la abierta la cierra
    await click(second?.querySelector('button.habit-row'));
    expect(view.querySelectorAll('.habit-body')).toHaveLength(0);
  });

  it('muestra 12 hallazgos y "Ver N más" trae el resto; al cambiar el filtro vuelve a 12', async () => {
    const base = HABITS.findings[0];
    if (!base) throw new Error('falta el hallazgo de prueba');
    const many = Array.from({ length: 15 }, (_, i) => ({ ...base, id: `repeated_read:s1:a1:f${i}.ts`, title: `Leyó f${i}.ts` }));
    routes['GET /api/habits'] = (): HabitsResponse => ({
      ...HABITS,
      findings: [...many, ...HABITS.findings.slice(1)],
      byKind: [
        { kind: 'repeated_read', count: 15, savingsUsd: 6.3 },
        { kind: 'rule', count: 1, savingsUsd: 0 },
      ],
    });
    const view = render(createElement(HabitsTab));
    await flush();
    expect(view.querySelectorAll('li.habit')).toHaveLength(12);
    await click(byText(view, 'button', 'Ver 4 más'));
    expect(view.querySelectorAll('li.habit')).toHaveLength(16);
    expect(byText(view, 'button', 'más')).toBeUndefined();
    await click(byText(view, 'button.habit-kind', 'Relecturas'));
    expect(view.querySelectorAll('li.habit')).toHaveLength(12);
    expect(byText(view, 'button', 'Ver 3 más')).toBeDefined();
  });

  it('copia la instruccion y lo confirma', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const view = render(createElement(HabitsTab));
    await flush();
    const item = await openFinding(view, 'archivo.ts');
    await click(byText(item ?? view, 'button', 'Copiar instrucción'));
    expect(writeText).toHaveBeenCalledWith(HABITS.findings[0]?.copyText);
    expect(item?.textContent).toContain('Copiada');
    expect(item?.textContent).toContain('Pégala en el chat de Claude Code.');
  });

  it('si el navegador no deja copiar, muestra la instruccion para copiarla a mano', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('sin permiso');
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const view = render(createElement(HabitsTab));
    await flush();
    const item = await openFinding(view, 'archivo.ts');
    await click(byText(item ?? view, 'button', 'Copiar instrucción'));
    expect(item?.querySelector('[role="alert"]')?.textContent).toContain('El navegador no dejó copiar');
    expect(item?.querySelector('code')?.textContent).toBe(HABITS.findings[0]?.copyText);
  });

  it('con la lista recortada por el server (total > hallazgos) dice "N de TOTAL"', async () => {
    routes['GET /api/habits'] = () => ({ ...HABITS, total: 12_345 });
    const view = render(createElement(HabitsTab));
    await flush();
    expect(view.querySelector('.habit-total .ui-stat-sub')?.textContent).toMatch(/^2 de 12\D?345 hallazgos$/);
  });

  it('sin recorte (total ausente o igual a la lista) dice solo N', async () => {
    routes['GET /api/habits'] = () => ({ ...HABITS, total: 2 });
    const view = render(createElement(HabitsTab));
    await flush();
    expect(view.querySelector('.habit-total .ui-stat-sub')?.textContent).toBe('2 hallazgos');
  });

  it('formatea la evidencia por unidad y marca lo estimado', () => {
    expect(formatEvidence({ value: 12_300, unit: 'tokens', estimated: true })).toBe('~12,3 k');
    expect(formatEvidence({ value: 6, unit: 'count' })).toBe('6');
    expect(formatEvidence({ value: 3.4, unit: 'usd' })).toBe('$3,40');
    expect(formatEvidence({ value: 0.72, unit: 'pct' })).toBe('72 %');
    expect(formatEvidence({ value: 1, unit: 'lines' })).toBe('1 línea');
    expect(formatEvidence({ value: 12, unit: 'minutes' })).toBe('12 min');
  });
});

// ---- reglas ----

describe('reglas', () => {
  it('lista las 6 reglas con su origen y muestras', async () => {
    const view = render(createElement(RulesTab));
    await flush();
    expect(view.querySelectorAll('li.rule')).toHaveLength(6);
    const floor = byText(view, 'li.rule', 'Costo de un agente');
    expect(floor?.textContent).toContain('Mínimo');
    expect(floor?.textContent).toContain('4 muestras');
    expect(byText(view, 'li.rule', 'Costo de una sesión')?.textContent).toContain('Calibrado p90');
    const custom = byText(view, 'li.rule', 'Costo de un workflow');
    expect(custom?.textContent).toContain('Propio');
    expect(custom?.textContent).toContain('p90 $2,40');
    expect(byText(view, 'li.rule', 'Repeticiones')?.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('edita el umbral en formato es-CO y lo guarda', async () => {
    const view = render(createElement(RulesTab));
    await flush();
    const item = byText(view, 'li.rule', 'Costo de una sesión');
    const input = item?.querySelector('input');
    expect(input?.value).toBe('7,25');
    await typeInto(input, '0');
    expect(item?.querySelector('[role="alert"]')?.textContent).toContain('desde 0,01');
    // bajo medio centavo redondea a 0: el server lo rechaza, la UI tambien
    await typeInto(input, '0,004');
    expect(item?.querySelector('[role="alert"]')?.textContent).toContain('desde 0,01');
    await typeInto(input, '8,50');
    await click(byText(item ?? view, 'button', 'Guardar'));
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/api/rules/session_day_cost',
      body: { value: 8.5 },
    });
  });

  it('repeticiones de un bucle solo acepta de 2 a 50, como el server', async () => {
    const view = render(createElement(RulesTab));
    await flush();
    const item = byText(view, 'li.rule', 'Repeticiones');
    const input = item?.querySelector('input');
    await typeInto(input, '1');
    expect(item?.querySelector('[role="alert"]')?.textContent).toContain('entre 2 y 50');
    await typeInto(input, '51');
    expect(item?.querySelector('[role="alert"]')?.textContent).toContain('entre 2 y 50');
    await typeInto(input, '6');
    expect(item?.querySelector('[role="alert"]')).toBeNull();
  });

  it('vuelve a calibrado y apaga una regla', async () => {
    const view = render(createElement(RulesTab));
    await flush();
    await click(byText(byText(view, 'li.rule', 'Costo de un workflow') ?? view, 'button', 'Volver a calibrado'));
    await click(byText(view, 'li.rule', 'Costo de un agente')?.querySelector('[role="switch"]'));
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toEqual([
      { method: 'PUT', path: '/api/rules/workflow_cost', body: { value: null } },
      { method: 'PUT', path: '/api/rules/agent_cost', body: { enabled: false } },
    ]);
  });

  it('si niegan el permiso del navegador, lo explica y no guarda', async () => {
    const requestPermission = vi.fn(async () => 'denied' as NotificationPermission);
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });
    const view = render(createElement(RulesTab));
    await flush();
    await click(view.querySelector('.notify [role="switch"]'));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(view.querySelector('.notify [role="alert"]')?.textContent).toContain('bloqueó las notificaciones');
    expect(calls.some((c) => c.path === '/api/rules/notify')).toBe(false);
  });

  it('con permiso concedido enciende el aviso', async () => {
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn(async () => 'granted') });
    const view = render(createElement(RulesTab));
    await flush();
    await click(view.querySelector('.notify [role="switch"]'));
    expect(calls.find((c) => c.path === '/api/rules/notify')?.body).toEqual({ enabled: true });
    expect(view.querySelector('.notify [role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  });
});

// ---- presupuesto por dia laboral ----

describe('presupuesto por dia laboral', () => {
  it('el ritmo del grafico pasa a presupuesto / dias laborales', () => {
    expect(dailyPace(500, '2026-09', 21)).toBeCloseTo(500 / 21);
    expect(dailyPace(500, '2026-09')).toBeCloseTo(500 / 30);
    expect(dailyPace(500, '2026-09', 0)).toBeCloseTo(500 / 30);
    expect(dailyPace(0, '2026-09', 21)).toBe(0);
  });

  it('arma el mini calendario de lunes a domingo con los dias libres', () => {
    const weeks = monthCalendar('2026-09', ['2026-09-15', '2026-09-05'], new Date(2026, 8, 29, 12).getTime());
    expect(weeks).toHaveLength(5);
    expect(weeks[0]?.[0]).toBeNull();
    expect(weeks[0]?.[1]?.date).toBe('2026-09-01');
    const days = weeks.flat();
    expect(days.find((d) => d?.date === '2026-09-05')).toMatchObject({ weekend: true, off: false });
    expect(days.find((d) => d?.date === '2026-09-15')).toMatchObject({ weekend: false, off: true });
    expect(days.find((d) => d?.isToday)?.date).toBe('2026-09-29');
    const bars = monthDays('2026-09', [], new Date(2026, 8, 29).getTime(), ['2026-09-15']);
    expect(bars.filter((b) => b.isWorkday)).toHaveLength(21);
  });

  it('lee montos en formato es-CO', () => {
    expect(parseEsNumber('1.234,50')).toBe(1234.5);
    expect(parseEsNumber('1.234')).toBe(1234);
    expect(parseEsNumber('256')).toBe(256);
    expect(parseEsNumber('2,5')).toBe(2.5);
    expect(parseEsNumber('2.50')).toBe(2.5);
    expect(parseEsNumber('$ 12,00')).toBe(12);
    expect(parseEsNumber('')).toBeNull();
    expect(parseEsNumber('-3')).toBeNull();
    expect(parseEsNumber('abc')).toBeNull();
  });

  it('gastado de presupuesto arriba, tres cifras de ritmo y el monto una sola vez fuera de ajustes', async () => {
    const view = render(createElement(BudgetTab));
    await flush();
    const hero = view.querySelector('.budget-hero');
    expect(hero?.querySelector('.ui-stat-value')?.textContent).toBe('$125 de $500');
    expect(hero?.querySelector('.budget-status')?.textContent).toBe('Al ritmo actual cierras con $100 de margen.');
    const stats = Array.from(view.querySelectorAll('.ui-stats > .ui-stat'));
    expect(stats.map((s) => s.querySelector('.ui-stat-label')?.textContent)).toEqual([
      'Proyectado',
      'Recomendado por día',
      'Días laborales que quedan',
    ]);
    expect(stats[0]?.textContent).toContain('$400');
    expect(stats[0]?.textContent).toContain('ritmo $12,50 por día');
    expect(stats[1]?.textContent).toContain('$20,83');
    // tendencia bajo lo recomendado: sin tono
    expect(stats[1]?.querySelector('.ui-stat-sub')?.textContent).toBe('últimos 5 días: $18,00');
    expect(stats[1]?.querySelector('.ui-stat-sub')?.className).not.toContain('is-warn');
    expect(stats[2]?.querySelector('.ui-stat-value')?.textContent).toBe('12');
    expect(view.querySelector('.chart-legend')?.textContent).toBe('Ritmo $23,81 por día laboral');
    // cache y descartado viven en Costos; sin tarjetas viejas
    expect(view.textContent).not.toContain('Caché');
    expect(view.querySelector('.fig, .pace-figs, .warn')).toBeNull();
    // el monto sale en el hero y, dentro del plegable, en los ajustes
    const settings = view.querySelector('details.ui-disclosure')?.textContent ?? '';
    const count = (text: string) => text.split('$500').length - 1;
    expect(count(view.textContent ?? '') - count(settings)).toBe(1);
    expect(view.textContent?.split('Valor equivalente API').length).toBe(2);
  });

  it('si la proyeccion pasa el presupuesto lo dice en una linea ambar', async () => {
    routes['GET /api/history/budget'] = (_, url) =>
      budgetFixture(url.searchParams.get('month') ?? MONTH, [OFF_DAY], { projectedUsd: 620 });
    const view = render(createElement(BudgetTab));
    await flush();
    const status = view.querySelector('.budget-status');
    expect(status?.className).toContain('is-warn');
    expect(status?.textContent).toBe('Al ritmo actual pasas el presupuesto por $120.');
    expect(view.querySelector('.ui-stats .ui-stat')?.className).toContain('ui-stat--warn');
  });

  it('tokens sin precio: una sola linea, sin caja', async () => {
    routes['GET /api/history/budget'] = (_, url) =>
      budgetFixture(url.searchParams.get('month') ?? MONTH, [OFF_DAY], { unpricedTokens: 400_000 });
    const view = render(createElement(BudgetTab));
    await flush();
    expect(view.querySelector('.ui-chip--warn')?.textContent).toBe('400 k tokens sin precio');
    expect(view.querySelector('.warn')).toBeNull();
  });

  it('los ajustes van plegados con monto y calendario; el ajuste al gasto real va arriba, junto al gastado', async () => {
    const view = render(createElement(BudgetTab));
    await flush();
    const settings = view.querySelector<HTMLDetailsElement>('details.ui-disclosure');
    expect(settings?.open).toBe(false);
    expect(settings?.querySelector('summary')?.textContent).toBe('Ajustes · 1 día libre');
    expect(settings?.querySelector('[aria-label="Presupuesto mensual"]')?.textContent).toContain('$500');
    expect(settings?.querySelector('[role="grid"]')).not.toBeNull();
    expect(byText(settings ?? view, 'button', 'Cambiar monto')).toBeDefined();
    expect(byText(settings ?? view, 'button', 'Ajustar al gasto real')).toBeUndefined();
    const hero = view.querySelector('.budget-hero-head');
    expect(byText(hero ?? view, 'button', 'Ajustar al gasto real')).toBeDefined();
  });

  it('ajusta al gasto real y quita el ajuste', async () => {
    let baseline: BudgetResponse['baseline'];
    routes['GET /api/history/budget'] = (_, url) => ({
      ...budgetFixture(url.searchParams.get('month') ?? MONTH),
      ...(baseline ? { baseline } : {}),
    });
    routes['PUT /api/budget/baseline'] = (body) => {
      baseline = { amountUsd: (body as { amountUsd: number }).amountUsd, since: '2026-09-29T10:00:00.000Z' };
      return budgetFixture(MONTH);
    };
    routes['DELETE /api/budget/baseline'] = () => {
      baseline = undefined;
      return budgetFixture(MONTH);
    };
    const view = render(createElement(BudgetTab));
    await flush();
    await click(byText(view, 'button', 'Ajustar al gasto real'));
    const form = view.querySelector('form[aria-label="Ajustar al gasto real"]');
    await typeInto(form?.querySelector('input'), '256,50');
    await click(byText(form ?? view, 'button', 'Guardar'));
    expect(calls.find((c) => c.path === '/api/budget/baseline')).toEqual({
      method: 'PUT',
      path: '/api/budget/baseline',
      body: { amountUsd: 256.5 },
    });
    expect(view.querySelector('.budget-hero-head')?.textContent).toContain('Ajustado a $257');
    expect(view.querySelector('details summary')?.textContent).not.toContain('ajustado');
    await click(byText(view, 'button', 'Quitar ajuste'));
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/budget/baseline')).toBe(true);
    expect(byText(view, 'button', 'Ajustar al gasto real')).toBeDefined();
  });

  it('navega al mes anterior: cifras del mes cerrado, sin proyeccion ni ajuste al gasto real', async () => {
    const view = render(createElement(BudgetTab));
    await flush();
    const label = () => view.querySelector('.month-label')?.textContent;
    const current = label();
    expect(view.querySelector('button[aria-label="Mes siguiente"]')?.hasAttribute('disabled')).toBe(true);
    await click(view.querySelector('button[aria-label="Mes anterior"]'));
    expect(label()).not.toBe(current);
    expect(calls.filter((c) => c.path === '/api/history/budget')).toHaveLength(2);
    const labels = Array.from(view.querySelectorAll('.ui-stats .ui-stat-label')).map((l) => l.textContent);
    expect(labels).toEqual(['Promedio por día laboral', 'Días laborales']);
    expect(view.querySelector('.budget-status')?.textContent).toBe('Cerró con $375 de margen.');
    expect(byText(view, 'button', 'Ajustar al gasto real')).toBeUndefined();
    await click(view.querySelector('button[aria-label="Mes siguiente"]'));
    expect(label()).toBe(current);
  });

  it('marca un dia libre en el calendario y lo guarda', async () => {
    const view = render(createElement(BudgetTab));
    await flush();
    const grid = view.querySelector('[role="grid"]');
    const buttons = Array.from(grid?.querySelectorAll('button') ?? []);
    const weekdays = monthDays(MONTH, [], Date.now()).filter((d) => !isWeekend(d.date));
    expect(buttons).toHaveLength(weekdays.length);
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    const offIndex = weekdays.findIndex((d) => d.date === OFF_DAY);
    expect(buttons[offIndex]?.getAttribute('aria-pressed')).toBe('true');
    const target = weekdays.find((d) => d.date !== OFF_DAY);
    const targetIndex = weekdays.findIndex((d) => d.date === target?.date);
    await click(buttons[targetIndex]);
    expect(calls.find((c) => c.path === '/api/budget/days-off')?.body).toEqual({ date: target?.date, off: true });
    const after = Array.from(view.querySelectorAll('[role="grid"] button'));
    expect(after[targetIndex]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('las flechas recorren los dias habiles del calendario', async () => {
    const view = render(createElement(BudgetTab));
    await flush();
    const weekdays = monthDays(MONTH, [], Date.now()).filter((d) => !isWeekend(d.date));
    const start = view.querySelector<HTMLButtonElement>('[role="grid"] button[tabindex="0"]');
    act(() => start?.focus());
    await press(start, 'Home');
    expect(document.activeElement?.textContent).toBe(String(weekdays[0]?.day));
    await press(document.activeElement, 'ArrowRight');
    expect(document.activeElement?.textContent).toBe(String(weekdays[1]?.day));
    expect(document.activeElement?.getAttribute('tabindex')).toBe('0');
    await press(document.activeElement, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe(String((weekdays[1]?.day ?? 0) + 7));
  });

  it('cambia el monto del presupuesto', async () => {
    const view = render(createElement(BudgetTab));
    await flush();
    await click(byText(view, 'button', 'Cambiar monto'));
    const form = view.querySelector('form[aria-label="Cambiar el presupuesto mensual"]');
    const input = form?.querySelector('input');
    expect(input?.value).toBe('500,00');
    await typeInto(input, '650');
    await click(byText(form ?? view, 'button', 'Guardar'));
    expect(calls.find((c) => c.path === '/api/budget/amount')).toEqual({
      method: 'PUT',
      path: '/api/budget/amount',
      body: { amountUsd: 650 },
    });
    expect(view.textContent).toContain('Monto propio');
  });
});

// ---- costos y comparador ----

describe('costos', () => {
  it('totales con caché, tablas por modelo, rol y proyecto, y lo descartado', async () => {
    const view = render(createElement(CostsTab));
    await flush();
    const stats = view.querySelector('.ui-stats');
    expect(stats?.textContent).toContain('$42,50');
    expect(stats?.textContent).toContain('72 %');
    expect(byText(view, '.ui-stat', 'Descartado')?.className).toContain('ui-stat--warn');
    expect(view.textContent).toContain('Opus 5.5');
    expect(view.textContent).toContain('Desarrollo');
    // tablas de 4 columnas: sin Cache ni Tareas por fila, y el modelo como texto (sin chip)
    const head = byText(view, 'section.ui-section', 'Por modelo')?.querySelector('.ui-row--head');
    expect(head?.textContent).toBe('ModeloTokensUSD');
    expect(view.querySelector('.model-chip')).toBeNull();
    // descartado plegado con el total en el resumen
    const discard = view.querySelector<HTMLDetailsElement>('details.discard');
    expect(discard?.open).toBe(false);
    expect(discard?.querySelector('summary')?.textContent).toBe('Trabajo descartado · $3,20 · 2 agentes');
    expect(discard?.textContent).toContain('Falló');
    expect(discard?.textContent).toContain('Reintento');
    expect(discard?.textContent).toContain('sin precio');
    expect(discard?.querySelectorAll('.discard-row:not(.ui-row--head)')).toHaveLength(2);
    // todo con precio: sin avisos ni marcas, y sin nota de "valor equivalente"
    expect(view.textContent).not.toContain('sin precio no');
    expect(view.textContent).not.toContain('equivalente');
    expect(view.querySelector('.unpriced-mark')).toBeNull();
  });

  it('sin nada descartado no muestra el plegable', async () => {
    routes['GET /api/history/costs'] = (): CostsResponse => ({
      ...COSTS,
      discarded: { costUsd: 0, tokens: tokens(0), count: 0, items: [] },
    });
    const view = render(createElement(CostsTab));
    await flush();
    expect(view.querySelector('details.discard')).toBeNull();
    expect(byText(view, '.ui-stat', 'Descartado')?.className).not.toContain('ui-stat--warn');
  });

  it('tokens sin precio: "sin precio" en vez de $0,00, marca discreta en filas parciales y una sola mencion en Gastado', async () => {
    routes['GET /api/history/costs'] = (): CostsResponse => ({
      ...COSTS,
      totals: { ...COSTS.totals, costUsd: 30, unpricedTokens: 400_000 },
      byModel: [
        { key: 'claude-opus-5-5', label: 'claude-opus-5-5', tokens: tokens(1_500_000), costUsd: 30, cachePct: 0.8, tasks: 12 },
        {
          key: 'modelo-sin-precio',
          label: 'modelo-sin-precio',
          tokens: tokens(400_000),
          costUsd: 0,
          unpricedTokens: 400_000,
          cachePct: null,
          tasks: 3,
        },
      ],
      byProject: [
        {
          key: 'proyecto-prueba',
          label: 'proyecto-prueba',
          tokens: tokens(1_900_000),
          costUsd: 30,
          unpricedTokens: 400_000,
          cachePct: 0.72,
          tasks: 15,
        },
      ],
    });
    const view = render(createElement(CostsTab));
    await flush();

    const spent = byText(view, '.ui-stat', 'Gastado');
    expect(spent?.querySelector('.ui-stat-value')?.textContent).toBe('$30,00');
    expect(spent?.querySelector('.unpriced-mark')).toBeNull();
    expect(spent?.querySelector('.ui-stat-sub')?.textContent).toBe('2 M tokens · 400 k sin precio');
    expect(view.querySelector('.warn')).toBeNull();

    const byModel = byText(view, 'section.ui-section', 'Por modelo');
    const unpricedRow = byModel?.querySelector('[title="modelo-sin-precio"]')?.closest('.cost-row');
    const usd = unpricedRow?.querySelector('.cell-num--usd');
    expect(usd?.textContent).toBe('sin precio');
    expect(usd?.className).toContain('cell-num--unpriced');
    expect(byModel?.textContent).not.toContain('$0,00');

    const byProject = byText(view, 'section.ui-section', 'Por proyecto');
    const partial = byProject?.querySelector('.cost-row:not(.ui-row--head) .cell-num--usd');
    expect(partial?.textContent).toContain('$30,00');
    expect(partial?.querySelector('.unpriced-mark')?.getAttribute('title')).toBe('400 k tokens sin precio no se suman');
    expect(partial?.className).not.toContain('cell-num--unpriced');
  });

  it('todo sin precio: Gastado dice "sin precio", no $0,00', async () => {
    routes['GET /api/history/costs'] = (): CostsResponse => ({
      ...COSTS,
      totals: { tokens: tokens(400_000), costUsd: 0, cachePct: null, unpricedTokens: 400_000 },
      byModel: [
        { key: 'modelo-sin-precio', label: 'modelo-sin-precio', tokens: tokens(400_000), costUsd: 0, unpricedTokens: 400_000, cachePct: null, tasks: 3 },
      ],
      byProject: [],
      byRole: [],
    });
    const view = render(createElement(CostsTab));
    await flush();
    const spent = byText(view, '.ui-stat', 'Gastado');
    expect(spent?.querySelector('.ui-stat-value')?.textContent).toBe('sin precio');
  });

  it('precio de filas y total de tokens sin precio (logica pura)', () => {
    expect(costRowPricing({ costUsd: 2, unpricedTokens: undefined })).toBe('priced');
    expect(costRowPricing({ costUsd: 2, unpricedTokens: 0 })).toBe('priced');
    expect(costRowPricing({ costUsd: 2, unpricedTokens: 10 })).toBe('partial');
    expect(costRowPricing({ costUsd: 0, unpricedTokens: 10 })).toBe('unpriced');
    expect(compareRowPricing({ costPerCompletedUsd: 0.5, unpricedTasks: undefined })).toBe('priced');
    expect(compareRowPricing({ costPerCompletedUsd: null, unpricedTasks: 0 })).toBe('priced');
    expect(compareRowPricing({ costPerCompletedUsd: 0.5, unpricedTasks: 1 })).toBe('partial');
    expect(compareRowPricing({ costPerCompletedUsd: null, unpricedTasks: 2 })).toBe('unpriced');
    expect(unpricedCostTokens({ totals: { unpricedTokens: 7 }, byModel: [{ unpricedTokens: 3 }] })).toBe(7);
    expect(unpricedCostTokens({ totals: {}, byModel: [{ unpricedTokens: 3 }, {}, { unpricedTokens: 4 }] })).toBe(7);
    expect(unpricedCostTokens({ totals: {}, byModel: [] })).toBe(0);
  });
});

describe('ranking', () => {
  const rankRow = (key: string, label: string, costUsd: number, tasks: number) => ({
    key,
    label,
    tokens: tokens(costUsd * 100_000),
    costUsd,
    tasks,
  });

  beforeEach(() => {
    routes['GET /api/history/ranking'] = () => ({
      range: 'month',
      byAgent: [rankRow('Explore', 'Agente B', 2, 1), rankRow('tr-builder', 'Agente A', 5, 3)],
      byProject: [rankRow('proyecto-prueba', 'proyecto-prueba', 7, 4)],
    });
  });

  it('solo la tabla por agente, con el selector de periodo compartido y sin trofeo', async () => {
    const view = render(createElement(RankingTab));
    await flush();
    expect(view.querySelectorAll('[role="table"]')).toHaveLength(1);
    expect(view.textContent).not.toContain('proyecto-prueba');
    expect(view.textContent).not.toContain('Por proyecto');
    expect(view.querySelector('.lucide-trophy')).toBeNull();
    expect(view.querySelectorAll('[role="radiogroup"] [role="radio"]')).toHaveLength(4);
    const rows = Array.from(view.querySelectorAll('.rank-row:not(.ui-row--head)'));
    expect(rows.map((r) => r.querySelector('.rank-name')?.textContent)).toEqual(['Agente A', 'Agente B']);
    expect(rows[0]?.querySelector('[role="cell"]')?.textContent).toBe('1');
  });

  it('el gasto sale oculto, "Mostrar gasto" lo enciende y se recuerda hasta ocultarlo', async () => {
    const view = render(createElement(RankingTab));
    await flush();
    expect(view.textContent).not.toContain('$5,00');
    const toggle = byText(view, 'button', 'Mostrar gasto');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    await click(toggle);
    expect(view.textContent).toContain('$5,00');
    expect(byText(view, 'button', 'Ocultar gasto')?.getAttribute('aria-pressed')).toBe('true');
    // queda guardado en el navegador: una carga nueva lo lee encendido
    expect(window.localStorage.getItem('oficina.mostrar-gasto')).toBe('1');
    await click(byText(view, 'button', 'Ocultar gasto'));
    expect(window.localStorage.getItem('oficina.mostrar-gasto')).toBe('0');
  });

  it('sin preferencia guardada el gasto se ve; oculto solo si el usuario lo oculto', () => {
    window.localStorage.removeItem('oficina.mostrar-gasto');
    expect(readShowSpend()).toBe(true);
    window.localStorage.setItem('oficina.mostrar-gasto', '0');
    expect(readShowSpend()).toBe(false);
    window.localStorage.setItem('oficina.mostrar-gasto', '1');
    expect(readShowSpend()).toBe(true);
    window.localStorage.removeItem('oficina.mostrar-gasto');
  });
});

describe('tareas', () => {
  const task = (id: string, costUsd: number | null, endedAt: string) => ({
    id,
    roomId: 's1',
    roomTitle: 'proyecto-prueba',
    projectName: 'proyecto-prueba',
    kind: 'subagent' as const,
    agentType: 'tr-builder',
    displayName: 'Agente A',
    title: `Tarea ${id}`,
    startedAt: endedAt,
    endedAt,
    durationMs: 90_000,
    tokens: tokens(120_000),
    costUsd,
  });

  beforeEach(() => {
    const today = new Date();
    today.setHours(9, 0, 0, 0);
    const at = today.toISOString();
    routes['GET /api/history/tasks'] = (_, url) =>
      url.searchParams.get('cursor')
        ? { items: [task('t3', 0.75, at)], nextCursor: null }
        : { items: [task('t1', 1.5, at), task('t2', null, at)], nextCursor: 'c2' };
  });

  it('oculta tokens y USD por defecto y "Mostrar gasto" los muestra', async () => {
    const view = render(createElement(TasksTab));
    await flush();
    expect(view.querySelector('.day-total')?.textContent).toBe('2 tareas');
    expect(view.textContent).not.toContain('$1,50');
    expect(view.textContent).not.toContain('sin precio');
    expect(view.querySelector('.task-row.ui-row--head')?.textContent).not.toContain('USD');
    await click(byText(view, 'button', 'Mostrar gasto'));
    expect(view.querySelector('.day-total')?.textContent).toBe('2 tareas · $1,50');
    expect(view.textContent).toContain('$1,50');
    expect(view.textContent).toContain('sin precio');
    expect(view.querySelector('.task-row.ui-row--head')?.textContent).toContain('USD');
  });

  it('carga mas tareas con el cursor', async () => {
    const view = render(createElement(TasksTab));
    await flush();
    expect(view.querySelectorAll('li.task-row')).toHaveLength(2);
    await click(byText(view, 'button', 'Cargar más'));
    expect(view.querySelectorAll('li.task-row')).toHaveLength(3);
    expect(view.textContent).toContain('No hay más tareas');
  });
});

describe('comparador', () => {
  it('tabla de 6 columnas por modelo y rol, con/sin skill y flujos en una linea', async () => {
    const view = render(createElement(CompareTab));
    await flush();
    expect(view.querySelectorAll('.cmp-row--head [role="columnheader"]')).toHaveLength(6);
    const rows = view.querySelectorAll('.cmp-row:not(.cmp-row--head)');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Opus · Investigación');
    expect(rows[1]?.textContent).toContain('Sonnet · Desarrollo');
    // completadas en %: 4 de 5
    expect(rows[1]?.textContent).toContain('80 %');
    // lo que no entra en la tabla va en el title de la fila
    expect(rows[1]?.getAttribute('title')).toContain('Tests 4 · 75 %');
    expect(rows[1]?.textContent).not.toContain('4 · 75 %');
    expect(view.querySelector('.cmp-scroll')).toBeNull();
    const skill = view.querySelector('.cmp-skill');
    expect(skill?.textContent).toContain('Con skill');
    expect(skill?.textContent).toContain('Sin skill');
    expect(skill?.querySelectorAll('.ui-stat')).toHaveLength(6);
    expect(view.querySelector('.cmp-flows')?.textContent).toContain('3 corridas');
  });

  it('ya no muestra el aviso de ahorro ni "Ver hábitos" (eso vive en Hábitos)', async () => {
    const view = render(createElement(CompareTab));
    await flush();
    expect(view.textContent).not.toContain('ahorro potencial');
    expect(view.textContent).not.toContain('~$1,50');
    expect(byText(view, 'button', 'Ver hábitos')).toBeUndefined();
    expect(view.textContent).not.toContain('no personas');
  });

  it('$ / completada con tareas sin precio: "sin precio" si no queda promedio, marca si es parcial', async () => {
    const [first, second] = COMPARE.rows;
    if (!first || !second) throw new Error('faltan filas de prueba');
    routes['GET /api/history/compare'] = (): CompareResponse => ({
      ...COMPARE,
      rows: [
        { ...first, unpricedTasks: 1 },
        { ...second, costPerCompletedUsd: null, costUsd: 0, unpricedTasks: 3 },
      ],
    });
    const view = render(createElement(CompareTab));
    await flush();
    const rows = view.querySelectorAll('.cmp-row:not(.cmp-row--head)');
    // orden por rol: Investigacion (opus:explorer) primero, Desarrollo (sonnet:builder) despues
    const allUnpriced = rows[0]?.querySelectorAll('.cell-num--usd')[0];
    expect(allUnpriced?.textContent).toBe('sin precio');
    expect(allUnpriced?.className).toContain('cell-num--unpriced');
    const partial = rows[1]?.querySelectorAll('.cell-num--usd')[0];
    expect(partial?.textContent).toContain('$0,75');
    expect(partial?.querySelector('.unpriced-mark')?.getAttribute('title')).toBe('1 tarea sin precio no entra en el promedio');
  });

  it('sin tareas sin precio, un promedio vacio sigue siendo "—"', async () => {
    const view = render(createElement(CompareTab));
    await flush();
    const rows = view.querySelectorAll('.cmp-row:not(.cmp-row--head)');
    expect(rows[0]?.querySelectorAll('.cell-num--usd')[0]?.textContent).toBe('—');
    expect(view.querySelector('.unpriced-mark')).toBeNull();
  });
});

// ---- simulador y riesgo ----

describe('simulador', () => {
  it('estima p25..p75 por fila y deja fuera lo que no tiene historico', () => {
    const estimate = simulateScenario(
      [
        { id: 1, role: 'builder', family: 'opus', count: 2 },
        { id: 2, role: 'explorer', family: 'haiku', count: 3 },
      ],
      SIMULATOR.rows,
    );
    expect(estimate.lowUsd).toBeCloseTo(0.8);
    expect(estimate.midUsd).toBeCloseTo(1.2);
    expect(estimate.highUsd).toBeCloseTo(1.8);
    expect(estimate.pricedAgents).toBe(2);
    expect(estimate.missingLines).toBe(1);
    expect(scenarioRisk(estimate, 10)).toBe(riskOf(1.8, 10));
    expect(scenarioRisk({ highUsd: 0, pricedAgents: 0 }, 10)).toBeNull();
    expect(riskOf(0.9, 10)).toBe('low');
    expect(riskOf(2, 10)).toBe('medium');
    expect(riskOf(4, 10)).toBe('high');
    expect(riskOf(1, null)).toBeNull();
    expect(RISK_COLOR.low).toBe(STATE.done);
  });

  it('veredicto contra el tope por flujo: cabe, pasa el extremo alto o pasa la mediana', () => {
    const at = (midUsd: number, highUsd: number) => ({ midUsd, highUsd, pricedAgents: 1 });
    expect(simVerdict(at(0.6, 0.9), 2)).toEqual({ tone: 'ok', text: 'Cabe en el tope por flujo ($2,00).' });
    expect(simVerdict(at(1.8, 2.7), 2)).toEqual({ tone: 'warn', text: 'El extremo alto pasa el tope por flujo ($2,00).' });
    expect(simVerdict(at(3, 4.5), 2)?.tone).toBe('error');
    // regla apagada o sin agentes con historico: sin frase
    expect(simVerdict(at(3, 4.5), null)).toBeNull();
    expect(simVerdict({ midUsd: 0, highUsd: 0, pricedAgents: 0 }, 2)).toBeNull();
  });

  it('calcula el rango con una sola frase de veredicto y marca sin historico', async () => {
    const view = render(createElement(SimulatorTab));
    await flush();
    const result = view.querySelector('.sim-result');
    expect(result?.querySelector('.ui-stat--hero .ui-stat-value')?.textContent).toBe('~$0,40 – $0,90');
    expect(result?.querySelector('.ui-stat-sub')?.textContent).toBe('mediana ~$0,60 · 1 agente');
    expect(view.querySelector('.risk-chip')).toBeNull();
    expect(result?.querySelector('dl')).toBeNull();
    expect(result?.textContent).toContain('$10,00');
    const verdict = () => result?.querySelectorAll('.sim-verdict') ?? [];
    expect(verdict()).toHaveLength(1);
    expect(verdict()[0]?.textContent).toBe('Cabe en el tope por flujo ($2,00).');
    expect(verdict()[0]?.className).toContain('is-ok');

    await typeInto(view.querySelector('li.sim-line input'), '3');
    expect(result?.textContent).toContain('~$1,20 – $2,70');
    expect(verdict()[0]?.textContent).toBe('El extremo alto pasa el tope por flujo ($2,00).');
    expect(verdict()[0]?.className).toContain('is-warn');

    await typeInto(view.querySelector('li.sim-line input'), '5');
    expect(result?.textContent).toContain('~$2,00 – $4,50');
    expect(verdict()[0]?.className).toContain('is-error');

    expect(result?.textContent).not.toContain('sin histórico');
    await click(byText(view, 'button', 'Agregar fila'));
    const lines = view.querySelectorAll('li.sim-line');
    expect(lines).toHaveLength(2);
    await choose(lines[1]?.querySelectorAll('select')[0], 'explorer');
    await choose(lines[1]?.querySelectorAll('select')[1], 'haiku');
    expect(lines[1]?.textContent).toContain('sin histórico');
    expect(result?.textContent).toContain('1 fila sin histórico no entra.');
    // el historico va plegado
    const base = view.querySelector<HTMLDetailsElement>('details.sim-base');
    expect(base?.open).toBe(false);
    expect(base?.querySelector('summary')?.textContent).toBe('Histórico · 30 días');
    expect(base?.textContent).toContain('sin histórico');
    expect(view.textContent).not.toContain('es una estimación');
  });
});
