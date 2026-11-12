// @vitest-environment node
// Rediseno "Estudio nocturno": elenco, contraste, tiempos (D5) y logica pura nueva del HUD.
import { describe, expect, it } from 'vitest';
import type { OfficeAgent, OfficeRoom, TokenBreakdown } from '@shared/contract';
import {
  capitalize,
  formatDayRange,
  formatMonthShort,
  formatUsdOrUnpriced,
  formatWeekdayDateLong,
} from '@/lib/format';
import { budgetTrack, chartScale, rangeCaption } from '@/lib/history';
import { cardEnterDelay, exitDuration, phaseDelay, rowEnterDelay } from '@/lib/motion';
import {
  actionView,
  formatAgo,
  formatLastActivity,
  roomState,
  roomStatusText,
  tokenSegments,
  toolKind,
} from '@/lib/office';
import { contrastRatio, mixHex, shadeHex, spriteGrid } from '@/lib/sprite';
import { currentToolId, resultSummary } from '@/lib/transcript';
import {
  AGENT_COLOR,
  AGENT_LOOKS,
  agentColor,
  DEFAULT_AGENT_COLOR,
  DEFAULT_LOOK,
  DURATION,
  lookFor,
  PALETTE,
  STATE,
  STATUS_COLOR,
  UI,
} from '@/theme';

const tokens = (partial: Partial<TokenBreakdown> = {}): TokenBreakdown => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  ...partial,
});

