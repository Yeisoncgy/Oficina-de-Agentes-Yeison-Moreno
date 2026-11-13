// @vitest-environment node
// Logica pura del HUD: no necesita DOM. En node, import.meta.url es file:// y se puede leer index.css
// (vitest reemplaza los imports de CSS, incluso con ?raw, por un string vacio).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  OfficeAgent,
  OfficeRoom,
  OfficeSnapshot,
  RankingRow,
  TaskRow,
  TokenBreakdown,
  TranscriptEntry,
  TranscriptResponse,
} from '@shared/contract';
import { agentBaseName } from '@shared/agents';
import { AGENT_COLOR, AGENT_LOOKS, DEFAULT_LOOK, FONTS, lookFor, PALETTE, STATE, UI } from '@/theme';
import { formatDayMonth, formatMonthLabel, formatPercent, formatTimeOfDay, formatWeekdayDate } from '@/lib/format';
import {
  budgetGauge,
  currentMonth,
  dailyPace,
  daysInMonth,
  filledSegments,
  flattenTaskPages,
  groupTasksByDay,
  monthDays,
  rankRows,
  shiftMonth,
} from '@/lib/history';
import { activityText, resolveSelection, roomStats, tokenSegments, workingAgentsCount } from '@/lib/office';
import { gridRuns, LOGO_GRID, spriteGrid } from '@/lib/sprite';
import {
  backoffDelay,
  connectionAfterFailure,
  isDemoMode,
  parseSnapshot,
  RECONNECT_MAX_MS,
} from '@/lib/stream';
import { mergeTranscriptPages, toTranscriptItem } from '@/lib/transcript';

// ---- datos sinteticos de prueba ----

const tokens = (partial: Partial<TokenBreakdown> = {}): TokenBreakdown => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  ...partial,
});

function agent(id: string, partial: Partial<OfficeAgent> = {}): OfficeAgent {
  return {
    id,
    kind: 'subagent',
    agentType: 'Explore',
    displayName: 'Elena',
    status: 'working',
    task: null,
    action: null,
    model: null,
    tokens: tokens(),
    costUsd: 0,
    deskIndex: 1,
    ...partial,
  };
}

function room(id: string, lead: OfficeAgent, subagents: OfficeAgent[] = []): OfficeRoom {
  return {
    id,
    projectName: 'proyecto-prueba',
    title: 'proyecto-prueba',
    cwd: '/tmp/proyecto-prueba',
    open: true,
    busy: true,
    lastActivityAt: '2026-09-27T12:00:00.000Z',
    lead,
    subagents,
    tokens: tokens(),
    costUsd: 0,
  };
}

function snapshot(rooms: OfficeRoom[], generatedAt = '2026-09-27T12:00:00.000Z'): OfficeSnapshot {
  return { generatedAt, leadRoomId: rooms[0]?.id ?? null, rooms, today: { costUsd: 0, tokens: tokens() } };
}

const localIso = (y: number, m: number, d: number, h = 12, min = 0, s = 0): string =>
  new Date(y, m - 1, d, h, min, s).toISOString();

// ---- stream ----

describe('stream', () => {
  it('reintenta con backoff 1 s -> 10 s', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(50)).toBe(RECONNECT_MAX_MS);
  });

  it('pasa de reconectando a sin conexion tras dos fallos', () => {
    expect(connectionAfterFailure(1)).toBe('connecting');
    expect(connectionAfterFailure(2)).toBe('offline');
  });

  it('detecta el modo demo en la URL', () => {
    expect(isDemoMode('?demo=1')).toBe(true);
    expect(isDemoMode('?x=2&demo=true')).toBe(true);
    expect(isDemoMode('?demo=0')).toBe(false);
    expect(isDemoMode('')).toBe(false);
  });

  it('valida el snapshot del SSE', () => {
    const snap = snapshot([]);
    expect(parseSnapshot(JSON.stringify(snap))).toEqual(snap);
    expect(parseSnapshot('{roto')).toBeNull();
    expect(parseSnapshot(JSON.stringify({ generatedAt: 'x' }))).toBeNull();
    expect(parseSnapshot(42)).toBeNull();
  });
});

// ---- presupuesto ----

