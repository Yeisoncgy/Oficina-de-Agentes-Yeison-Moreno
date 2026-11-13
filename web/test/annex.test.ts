import { describe, expect, it } from 'vitest';
import type { AgentPlace, OfficeAgent, OfficeRoom } from '@shared/contract';
import { annexId, annexIndexOf, annexOfPlacement, annexesNeeded, homeOf, localDesk, mapIds, ownerOf } from '@/scene/annex';
import { createCrew, reconcileCrew } from '@/scene/crew';
import { assignSlots, computeLayout, seatNode } from '@/scene/layout';
import { plaqueSignals } from '@/scene/Room';

const sub = (deskIndex: number) => ({ deskIndex }) as OfficeAgent;

const agent = (id: string, deskIndex: number, place?: AgentPlace, status: OfficeAgent['status'] = 'working'): OfficeAgent => ({
  id,
  kind: 'subagent',
  agentType: 'Explore',
  displayName: `Agente ${id}`,
  status,
  task: null,
  action: { tool: 'Read', label: 'Leyendo un archivo de prueba', startedAt: new Date(0).toISOString() },
  model: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  costUsd: 0,
  deskIndex,
  ...(place ? { place } : {}),
});

const roomWith = (subagents: OfficeAgent[], id = 'r1'): OfficeRoom => ({
  id,
  projectName: 'demo',
  title: 'demo',
  cwd: '/demo',
  open: true,
  busy: true,
  lastActivityAt: new Date(0).toISOString(),
  lead: { ...agent('lead', 0), kind: 'lead', agentType: 'lead' },
  subagents,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  costUsd: 0,
});

const placedOf = (rooms: readonly OfficeRoom[]): Set<string> =>
  new Set(computeLayout(assignSlots(new Map(), mapIds(rooms))).rooms.map((r) => r.id));

describe('anexos de sala', () => {
  it('puestos 1-6 en la sala, 7-12 en el anexo 1, 13-18 en el 2 y 19-24 en el 3', () => {
    expect([1, 6, 7, 12, 13, 19, 24].map(annexIndexOf)).toEqual([0, 0, 1, 1, 2, 3, 3]);
    expect([1, 6, 7, 12, 13, 24].map(localDesk)).toEqual([1, 6, 1, 6, 1, 6]);
    // lider y sin puesto se quedan en la sala tal cual
    expect([0, -1].map(annexIndexOf)).toEqual([0, 0]);
    expect([0, -1, 25].map(localDesk)).toEqual([0, -1, -1]);
  });

  it('el id del anexo lleva a su sala duena', () => {
    const id = annexId('sesion-a', 2);
    expect(ownerOf(id)).toBe('sesion-a');
    expect(annexOfPlacement(id)).toBe(2);
    expect(ownerOf('sesion-a')).toBe('sesion-a');
    expect(annexOfPlacement('sesion-a')).toBe(0);
    expect(annexId('sesion-a', 0)).toBe('sesion-a');
  });

  it('los anexos van al final del mapa, despues de todas las salas', () => {
    const rooms = [
      { id: 'a', subagents: [sub(6), sub(12), sub(11)] },
      { id: 'b', subagents: [sub(6)] },
      { id: 'c', subagents: [sub(13)] },
    ];
    expect(annexesNeeded(rooms[0] ?? { subagents: [] })).toBe(1);
    // "c" necesita el anexo 2; se conserva el 1 aunque este vacio, asi el 2 no se mueve
    expect(mapIds(rooms)).toEqual(['a', 'b', 'c', annexId('a', 1), annexId('c', 1), annexId('c', 2)]);
  });

  it('un agente del puesto 8 vive en el anexo con su puesto local; sin anexo en el mapa, espera sin puesto', () => {
    const placed = new Set(['a', annexId('a', 1)]);
    expect(homeOf('a', 8, placed)).toEqual({ placementId: annexId('a', 1), deskIndex: 2 });
    expect(homeOf('a', 5, placed)).toEqual({ placementId: 'a', deskIndex: 5 });
    expect(homeOf('a', 8, new Set(['a']))).toEqual({ placementId: 'a', deskIndex: -1 });
  });
});

