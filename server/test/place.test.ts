import { describe, expect, it } from 'vitest';
import { COFFEE_MS, placeOf, toolPlace, type LastAction, type PlaceInput } from '../src/state/place';

const NOW = Date.parse('2026-05-04T15:00:00.000Z');
const act = (tool: string, open = false, cmdClass: string | null = null): LastAction => ({ tool, open, cmdClass });
const working = (over: Partial<PlaceInput> = {}): PlaceInput => ({
  kind: 'subagent',
  status: 'working',
  role: 'builder',
  last: null,
  lastActivityMs: NOW,
  sessionOpen: true,
  now: NOW,
  ...over,
});

describe('toolPlace: lugar de cada herramienta', () => {
  it('escritorio: edicion, listas de tareas y desconocidas', () => {
    for (const t of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'HerramientaNueva']) {
      expect(toolPlace(t, null), t).toBe('desk');
    }
  });

  it('biblioteca: lectura, busqueda, web, skills y MCP', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch', 'LSP', 'mcp__servidor__consulta']) {
      expect(toolPlace(t, null), t).toBe('library');
    }
  });

  it('laboratorio: comandos; git de lectura va a la biblioteca', () => {
    for (const t of ['Bash', 'PowerShell', 'BashOutput', 'Monitor']) expect(toolPlace(t, null), t).toBe('lab');
    expect(toolPlace('Bash', 'test')).toBe('lab');
    expect(toolPlace('PowerShell', 'build')).toBe('lab');
    expect(toolPlace('Bash', 'git_read')).toBe('library');
    expect(toolPlace('PowerShell', 'git_read')).toBe('library');
  });

  it('reunion: lanzar, coordinar y detener agentes', () => {
    for (const t of ['Agent', 'Task', 'Workflow', 'SendMessage', 'TaskStop', 'ListAgents']) {
      expect(toolPlace(t, null), t).toBe('meeting');
    }
  });
});

describe('placeOf: precedencias', () => {
  it('puerta: pregunta o plan sin respuesta gana a todo, incluso al rol y al lead inactivo', () => {
    expect(placeOf(working({ role: 'reviewer', last: act('AskUserQuestion', true) }))).toBe('door');
    expect(placeOf(working({ kind: 'lead', role: 'orchestrator', status: 'idle', last: act('ExitPlanMode', true) }))).toBe('door');
    // ya respondida: vuelve al escritorio
    expect(placeOf(working({ last: act('AskUserQuestion', false) }))).toBe('desk');
    // un subagente que termino no se queda en la puerta
    expect(placeOf(working({ status: 'done', last: act('AskUserQuestion', true) }))).toBe('desk');
  });

  it('sesion cerrada con la pregunta sin respuesta: nadie espera en la puerta, el lead va al cafe o a dormir', () => {
    const closedLead = (lastActivityMs: number) =>
      placeOf(
        working({ kind: 'lead', role: 'orchestrator', status: 'idle', last: act('AskUserQuestion', true), lastActivityMs, sessionOpen: false }),
      );
    expect(closedLead(NOW - 60_000)).toBe('coffee');
    expect(closedLead(NOW - 2 * COFFEE_MS)).toBe('sleep');
    expect(placeOf(working({ last: act('ExitPlanMode', true), sessionOpen: false }))).toBe('desk');
  });

  it('rol fijo mientras trabaja: revision y seguridad a la mesa de revision, pruebas al laboratorio', () => {
    expect(placeOf(working({ role: 'reviewer', last: act('Read', true) }))).toBe('review');
    expect(placeOf(working({ role: 'security', last: act('Grep') }))).toBe('review');
    expect(placeOf(working({ role: 'tester', last: act('Edit') }))).toBe('lab');
    expect(placeOf(working({ role: 'tester' }))).toBe('lab');
  });

  it('ultima accion, abierta o cerrada; sin herramientas = escritorio (pensando)', () => {
    expect(placeOf(working({ last: act('Read', true) }))).toBe('library');
    expect(placeOf(working({ last: act('Read', false) }))).toBe('library');
    expect(placeOf(working({ last: act('Bash', false, 'git_read') }))).toBe('library');
    expect(placeOf(working({ role: 'explorer', last: act('Bash', true, 'test') }))).toBe('lab');
    expect(placeOf(working({ kind: 'lead', role: 'orchestrator', last: act('Workflow', true) }))).toBe('meeting');
    expect(placeOf(working({ last: null }))).toBe('desk');
  });

  it('el rol fijo solo cuenta trabajando', () => {
    expect(placeOf(working({ role: 'reviewer', status: 'done', last: act('Read') }))).toBe('desk');
  });

  it('lead inactivo: cafe menos de 10 min despues de su ultima linea, luego dormido', () => {
    const lead = (lastActivityMs: number | null) =>
      placeOf(working({ kind: 'lead', role: 'orchestrator', status: 'idle', last: act('Edit'), lastActivityMs }));
    expect(lead(NOW)).toBe('coffee');
    expect(lead(NOW - COFFEE_MS + 1)).toBe('coffee');
    expect(lead(NOW - COFFEE_MS)).toBe('sleep');
    expect(lead(NOW - 3 * 60 * 60_000)).toBe('sleep');
    expect(lead(null)).toBe('sleep');
  });
});