describe('presupuesto', () => {
  it('va a buen ritmo', () => {
    const g = budgetGauge({ spentUsd: 100, projectedUsd: 300, budgetUsd: 500 });
    expect(g.tone).toBe('ok');
    expect(g.spentPct).toBeCloseTo(20);
    expect(g.projectedPct).toBeCloseTo(60);
    expect(g.budgetPct).toBeCloseTo(100);
    expect(g.usedRatio).toBeCloseTo(0.2);
    expect(g.remainingUsd).toBe(400);
    expect(g.projectedOverUsd).toBe(0);
  });

  it('avisa cuando la proyeccion pasa el presupuesto y reescala la pista', () => {
    const g = budgetGauge({ spentUsd: 200, projectedUsd: 620, budgetUsd: 500 });
    expect(g.tone).toBe('warn');
    expect(g.scaleMax).toBe(620);
    expect(g.projectedPct).toBeCloseTo(100);
    expect(g.budgetPct).toBeCloseTo((500 / 620) * 100);
    expect(g.projectedOverUsd).toBe(120);
  });

  it('marca el exceso', () => {
    const g = budgetGauge({ spentUsd: 510, projectedUsd: 700, budgetUsd: 500 });
    expect(g.tone).toBe('over');
    expect(g.remainingUsd).toBe(-10);
  });

  it('no produce NaN con datos vacios o raros', () => {
    const g = budgetGauge({ spentUsd: Number.NaN, projectedUsd: -3, budgetUsd: 0 });
    expect(g.tone).toBe('ok');
    expect(g.usedRatio).toBe(0);
    expect([g.spentPct, g.projectedPct, g.budgetPct].every(Number.isFinite)).toBe(true);
    const clamp = budgetGauge({ spentUsd: 50, projectedUsd: 10, budgetUsd: 500 });
    expect(clamp.projectedPct).toBeCloseTo(clamp.spentPct);
  });

  it('enciende segmentos sin perder los valores pequenos', () => {
    expect(filledSegments(0, 20)).toBe(0);
    expect(filledSegments(0.001, 20)).toBe(1);
    expect(filledSegments(0.5, 20)).toBe(10);
    expect(filledSegments(3, 20)).toBe(20);
    expect(filledSegments(Number.NaN, 20)).toBe(0);
  });

  it('arma todos los dias del mes', () => {
    const now = new Date(2026, 1, 10, 12).getTime();
    const days = monthDays(
      '2026-02',
      [
        { date: '2026-02-03', costUsd: 1.5 },
        { date: '2026-02-03', costUsd: 0.5 },
      ],
      now,
    );
    expect(days).toHaveLength(28);
    expect(days[2]?.costUsd).toBe(2);
    expect(days[9]?.isToday).toBe(true);
    expect(days[10]?.isFuture).toBe(true);
    expect(days[8]?.isFuture).toBe(false);
  });

  it('maneja meses y ritmo diario', () => {
    expect(daysInMonth('2024-02')).toBe(29);
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(currentMonth(new Date(2026, 8, 27).getTime())).toBe('2026-09');
    expect(dailyPace(500, '2026-09')).toBeCloseTo(500 / 30);
    expect(dailyPace(0, '2026-09')).toBe(0);
  });
});

// ---- ranking y tareas ----