function agent(partial: Partial<OfficeAgent> = {}): OfficeAgent {
  return {
    id: 'a1',
    kind: 'subagent',
    agentType: 'Explore',
    displayName: 'Agente de prueba',
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

const local = (y: number, m: number, d: number, h = 12, min = 0): number => new Date(y, m - 1, d, h, min).getTime();

describe('elenco del kit 3D', () => {
  it('usa los colores exactos del CAST de D4', () => {
    expect(AGENT_LOOKS.lead).toMatchObject({ shirt: '#D9673B', pants: '#232553', hair: '#232553', skin: '#F2C19B', accessory: 'hoodie' });
    expect(AGENT_LOOKS['tr-builder']).toMatchObject({ shirt: '#2FA6A6', pants: '#3A3F7A', hair: '#6E4632', skin: '#F2C19B', accessory: 'hardhat' });
    expect(AGENT_LOOKS.Explore).toMatchObject({ shirt: '#F07BA8', accessory: 'backpack', hairStyle: 'ponytail' });
    expect(AGENT_LOOKS['tr-explorer']).toMatchObject({ shirt: '#5E9A5F', pants: '#6E4632', accessory: 'explorer-hat' });
    expect(AGENT_LOOKS['tr-docs']).toMatchObject({ shirt: '#9A96C4', pants: '#7A3E63', hair: '#D9673B', accessory: 'glasses' });
    expect(AGENT_LOOKS.Plan).toMatchObject({ shirt: '#7A3E63', accessory: 'clipboard', hairStyle: 'bun' });
    expect(AGENT_LOOKS['general-purpose']).toMatchObject({ shirt: '#2C5446', accessory: 'headphones', hairStyle: 'buzz' });
    expect(AGENT_LOOKS['claude-code-guide']).toMatchObject({ shirt: '#FFE3B0', hair: '#9A96C4', accessory: 'bowtie' });
    expect(lookFor('tipo-desconocido')).toBe(DEFAULT_LOOK);
    expect(DEFAULT_LOOK).toMatchObject({ shirt: '#6B5E9E', accessory: 'badge' });
  });

  it('cada retrato usa la camiseta del personaje y tiene la silueta de su rasgo', () => {
    for (const look of [...Object.values(AGENT_LOOKS), DEFAULT_LOOK]) {
      const colors = new Set(spriteGrid(look).flat());
      expect(colors.has(look.shirt)).toBe(true);
      expect(colors.has(look.skin)).toBe(true);
    }
    // Elena: tirantes de la mochila en su acento
    expect(spriteGrid(AGENT_LOOKS.Explore!)[13]?.[5]).toBe(shadeHex(PALETTE.amber, 0.8));
    // Gael: audifonos con copas neon
    expect(spriteGrid(AGENT_LOOKS['general-purpose']!)[7]?.[1]).toBe(PALETTE.neon);
  });

  it('el retrato de Bruno: casco ambar, ojos grandes, chaleco con franja y contorno de tinta', () => {
    const look = AGENT_LOOKS['tr-builder']!;
    const legend = new Map<string, string>([
      [PALETTE.ink, 'K'],
      [PALETTE.amber, 'A'],
      [mixHex(PALETTE.amber, '#FFFFFF', 0.3), 'a'],
      [mixHex(PALETTE.amber, '#FFFFFF', 0.25), 'L'],
      [shadeHex(PALETTE.amber, 0.85), 'b'],
      [look.hair, 'H'],
      [look.skin, 'S'],
      [PALETTE.cream, 'W'],
      [mixHex(look.skin, PALETTE.neon, 0.5), 'B'],
      [shadeHex(look.skin, 0.45), 'M'],
      [look.shirt, 'T'],
      [shadeHex(look.shirt, 0.72), 'D'],
    ]);
    const ascii = spriteGrid(look).map((row) => row.map((c) => (c === null ? '.' : (legend.get(c) ?? '?'))).join(''));
    expect(ascii).toEqual([
      '...KKKKLLKKKK...',
      '..KAaaAAAAAAAK..',
      '..KAAAAAAAAAAK..',
      '.KbbbbbbbbbbbbK.',
      '.KHHHHSSSSSSSHK.',
      '.KHSSSSSSSSSSHK.',
      '.KHSWKSSSSWKSHK.',
      '..KSKKSSSSKKSK..',
      '..KSBSSSSSSBSK..',
      '..KSSSSMMSSSSK..',
      '...KSSSSSSSSK...',
      '...KTTTSSTTTK...',
      '..KTTTTTTTTTTK..',
      '.KTTDTTTTTTDTTK.',
      '.KWWWWWWWWWWWWK.',
      '.KTTDTTTTTTDTTK.',
    ]);
  });

  it('mezcla y sombrea colores como el kit', () => {
    expect(shadeHex('#FFFFFF', 0.5)).toBe('#808080');
    expect(mixHex('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });
});

describe('contraste AA sobre el panel', () => {
  const panel = UI.panel;
  it('texto de interfaz, estados y agentes pasan 4,5:1', () => {
    for (const color of [UI.text, UI.textSecondary, UI.textMuted, UI.accent]) {
      expect(contrastRatio(color, panel)).toBeGreaterThanOrEqual(4.5);
    }
    for (const color of Object.values(STATE)) expect(contrastRatio(color, panel)).toBeGreaterThanOrEqual(4.5);
    for (const color of [...Object.values(AGENT_COLOR), DEFAULT_AGENT_COLOR]) {
      expect(contrastRatio(color, panel)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('la tinta se lee sobre el ambar (boton primario y DEMO)', () => {
    expect(contrastRatio(UI.onAccent, UI.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('los estados de la escena salen de D2', () => {
    expect(STATUS_COLOR).toEqual({ working: '#6FF0E4', idle: '#9A96C4', done: '#89E29D' });
    expect(agentColor('lead')).toBe('#F08D6A');
    expect(agentColor('tipo-desconocido')).toBe(DEFAULT_AGENT_COLOR);
  });
});

describe('movimiento (D5)', () => {
  it('tarjetas: 240 ms + 60 ms por tarjeta solo durante la entrada', () => {
    expect(cardEnterDelay(0, 0)).toBe(240);
    expect(cardEnterDelay(3, 200)).toBe(420);
    expect(cardEnterDelay(40, 200)).toBe(900);
    expect(cardEnterDelay(2, 5_000)).toBe(0);
  });

  it('filas del historial: 80 ms + 35 ms por fila, con tope', () => {
    expect(rowEnterDelay(0)).toBe(80);
    expect(rowEnterDelay(2)).toBe(150);
    expect(rowEnterDelay(99)).toBe(rowEnterDelay(12));
  });

  it('LED en fase con el reloj y salidas de 120 ms con movimiento reducido', () => {
    expect(phaseDelay(1200, 2500)).toBe('-100ms');
    expect(exitDuration(DURATION.drawerOut, false)).toBe(220);
    expect(exitDuration(DURATION.drawerOut, true)).toBe(120);
  });
});

describe('panel del agente', () => {
  it('describe la fila de accion segun el estado', () => {
    const tool = actionView(
      agent({ action: { tool: 'Edit', label: 'Editando server.ts', startedAt: '2026-09-28T10:00:00Z' } }),
      false,
      null,
    );
    expect(tool).toMatchObject({ kind: 'tool', label: 'Editando server.ts', tool: 'Edit' });
    expect(actionView(agent(), false, null)).toMatchObject({ kind: 'thinking', label: 'Pensando' });
    expect(actionView(agent({ status: 'idle' }), false, null).label).toBe('Sin acción en curso');
    expect(actionView(agent({ status: 'idle', kind: 'lead' }), false, null).label).toBe('Esperando el siguiente prompt');
    const done = actionView(agent({ status: 'done' }), false, new Date(2026, 8, 28, 22, 7).toISOString());
    expect(done).toMatchObject({ kind: 'done', label: 'Terminó a las 22:07' });
    expect(actionView(agent(), true, null).kind).toBe('done');
  });

  it('cambia la clave cuando llega una accion nueva', () => {
    const a = actionView(agent({ action: { tool: 'Read', label: 'Leyendo a.ts', startedAt: '2026-09-28T10:00:00Z' } }), false, null);
    const b = actionView(agent({ action: { tool: 'Read', label: 'Leyendo b.ts', startedAt: '2026-09-28T10:00:05Z' } }), false, null);
    expect(a.key).not.toBe(b.key);
  });

  it('elige el icono por familia de herramienta', () => {
    expect(toolKind('Read')).toBe('read');
    expect(toolKind('MultiEdit')).toBe('edit');
    expect(toolKind('Write')).toBe('write');
    expect(toolKind('Bash')).toBe('shell');
    expect(toolKind('Grep')).toBe('search');
    expect(toolKind('Agent')).toBe('agent');
    expect(toolKind('WebFetch')).toBe('web');
    expect(toolKind('TodoWrite')).toBe('todo');
    expect(toolKind('mcp__algo')).toBe('other');
  });

  it('barras de tokens relativas al mayor', () => {
    const segments = tokenSegments(tokens({ input: 10, output: 5, cacheRead: 40, cacheWrite: 0, total: 55 }));
    expect(segments.map((s) => s.ofMax)).toEqual([0.25, 0.125, 1, 0]);
    expect(segments.map((s) => s.short)).toEqual(['Entrada', 'Salida', 'Caché L', 'Caché E']);
  });

  it('resume resultados y marca la herramienta en curso', () => {
    expect(resultSummary({ isError: false, preview: 'x', lineCount: 412 })).toBe('Resultado · 412 líneas');
    expect(resultSummary({ isError: true, preview: 'código de salida 1', lineCount: 3 })).toBe('Error · código de salida 1');
    expect(resultSummary({ isError: false, preview: '', lineCount: 0 })).toBe('Resultado · vacío');
    const items = [
      { id: '1', kind: 'prompt' as const },
      { id: '2', kind: 'tool_use' as const },
    ];
    expect(currentToolId(items, true)).toBe('2');
    expect(currentToolId(items, false)).toBeNull();
    expect(currentToolId([...items, { id: '3', kind: 'tool_result' as const }], true)).toBeNull();
  });
});

describe('lista de salas', () => {
  const room = (partial: Partial<OfficeRoom>): OfficeRoom => ({
    id: 'r1',
    projectName: 'proyecto-prueba',
    title: 'proyecto-prueba',
    cwd: '/tmp/proyecto-prueba',
    open: true,
    busy: false,
    lastActivityAt: new Date(local(2026, 9, 28, 21, 12)).toISOString(),
    lead: agent({ id: 'l', kind: 'lead', agentType: 'lead', status: 'idle' }),
    subagents: [],
    tokens: tokens(),
    costUsd: 0,
    ...partial,
  });

  it('muestra cuantos trabajan o el estado y hace cuanto fue la ultima actividad', () => {
    const now = local(2026, 9, 28, 22, 0);
    expect(roomStatusText(room({}), now)).toBe('Inactiva · hace 48 min');
    expect(roomStatusText(room({}), local(2026, 9, 28, 21, 20))).toBe('En espera · hace 8 min');
    expect(roomStatusText(room({ subagents: [agent(), agent({ id: 'a2' })] }), now)).toBe('Trabajando · 2 agentes');
  });

  it('la sala queda inactiva sin trabajo ni actividad en 15 min, o cerrada', () => {
    const at = local(2026, 9, 28, 21, 12);
    expect(roomState(room({}), at + 14 * 60_000)).toBe('waiting');
    expect(roomState(room({}), at + 15 * 60_000)).toBe('inactive');
    expect(roomState(room({ open: false }), at + 60_000)).toBe('closed');
    expect(roomState(room({ subagents: [agent()] }), at + 3 * 3_600_000)).toBe('working');
    expect(roomState(room({ busy: true }), at + 3 * 3_600_000)).toBe('working');
  });

  it('dice hace cuanto fue la ultima actividad', () => {
    const at = local(2026, 9, 28, 21, 12);
    const iso = new Date(at).toISOString();
    expect(formatAgo(iso, at + 30_000)).toBe('ahora');
    expect(formatAgo(iso, at + 12 * 60_000)).toBe('hace 12 min');
    expect(formatAgo(iso, at + 3 * 3_600_000)).toBe('hace 3 h');
    expect(formatAgo(iso, local(2026, 9, 29, 10))).toBe('ayer 21:12');
  });

  it('formatea la ultima actividad de hoy, ayer y antes', () => {
    const now = local(2026, 9, 28, 10);
    expect(formatLastActivity(new Date(local(2026, 9, 27, 19, 40)).toISOString(), now)).toBe('ayer 19:40');
    expect(formatLastActivity(new Date(local(2026, 9, 20, 8)).toISOString(), now)).toBe('20 sep');
    expect(formatLastActivity('basura', now)).toBe('—');
  });
});

describe('historial', () => {
  it('pista del presupuesto relativa al presupuesto, con la proyeccion topada', () => {
    expect(budgetTrack({ spentUsd: 100, projectedUsd: 300, budgetUsd: 500 })).toEqual({ spentPct: 20, projectedPct: 60, over: false });
    expect(budgetTrack({ spentUsd: 452, projectedUsd: 620, budgetUsd: 500 })).toMatchObject({ projectedPct: 100, over: true });
    expect(budgetTrack({ spentUsd: 5, projectedUsd: 9, budgetUsd: 0 })).toEqual({ spentPct: 0, projectedPct: 0, over: false });
  });

  it('escala del grafico con pasos redondos a 0 %, 40 % y 80 %', () => {
    expect(chartScale(21.4)).toEqual({ max: 25, ticks: [0, 10, 20] });
    expect(chartScale(4.1)).toEqual({ max: 5, ticks: [0, 2, 4] });
    const big = chartScale(180);
    expect(big.max).toBeGreaterThanOrEqual(180);
    expect(big.ticks[2]).toBeCloseTo(big.max * 0.8);
    expect(Number.isFinite(chartScale(0).max)).toBe(true);
  });

  it('rotula el periodo del ranking', () => {
    const now = local(2026, 9, 28);
    expect(rangeCaption('today', now)).toBe('Lunes 28 sep');
    expect(rangeCaption('week', now)).toBe('22 – 28 sep');
    expect(rangeCaption('month', now)).toBe('Septiembre 2026');
    expect(rangeCaption('all', now)).toBe('Todo el historial');
    expect(rangeCaption('week', local(2026, 10, 2))).toBe('26 sep – 2 oct');
  });
});

describe('formato nuevo', () => {
  it('meses cortos, dias largos y montos sin precio', () => {
    expect(formatMonthShort('2026-09')).toBe('Sep');
    expect(formatMonthShort('basura')).toBe('basura');
    expect(formatWeekdayDateLong(local(2026, 9, 28))).toBe('lunes 28 sep');
    expect(formatDayRange(local(2026, 9, 22), local(2026, 9, 28))).toBe('22 – 28 sep');
    expect(formatUsdOrUnpriced(null)).toBe('sin precio');
    expect(formatUsdOrUnpriced(0.94)).toBe('$0,94');
    expect(capitalize('lunes')).toBe('Lunes');
  });
});