describe('anexos en la tripulacion', () => {
  const eight = () =>
    roomWith([
      agent('s6', 6, 'desk'),
      agent('s5', 5),
      agent('s4', 4, 'desk'),
      agent('s3', 3),
      agent('s2', 2, 'desk'),
      agent('s1', 1),
      agent('s12', 12, 'desk'),
      agent('s11', 11),
    ]);

  it('con 8 subagentes, los de los puestos 12 y 11 se sientan en el anexo (puestos locales 6 y 5) y nadie queda de pie', () => {
    const room = eight();
    const placed = placedOf([room]);
    expect([...placed]).toEqual(['r1', annexId('r1', 1)]);
    const crew = createCrew();
    reconcileCrew(crew, [room], placed);
    const annex = annexId('r1', 1);
    expect(crew.members.get('s12')?.roomId).toBe(annex);
    expect(crew.members.get('s12')?.targetNode).toBe(seatNode(6));
    expect(crew.members.get('s11')?.roomId).toBe(annex);
    expect(crew.members.get('s11')?.targetNode).toBe(seatNode(5));
    // los seis primeros siguen en la sala, cada uno en su puesto
    for (const d of [1, 2, 3, 4, 5, 6]) {
      const m = crew.members.get(`s${d}`);
      expect(m?.roomId).toBe('r1');
      expect(m?.targetNode).toBe(seatNode(d));
    }
    const members = [...crew.members.values()];
    expect(members).toHaveLength(8);
    expect(members.filter((m) => m.targetNode.startsWith('slot:'))).toEqual([]);
  });

  it('el lider no ocupa el anexo: ni su escritorio ni el rotulo del anexo hablan de el', () => {
    const room = eight();
    const crew = createCrew();
    reconcileCrew(crew, [room], placedOf([room]));
    const inAnnex = [...crew.members.values()].filter((m) => m.roomId === annexId('r1', 1));
    expect(inAnnex.map((m) => m.agent.id).sort()).toEqual(['s11', 's12']);
    expect(inAnnex.some((m) => m.agent.kind === 'lead' || m.targetNode === seatNode(0))).toBe(false);
    // lider esperando en la puerta con alerta viva: la sala lo anuncia, el anexo no
    const waitingLead: OfficeRoom = {
      ...room,
      lead: { ...room.lead, place: 'door', alert: { level: 'warning', title: 'Fallo 2 veces seguidas', source: 'errors' } },
    };
    expect(plaqueSignals(waitingLead, false)).toMatchObject({ waiting: true, leadAlert: { level: 'warning' } });
    expect(plaqueSignals(waitingLead, false, 1)).toMatchObject({ leadAlert: null, waiting: false });
  });

  it('el que esperaba de pie en la sala se muda a su anexo cuando aparece en el mapa', () => {
    // sin lugar (snapshot viejo): al entrar va directo a su puesto
    const room = roomWith([1, 2, 3, 4, 5, 6, 12, 11].map((d) => agent(`s${d}`, d)));
    const crew = createCrew();
    // sin el anexo en el mapa: los de 12 y 11 esperan en el desborde de la sala
    reconcileCrew(crew, [room], new Set(['r1']));
    expect(crew.members.get('s12')?.roomId).toBe('r1');
    expect(crew.members.get('s12')?.targetNode.startsWith('slot:')).toBe(true);
    expect(reconcileCrew(crew, [room], placedOf([room]))).toBe(true);
    expect(crew.members.get('s12')?.roomId).toBe(annexId('r1', 1));
    expect(crew.members.get('s12')?.targetNode).toBe(seatNode(6));
    expect(crew.members.get('s11')?.targetNode).toBe(seatNode(5));
    // la segunda vez con lo mismo no cambia nada
    expect(reconcileCrew(crew, [room], placedOf([room]))).toBe(false);
  });
});