describe('ranking', () => {
  const row = (key: string, costUsd: number, total: number): RankingRow => ({
    key,
    label: key,
    tokens: tokens({ total }),
    costUsd,
    tasks: 1,
  });

  it('ordena por USD con barra relativa al primero', () => {
    const ranked = rankRows([row('a', 2, 10), row('b', 8, 5), row('c', 4, 1)]);
    expect(ranked.map((r) => r.row.key)).toEqual(['b', 'c', 'a']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(ranked[0]?.share).toBe(1);
    expect(ranked[1]?.share).toBeCloseTo(0.5);
  });

  it('usa tokens cuando nadie tiene costo', () => {
    const ranked = rankRows([row('a', 0, 50), row('b', 0, 200)]);
    expect(ranked[0]?.row.key).toBe('b');
    expect(ranked[1]?.share).toBeCloseTo(0.25);
  });
});

describe('tareas', () => {
  const task = (id: string, endedAt: string, costUsd: number | null): TaskRow => ({
    id,
    roomId: 'r1',
    roomTitle: 'sala',
    projectName: 'proyecto',
    kind: 'subagent',
    agentType: 'Explore',
    displayName: 'Elena',
    title: `tarea ${id}`,
    startedAt: endedAt,
    endedAt,
    durationMs: 1000,
    tokens: tokens(),
    costUsd,
  });

  it('agrupa por dia local con Hoy / Ayer / fecha', () => {
    const now = new Date(2026, 8, 27, 15).getTime();
    const groups = groupTasksByDay(
      [
        task('1', localIso(2026, 9, 27, 10), 1),
        task('2', localIso(2026, 9, 27, 9), null),
        task('3', localIso(2026, 9, 26, 22), 0.5),
        task('4', localIso(2026, 9, 20, 8), 2),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(['Hoy', 'Ayer', '20 sep']);
    expect(groups[0]?.items).toHaveLength(2);
    expect(groups[0]?.costUsd).toBe(1);
  });

  it('no repite tareas entre paginas', () => {
    const a = task('1', localIso(2026, 9, 27), 1);
    const b = task('2', localIso(2026, 9, 27), 1);
    expect(flattenTaskPages([{ items: [a, b], nextCursor: 'x' }, { items: [b], nextCursor: null }])).toEqual([a, b]);
  });
});

// ---- transcript ----

describe('transcript', () => {
  const entry = (id: string, partial: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
    id,
    timestamp: '2026-09-27T12:00:00.000Z',
    kind: 'text',
    text: id,
    ...partial,
  });
  const page = (entries: TranscriptEntry[], nextCursor: string | null): TranscriptResponse => ({
    agentId: 'a1',
    entries,
    nextCursor,
  });

  it('une paginas (nueva primero) en orden cronologico y sin duplicados', () => {
    const merged = mergeTranscriptPages([
      page([entry('e3'), entry('e4')], 'c1'),
      page([entry('e1'), entry('e2'), entry('e3')], null),
    ]);
    expect(merged.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('resume cada entrada para el visor', () => {
    const item = toTranscriptItem(entry('t1', { kind: 'tool_result', text: '\n   primera linea  \nsegunda\n\n' }));
    expect(item.preview).toBe('primera linea');
    expect(item.lineCount).toBe(3);
    expect(item.long).toBe(false);
    expect(item.isError).toBe(false);
    expect(item.toolName).toBeNull();

    const long = toTranscriptItem(entry('t2', { text: 'x'.repeat(700), isError: true, toolName: 'Bash' }));
    expect(long.long).toBe(true);
    expect(long.isError).toBe(true);
    expect(long.toolName).toBe('Bash');
    expect(long.preview.length).toBeLessThanOrEqual(140);
    expect(long.preview.endsWith('…')).toBe(true);
  });
});

// ---- oficina ----

describe('oficina', () => {
  const lead = agent('lead-1', { kind: 'lead', agentType: 'lead', displayName: 'Ana', status: 'idle' });

  it('cuenta quien trabaja y quien sigue en la sala', () => {
    const r = room('r1', lead, [agent('s1'), agent('s2', { status: 'done' }), agent('s3', { status: 'idle' })]);
    expect(roomStats(r)).toEqual({ working: 1, present: 3 });
    expect(workingAgentsCount(snapshot([r]))).toBe(1);
    expect(workingAgentsCount(null)).toBe(0);
  });

  it('describe la actividad en una linea', () => {
    expect(activityText(agent('a', { status: 'working' }))).toBe('Pensando');
    expect(
      activityText(agent('a', { action: { tool: 'Edit', label: 'Editando server.ts', startedAt: '2026-09-27T12:00:00Z' } })),
    ).toBe('Editando server.ts');
    expect(activityText(lead)).toBe('Esperando el siguiente prompt');
    expect(activityText(agent('a', { status: 'done' }))).toBe('Terminó su tarea');
  });

  it('reparte los tokens en proporciones del total', () => {
    const segments = tokenSegments(tokens({ input: 10, output: 30, cacheRead: 50, cacheWrite: 10, total: 100 }));
    expect(segments.map((s) => s.key)).toEqual(['input', 'output', 'cacheRead', 'cacheWrite']);
    expect(segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1);
    expect(segments[2]?.share).toBeCloseTo(0.5);
    expect(tokenSegments(tokens()).every((s) => s.share === 0)).toBe(true);
  });

  it('conserva al agente seleccionado cuando sale del snapshot', () => {
    const sub = agent('s1', { action: { tool: 'Read', label: 'Leyendo a.ts', startedAt: '2026-09-27T12:00:00Z' } });
    const first = resolveSelection('s1', snapshot([room('r1', lead, [sub])]), null);
    expect(first?.gone).toBe(false);
    expect(first?.lastSeenAt).toBe('2026-09-27T12:00:00.000Z');

    const later = snapshot([room('r1', lead, [])], '2026-09-27T12:00:05.000Z');
    const gone = resolveSelection('s1', later, first);
    expect(gone?.gone).toBe(true);
    expect(gone?.agent.status).toBe('done');
    expect(gone?.agent.action).toBeNull();
    expect(gone?.lastSeenAt).toBe('2026-09-27T12:00:00.000Z');
    expect(resolveSelection('s1', later, gone)).toBe(gone);

    expect(resolveSelection('otro', later, gone)).toBeNull();
    expect(resolveSelection(null, later, gone)).toBeNull();
  });
});

// ---- sprites ----

describe('sprites', () => {
  it('dibuja un busto chibi 16x16 con la camiseta y el casco ambar de Bruno', () => {
    const look = lookFor('tr-builder');
    const grid = spriteGrid(look);
    expect(grid).toHaveLength(16);
    expect(grid.every((row) => row.length === 16)).toBe(true);
    expect(grid[15]?.[7]).toBe(look.shirt);
    expect(grid[1]?.[6]).toBe(PALETTE.amber);
    // contorno de tinta alrededor de la silueta
    expect(grid[0]?.[3]).toBe(PALETTE.ink);
  });

  it('funciona para todos los looks, incluido el de tipos desconocidos', () => {
    for (const look of [...Object.values(AGENT_LOOKS), DEFAULT_LOOK]) {
      const grid = spriteGrid(look);
      expect(grid.flat().every((c) => c === null || /^#[0-9A-F]{6}$/i.test(c))).toBe(true);
    }
  });

  it('une pixeles contiguos en tiras', () => {
    const runs = gridRuns([
      ['#000000', '#000000', '#000000', null],
      [null, '#111111', '#222222', '#222222'],
    ]);
    expect(runs).toEqual([
      { x: 0, y: 0, w: 3, color: '#000000' },
      { x: 1, y: 1, w: 1, color: '#111111' },
      { x: 2, y: 1, w: 2, color: '#222222' },
    ]);
    expect(LOGO_GRID).toHaveLength(17);
    expect(LOGO_GRID.every((row) => row.length === 20)).toBe(true);
    // silueta simetrica: la abeja mira de frente (el brillo de los ojos va del mismo lado en los dos, a proposito)
    const filled = (c: string | null | undefined) => c !== null && c !== undefined;
    expect(LOGO_GRID.every((row) => row.every((c, x) => filled(c) === filled(row[row.length - 1 - x])))).toBe(true);
  });
});

// ---- formato ----

describe('formato', () => {
  it('fechas y horas locales en espanol', () => {
    expect(formatMonthLabel('2026-09')).toBe('Septiembre 2026');
    expect(formatMonthLabel('basura')).toBe('basura');
    expect(formatTimeOfDay(new Date(2026, 8, 27, 9, 5, 3).getTime(), true)).toBe('09:05:03');
    expect(formatTimeOfDay('no-es-fecha')).toBe('--:--');
    expect(formatDayMonth(new Date(2025, 8, 20).getTime(), new Date(2026, 0, 1).getTime())).toBe('20 sep 2025');
    expect(formatWeekdayDate(new Date(2026, 8, 27).getTime())).toBe('dom 27 sep');
  });

  it('porcentajes', () => {
    expect(formatPercent(0.247)).toBe('24,7 %');
    expect(formatPercent(1.3)).toBe('130 %');
    expect(formatPercent(0)).toBe('0 %');
  });
});

// ---- CSS espejo del tema ----

describe('index.css', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const kebab = (key: string) => key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);

  const expectToken = (name: string, value: string) => {
    const escaped = value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    expect(css, `falta ${name}: ${value}`).toMatch(new RegExp(`${name}:\\s*${escaped};`, 'i'));
  };

  it('replica los 20 colores de la escena (D4) como tokens de Tailwind', () => {
    const scene = [
      'ink', 'night', 'indigo', 'dusk', 'lavender', 'wall', 'moon', 'cream', 'amber', 'ember',
      'walnut', 'honey', 'plum', 'leaf', 'moss', 'cyan', 'teal', 'neon', 'skinLight', 'skinDark',
    ] as const;
    for (const key of scene) expectToken(`--color-scene-${kebab(key)}`, PALETTE[key]);
  });

  it('replica los tokens de interfaz, estados y agentes (D2)', () => {
    for (const [key, value] of Object.entries(UI)) expectToken(`--color-${kebab(key)}`, value);
    for (const [key, value] of Object.entries(STATE)) expectToken(`--color-state-${kebab(key)}`, value);
    for (const [type, value] of Object.entries(AGENT_COLOR)) {
      // el lead no lleva su nombre en el token: lo elige cada usuario
      expectToken(`--color-agent-${type === 'lead' ? 'lead' : agentBaseName(type).toLowerCase()}`, value);
    }
  });

  it('replica las fuentes', () => {
    expect(css).toContain(`--font-display: ${FONTS.display};`);
    expect(css).toContain(`--font-body: ${FONTS.body};`);
    expect(css).toContain(`--font-mono: ${FONTS.mono};`);
  });
});
