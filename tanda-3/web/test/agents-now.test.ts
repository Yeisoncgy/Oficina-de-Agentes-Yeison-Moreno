// "Agentes ahora" (L): quien entra a la tabla, en que orden y como se suma el costo. Solo datos sinteticos.
import { describe, expect, it } from 'vitest';
import type { OfficeAgent, OfficeRoom, OfficeSnapshot, TokenBreakdown } from '@shared/contract';
import { agentsNow } from '@/lib/agentsNow';
import { letterAction } from '@/lib/workflows';

const tokens = (): TokenBreakdown => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function agent(id: string, partial: Partial<OfficeAgent> = {}): OfficeAgent {
  return {
    id,
    kind: 'subagent',
    agentType: 'tr-builder',
    displayName: id,
    status: 'working',
    task: { title: `tarea de ${id}`, startedAt: '2026-09-28T19:50:00Z', endedAt: null },
    action: { tool: 'Edit', label: 'Editando a.ts', startedAt: '2026-09-28T19:59:00Z' },
    model: 'claude-sonnet-5-5',
    tokens: tokens(),
    costUsd: 1,
    deskIndex: 1,
    ...partial,
  };
}

function room(id: string, slot: number, lead: Partial<OfficeAgent>, subagents: OfficeAgent[] = []): OfficeRoom {
  return {
    id,
    projectName: `proyecto-${id}`,
    title: `Sala ${id}`,
    cwd: `/tmp/${id}`,
    open: true,
    busy: true,
    lastActivityAt: '2026-09-28T19:59:00Z',
    lead: agent(id, { kind: 'lead', agentType: 'lead', displayName: `Lider ${id}`, deskIndex: 0, ...lead }),
    subagents,
    tokens: tokens(),
    costUsd: 0,
    slot,
  };
}

function snapshot(rooms: OfficeRoom[]): OfficeSnapshot {
  return {
    generatedAt: '2026-09-28T20:00:00Z',
    leadRoomId: null,
    rooms,
    today: { costUsd: 0, tokens: tokens() },
  };
}

describe('agentes ahora', () => {
  it('sin snapshot o sin nadie trabajando, la tabla queda vacia', () => {
    expect(agentsNow(null).rows).toEqual([]);
    const quiet = snapshot([room('r1', 0, { status: 'idle' }, [agent('s1', { status: 'done' })])]);
    expect(agentsNow(quiet)).toMatchObject({ rows: [], working: 0, waiting: 0, costUsd: 0 });
  });

  it('entran los que trabajan y los que esperan respuesta; inactivos y terminados no', () => {
    const view = agentsNow(
      snapshot([
        room('r1', 0, { status: 'idle' }, [agent('s1'), agent('s2', { status: 'idle' }), agent('s3', { status: 'done' })]),
        room('r2', 1, { status: 'working', place: 'door' }),
      ]),
    );
    expect(view.rows.map((r) => r.agentId)).toEqual(['r2', 's1']);
    expect(view).toMatchObject({ working: 1, waiting: 1 });
    expect(view.rows[0]).toMatchObject({ state: 'waiting', doing: 'Espera tu respuesta', lead: true });
    expect(view.rows[1]).toMatchObject({ state: 'working', doing: 'Editando a.ts', task: 'tarea de s1' });
  });

  it('una sala cerrada no cuenta como espera, aunque su ultimo lugar fuera la puerta', () => {
    const closed = { ...room('r1', 0, { status: 'idle', place: 'door' }), open: false };
    expect(agentsNow(snapshot([closed])).rows).toEqual([]);
  });

  it('orden: espera tu respuesta, luego alertas, luego por numero de sala con el lider primero', () => {
    const view = agentsNow(
      snapshot([
        room('b', 1, {}, [agent('b1', { alert: { level: 'critical', title: 'Costo alto', source: 'rule' } })]),
        room('a', 0, {}, [agent('a1')]),
        room('c', 2, { place: 'door' }),
      ]),
    );
    expect(view.rows.map((r) => r.agentId)).toEqual(['c', 'b1', 'a', 'a1', 'b']);
    expect(view.rows.find((r) => r.agentId === 'a')).toMatchObject({ roomNumber: 1, roomTitle: 'Sala a' });
  });

  it('sin accion dice Pensando; sin tarea usa la etiqueta del flujo o lo dice', () => {
    const view = agentsNow(
      snapshot([
        room('r1', 0, { status: 'idle' }, [
          agent('s1', { action: null, task: null }),
          agent('s2', {
            task: null,
            workflow: { runId: 'w', name: 'w', phase: null, label: 'Revisar contrato', sourceType: 'x', role: 'reviewer' },
          }),
        ]),
      ]),
    );
    expect(view.rows[0]).toMatchObject({ doing: 'Pensando', task: 'Sin tarea asignada', since: null });
    expect(view.rows[1]).toMatchObject({ task: 'Revisar contrato' });
  });

  it('suma lo que tiene precio y cuenta aparte lo que no', () => {
    const view = agentsNow(
      snapshot([room('r1', 0, { costUsd: 0.5 }, [agent('s1', { costUsd: 1.25 }), agent('s2', { costUsd: null })])]),
    );
    expect(view.costUsd).toBeCloseTo(1.75);
    expect(view.unpriced).toBe(1);
    expect(view.rows.find((r) => r.agentId === 's2')?.costUsd).toBeNull();
  });

  it('L abre o cierra la tabla, tambien con el historial abierto', () => {
    expect(letterAction('l', { historyOpen: false, historyTab: 'budget' })).toBe('toggle-agents');
    expect(letterAction('L', { historyOpen: true, historyTab: 'habits' })).toBe('toggle-agents');
  });
});
