import { afterEach, describe, expect, it } from 'vitest';
import type { AgentPlace, OfficeAgent, OfficeRoom } from '@shared/contract';
import { isTraveling, stepActor } from '@/scene/actors';
import { forceReducedMotion } from '@/scene/characters/motion';
import {
  activityOf,
  type Crew,
  createCrew,
  createLead,
  leadActivity,
  MIN_STAY_S,
  reconcileCrew,
  syncLead,
  tickCrew,
} from '@/scene/crew';
import {
  assignSlots,
  buildOfficeNav,
  COFFEE_SPOT,
  computeLayout,
  DESKS,
  deskSpec,
  findPath,
  NODE,
  officeNode,
  OVERFLOW_SLOTS,
  pathPoints,
  type Rect,
  ROOM_INTERIOR,
  ROOM_NAV,
  roomObstacles,
  seatNode,
  slotNode,
  type Vec2,
} from '@/scene/layout';
import { createMockSnapshot } from '@/scene/mock';
import { leadPlaza, type Plaza, ZONE_LIST, ZONE_PROPS, ZONES, type ZoneId, zoneOf } from '@/scene/zones';

afterEach(() => forceReducedMotion(null));

/** puntos cada 3 cm a lo largo de un tramo */
function samples(a: Vec2, b: Vec2): Vec2[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.03));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n }));
}

function strictlyInside(r: Rect, p: Vec2): boolean {
  return p.x > r.minX + 1e-6 && p.x < r.maxX - 1e-6 && p.z > r.minZ + 1e-6 && p.z < r.maxZ - 1e-6;
}

/** mueble en el que se sienta quien llega a cada asiento: el ultimo tramo entra en el */
const OWN_SEAT = new Map<string, string>([
  ...DESKS.map((d): [string, string] => [seatNode(d.index), `chair:${d.index}`]),
  ...ZONE_LIST.flatMap((z) => z.plazas.flatMap((p): [string, string][] => (p.seat ? [[p.node, p.seat]] : []))),
]);

const OBSTACLES = [0, 1, 2].flatMap((decor) => roomObstacles(decor).map((o) => ({ ...o, decor })));
const ALL_PLAZAS: Plaza[] = ZONE_LIST.flatMap((z) => [...z.plazas]);

/** problemas de un tramo del grafo: fuera de eje o atravesando un mueble (salvo el asiento propio) */
function legProblems(a: string, b: string): string[] {
  const pa = ROOM_NAV.nodes.get(a);
  const pb = ROOM_NAV.nodes.get(b);
  if (!pa || !pb) return [`${a} -> ${b}: nodo inexistente`];
  const out: string[] = [];
  if (Math.abs(pa.x - pb.x) > 1e-9 && Math.abs(pa.z - pb.z) > 1e-9) out.push(`${a} -> ${b}: no va por un eje`);
  const own = new Set([OWN_SEAT.get(a), OWN_SEAT.get(b)]);
  for (const o of OBSTACLES) {
    if (own.has(o.name)) continue;
    if (samples(pa, pb).some((p) => strictlyInside(o.rect, p))) out.push(`${a} -> ${b} cruza ${o.name} (decoracion ${o.decor})`);
  }
  return out;
}

describe('zonas: muebles, plazas y caminos', () => {
  it('cada zona tiene >= 3 plazas alcanzables desde la puerta, sin cruzar muebles en las 3 decoraciones', () => {
    const ids: ZoneId[] = ['library', 'lab', 'meeting', 'review', 'door', 'coffee'];
    expect(ZONE_LIST.map((z) => z.id).sort()).toEqual([...ids].sort());
    for (const zone of ZONE_LIST) {
      expect(zone.plazas.length, zone.id).toBeGreaterThanOrEqual(3);
      // sin contar la del lider, quedan al menos 2 para subagentes (revision no reserva: 3)
      expect(zone.plazas.filter((_, i) => i !== zone.lead).length, zone.id).toBeGreaterThanOrEqual(2);
      for (const plaza of zone.plazas) {
        const path = findPath(ROOM_NAV, NODE.spawn, plaza.node);
        expect(path, plaza.node).not.toBeNull();
        const ids2 = path ?? [];
        for (let i = 1; i < ids2.length; i++) expect(legProblems(ids2[i - 1] ?? '', ids2[i] ?? '')).toEqual([]);
      }
    }
  });

  it('ninguna arista del grafo de la sala va fuera de eje ni cruza muebles o paredes (las 3 decoraciones)', () => {
    const problems: string[] = [];
    for (const [a, set] of ROOM_NAV.edges) for (const b of set) if (a < b) problems.push(...legProblems(a, b));
    expect(problems).toEqual([]);
  });

  it('las plazas quedan dentro de la sala, separadas entre si y fuera de los muebles', () => {
    const points: { id: string; p: Vec2 }[] = [
      ...ALL_PLAZAS.map((p) => ({ id: p.node, p })),
      ...OVERFLOW_SLOTS.map((p, i) => ({ id: slotNode(i), p })),
      ...DESKS.map((d) => ({ id: seatNode(d.index), p: d.seat })),
    ];
    for (const { id, p } of points) {
      expect(strictlyInside(ROOM_INTERIOR, p), id).toBe(true);
      for (const o of OBSTACLES) {
        if (OWN_SEAT.get(id) === o.name) continue;
        expect(strictlyInside(o.rect, p), `${id} dentro de ${o.name}`).toBe(false);
      }
    }
    // un personaje mide ~0,48 de ancho con la cabeza: nadie queda encima de otro
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i];
        const b = points[j];
        if (!a || !b || a.id === b.id) continue;
        expect(Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z), `${a.id} con ${b.id}`).toBeGreaterThanOrEqual(0.44);
      }
    }
    for (const prop of ZONE_PROPS) {
      expect(prop.rect.minX).toBeGreaterThanOrEqual(ROOM_INTERIOR.minX);
      expect(prop.rect.maxX).toBeLessThanOrEqual(ROOM_INTERIOR.maxX);
      expect(prop.rect.minZ).toBeGreaterThanOrEqual(ROOM_INTERIOR.minZ);
      expect(prop.rect.maxZ).toBeLessThanOrEqual(ROOM_INTERIOR.maxZ);
    }
  });

  it('la plaza de cafe del lider es la de siempre y el lider tiene plaza en todas las zonas menos revision', () => {
    const coffee = leadPlaza('coffee');
    expect(coffee?.node).toBe(NODE.coffee);
    expect(coffee?.x).toBe(COFFEE_SPOT.x);
    expect(coffee?.z).toBe(COFFEE_SPOT.z);
    for (const id of ['library', 'lab', 'meeting', 'door'] as const) expect(leadPlaza(id), id).toBeDefined();
    expect(leadPlaza('review')).toBeUndefined();
    expect(ZONES.meeting.plazas.every((p) => p.sit)).toBe(true);
    expect(zoneOf('desk')).toBeNull();
    expect(zoneOf('sleep')).toBeNull();
    expect(zoneOf(undefined)).toBeNull();
    expect(zoneOf('review')).toBe('review');
  });
});

// ---------------------------------------------------------------- tripulacion

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

const PLACED = new Set(['r1']);
const nonLead = (zone: ZoneId): Set<string> => new Set(ZONES[zone].plazas.filter((_, i) => i !== ZONES[zone].lead).map((p) => p.node));

/** avanza la escena: cada frame camina a todos y aplica lo pendiente */
function run(crew: Crew, from: number, seconds: number, onFrame?: (t: number) => void): number {
  const dt = 1 / 60;
  let t = from;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    t += dt;
    for (const m of crew.members.values()) stepActor(m.actor, dt);
    tickCrew(crew, t);
    onFrame?.(t);
  }
  return t;
}

describe('tripulacion: el lugar decide el destino', () => {
  it('sin puesto, cada lugar lleva a una plaza de su zona (nunca la del lider), al puesto o al desborde', () => {
    const crew = createCrew();
    // b..e trabajan sin puesto (desborde): con puesto se sentarian en su escritorio (ver la prueba de abajo)
    const places: [string, number, AgentPlace | undefined][] = [
      ['a', 1, 'desk'],
      ['b', -1, 'library'],
      ['c', -1, 'lab'],
      ['d', -1, 'meeting'],
      ['e', -1, 'review'],
      ['f', 6, 'door'],
      ['g', -1, 'coffee'],
      ['h', -1, 'sleep'],
      ['i', 3, undefined],
    ];
    reconcileCrew(crew, [roomWith(places.map(([id, desk, place]) => agent(id, desk, place)))], PLACED, ROOM_NAV, 0);
    const target = (id: string) => crew.members.get(id)?.targetNode ?? '';
    const activity = (id: string) => crew.members.get(id)?.actor.activity;
    expect(target('a')).toBe(seatNode(1));
    expect(nonLead('library').has(target('b'))).toBe(true);
    expect(nonLead('lab').has(target('c'))).toBe(true);
    expect(nonLead('meeting').has(target('d'))).toBe(true);
    expect(nonLead('review').has(target('e'))).toBe(true);
    expect(nonLead('door').has(target('f'))).toBe(true);
    expect(nonLead('coffee').has(target('g'))).toBe(true);
    // dormido sin puesto: al desborde; sin lugar (snapshot viejo): su puesto de siempre
    expect(target('h')).toBe(slotNode(0));
    expect(target('i')).toBe(seatNode(3));
    expect([activity('a'), activity('b'), activity('c'), activity('d'), activity('e'), activity('f'), activity('g'), activity('h')]).toEqual([
      'typing',
      'reading',
      'lab',
      'meeting',
      'reviewing',
      'waiting',
      'coffee',
      'sleeping',
    ]);
    // el primer snapshot sienta a todos en su lugar
    expect(crew.members.get('d')?.actor.sit).toBe(1);
    expect(crew.members.get('b')?.actor.sit).toBe(0);
  });

  it('trabajando con puesto se sienta en su escritorio, sea cual sea su lugar (menos la puerta)', () => {
    const crew = createCrew();
    const places: [string, number, AgentPlace][] = [
      ['b', 2, 'library'],
      ['c', 3, 'lab'],
      ['d', 4, 'meeting'],
      ['e', 5, 'review'],
      ['f', 6, 'door'],
      ['g', 1, 'coffee'],
    ];
    reconcileCrew(crew, [roomWith(places.map(([id, desk, place]) => agent(id, desk, place)))], PLACED, ROOM_NAV, 0);
    for (const [id, desk, place] of places) {
      const m = crew.members.get(id);
      if (place === 'door') {
        expect(nonLead('door').has(m?.targetNode ?? ''), id).toBe(true);
        continue;
      }
      expect(m?.targetNode, id).toBe(seatNode(desk));
      expect(m?.actor.sit, id).toBe(1);
      expect(m?.actor.activity, id).toBe('typing');
    }
    // pensando (sin accion) sigue sentado en su puesto
    reconcileCrew(crew, [roomWith([{ ...agent('c', 3, 'lab'), action: null }])], PLACED, ROOM_NAV, 1);
    expect(crew.members.get('c')?.actor.activity).toBe('thinking');
    expect(crew.members.get('c')?.targetNode).toBe(seatNode(3));
  });

  it('sin plaza libre va al desborde; nadie comparte destino ni toma la plaza del lider', () => {
    const crew = createCrew();
    const subs = ['a', 'b', 'c', 'd', 'e'].map((id) => agent(id, -1, 'library'));
    reconcileCrew(crew, [roomWith(subs)], PLACED, ROOM_NAV, 0);
    const targets = subs.map((a) => crew.members.get(a.id)?.targetNode ?? '');
    expect(new Set(targets).size).toBe(5);
    expect(targets.filter((t) => nonLead('library').has(t))).toHaveLength(nonLead('library').size);
    expect(targets.filter((t) => t.startsWith('slot:')).length).toBe(5 - nonLead('library').size);
    expect(targets).not.toContain(leadPlaza('library')?.node);
  });

  it('permanencia minima (sin puesto): el cambio de lugar espera 3 s desde que llego al anterior', () => {
    const crew = createCrew();
    reconcileCrew(crew, [roomWith([agent('a', -1, 'library')])], PLACED, ROOM_NAV, 0);
    const m = crew.members.get('a');
    if (!m) throw new Error('falta a');
    const library = m.targetNode;
    // al segundo pide laboratorio: sigue leyendo hasta cumplir los 3 s
    reconcileCrew(crew, [roomWith([agent('a', -1, 'lab')])], PLACED, ROOM_NAV, 1);
    expect(m.targetNode).toBe(library);
    expect(m.actor.activity).toBe('reading');
    tickCrew(crew, MIN_STAY_S - 0.1);
    expect(m.targetNode).toBe(library);
    tickCrew(crew, MIN_STAY_S + 0.05);
    expect(nonLead('lab').has(m.targetNode)).toBe(true);
    expect(isTraveling(m.actor)).toBe(true);
    expect(m.actor.activity).toBe('lab');
    // camino al laboratorio vuelve a pedir biblioteca: primero llega y se queda sus 3 s
    reconcileCrew(crew, [roomWith([agent('a', -1, 'library')])], PLACED, ROOM_NAV, MIN_STAY_S + 0.5);
    let arrived = -1;
    let left = -1;
    const lab = m.targetNode;
    run(crew, MIN_STAY_S + 0.5, 20, (t) => {
      if (arrived < 0 && m.targetNode === lab && !isTraveling(m.actor)) arrived = t;
      if (left < 0 && m.targetNode !== lab) left = t;
    });
    expect(arrived).toBeGreaterThan(0);
    expect(left - arrived).toBeGreaterThanOrEqual(MIN_STAY_S - 1e-6);
    expect(left - arrived).toBeLessThan(MIN_STAY_S + 0.1);
    expect(nonLead('library').has(m.targetNode)).toBe(true);
  });

  it('un subagente nuevo entra por el pasillo y camina directo a su puesto, sin pasar por la reunion', () => {
    const crew = createCrew();
    reconcileCrew(crew, [roomWith([])], PLACED, ROOM_NAV, 0);
    reconcileCrew(crew, [roomWith([agent('n', 4, 'library'), agent('v', 5), agent('w', -1, 'lab')])], PLACED, ROOM_NAV, 0);
    const n = crew.members.get('n');
    const v = crew.members.get('v');
    const w = crew.members.get('w');
    if (!n || !v || !w) throw new Error('faltan n, v y w');
    // pedia biblioteca, pero trabajando con puesto va a su escritorio desde el primer paso
    expect(n.actor.phase).toBe('entering');
    expect(n.targetNode).toBe(seatNode(4));
    expect(n.actor.activity).toBe('typing');
    // sin lugar (snapshot viejo) tambien a su puesto; sin puesto, a una plaza de su zona
    expect(v.targetNode).toBe(seatNode(5));
    expect(nonLead('lab').has(w.targetNode)).toBe(true);
    const meeting = new Set(ZONES.meeting.plazas.map((p) => p.node));
    const targets = new Set<string>();
    let arrived = -1;
    run(crew, 0, 30, (t) => {
      for (const m of [n, v, w]) targets.add(m.targetNode);
      if (arrived < 0 && !isTraveling(n.actor)) arrived = t;
    });
    // nunca apunto a la mesa de reunion ni cambio de destino en el camino
    expect([...targets].filter((node) => meeting.has(node))).toEqual([]);
    expect(targets.size).toBe(3);
    expect(arrived).toBeGreaterThan(0);
    const seat = ROOM_NAV.nodes.get(n.targetNode);
    expect(n.actor.pos.x).toBeCloseTo(seat?.x ?? NaN, 6);
    expect(n.actor.pos.z).toBeCloseTo(seat?.z ?? NaN, 6);
    expect(n.actor.sit).toBe(1);
    expect(n.actor.activity).toBe('typing');
    expect(v.actor.sit).toBe(1);
    expect(isTraveling(w.actor)).toBe(false);
    expect(w.actor.activity).toBe('lab');
  });

  it('quien de verdad va a la reunion (sin puesto) se sienta en la mesa de reunion', () => {
    const crew = createCrew();
    reconcileCrew(crew, [roomWith([])], PLACED, ROOM_NAV, 0);
    reconcileCrew(crew, [roomWith([agent('m', -1, 'meeting')])], PLACED, ROOM_NAV, 0);
    const m = crew.members.get('m');
    if (!m) throw new Error('falta m');
    expect(nonLead('meeting').has(m.targetNode)).toBe(true);
    expect(m.actor.activity).toBe('meeting');
    run(crew, 0, 30);
    expect(isTraveling(m.actor)).toBe(false);
    expect(m.actor.sit).toBe(1);
  });

  it('reconcileCrew es idempotente: dos llamadas con lo mismo no cambian nada', () => {
    const crew = createCrew();
    // sin puesto, para que los cambios de lugar lleven a zonas distintas
    const first = [agent('a', -1, 'desk'), agent('b', -1, 'review')];
    reconcileCrew(crew, [roomWith(first)], PLACED, ROOM_NAV, 0);
    const second = [...first, agent('c', -1, 'lab'), agent('d', -1, 'meeting')];
    expect(reconcileCrew(crew, [roomWith(second)], PLACED, ROOM_NAV, 5)).toBe(true);
    const snap = () =>
      [...crew.members.values()].map((m) => ({ id: m.actor.id, actor: m.actor, target: m.targetNode, route: m.actor.route, key: m.key }));
    const before = snap();
    expect(reconcileCrew(crew, [roomWith(second)], PLACED, ROOM_NAV, 5)).toBe(false);
    expect(snap()).toEqual(before);
    snap().forEach((s, i) => {
      expect(s.actor).toBe(before[i]?.actor);
      expect(s.route).toBe(before[i]?.route);
    });
    // un cambio que ya cumplio la permanencia se aplica una sola vez
    const moved = [agent('a', -1, 'library'), agent('b', -1, 'review'), agent('c', -1, 'lab'), agent('d', -1, 'meeting')];
    reconcileCrew(crew, [roomWith(moved)], PLACED, ROOM_NAV, 9);
    const a = crew.members.get('a');
    const route = a?.actor.route;
    expect(nonLead('library').has(a?.targetNode ?? '')).toBe(true);
    reconcileCrew(crew, [roomWith(moved)], PLACED, ROOM_NAV, 9);
    expect(a?.actor.route).toBe(route);
  });

  it('con movimiento reducido no hay caminatas: aparece en su lugar', () => {
    forceReducedMotion(true);
    const crew = createCrew();
    reconcileCrew(crew, [roomWith([])], PLACED, ROOM_NAV, 0);
    reconcileCrew(crew, [roomWith([agent('r', -1, 'library')])], PLACED, ROOM_NAV, 0);
    const r = crew.members.get('r');
    if (!r) throw new Error('falta r');
    expect(nonLead('library').has(r.targetNode)).toBe(true);
    expect(isTraveling(r.actor)).toBe(false);
    reconcileCrew(crew, [roomWith([agent('r', -1, 'lab')])], PLACED, ROOM_NAV, 1);
    tickCrew(crew, MIN_STAY_S + 0.1);
    expect(nonLead('lab').has(r.targetNode)).toBe(true);
    expect(isTraveling(r.actor)).toBe(false);
    const plaza = ROOM_NAV.nodes.get(r.targetNode);
    expect(r.actor.pos.x).toBeCloseTo(plaza?.x ?? NaN, 6);
  });
});

describe('el lider siempre sentado en el escritorio de lider de su sala', () => {
  const layout = computeLayout(assignSlots(new Map(), ['sala-0', 'sala-1']));
  const g = buildOfficeNav(layout);
  const lead = (place: AgentPlace, status: OfficeAgent['status'] = 'working'): OfficeAgent => ({
    ...agent('lead', 0, place, status),
    kind: 'lead',
    agentType: 'lead',
  });
  const desk = (roomId: string) => officeNode(roomId, seatNode(0));

  it('en cualquier lugar del lider se queda en su silla; trabajando teclea y la taza solo en el cafe', () => {
    const cases: [AgentPlace, OfficeAgent['status'], string][] = [
      ['desk', 'working', 'typing'],
      // leer, probar, revisar o lanzar agentes: programa en su escritorio (nada de matraz, libro ni lupa)
      ['lab', 'working', 'typing'],
      ['library', 'working', 'typing'],
      ['meeting', 'working', 'typing'],
      ['review', 'working', 'typing'],
      // lo que comunica otra cosa se respeta
      ['door', 'working', 'waiting'],
      ['door', 'idle', 'waiting'],
      ['coffee', 'working', 'coffee'],
      ['coffee', 'idle', 'coffee'],
      ['sleep', 'idle', 'sleeping'],
      ['desk', 'idle', 'idle'],
      ['lab', 'done', 'done'],
      ['desk', 'working', 'typing'],
    ];
    const ctl = createLead();
    // cambios seguidos, sin esperar permanencia: nunca se levanta
    cases.forEach(([place, status, activity]) => {
      syncLead(ctl, layout, g, 'sala-0', place);
      expect(ctl.targetNode, place).toBe(desk('sala-0'));
      expect(isTraveling(ctl.actor), place).toBe(false);
      expect(ctl.actor.sit, place).toBe(1);
      expect(ctl.actor.heading, place).toBeCloseTo(deskSpec(0)?.heading ?? NaN, 6);
      expect(leadActivity(ctl, lead(place, status)), place).toBe(activity);
      expect(ctl.actor.mug, place).toBe(place === 'coffee');
    });
    // trabajando sin herramienta abierta ("pensando") tambien teclea: sus pausas ya leen y piensan
    syncLead(ctl, layout, g, 'sala-0', 'lab');
    expect(leadActivity(ctl, { ...lead('lab'), action: null })).toBe('typing');
    expect(leadActivity(ctl, { ...lead('desk'), action: null })).toBe('typing');
  });

  it('cambiar de sala lo lleva al escritorio de lider de la otra; sin sala se sienta en la primera con la taza', () => {
    const ctl = createLead();
    syncLead(ctl, layout, g, 'sala-0', 'library');
    expect(ctl.targetNode).toBe(desk('sala-0'));
    syncLead(ctl, layout, g, 'sala-1', 'meeting');
    expect(ctl.targetNode).toBe(desk('sala-1'));
    expect(isTraveling(ctl.actor)).toBe(true);
    for (let i = 0; i < 60 * 40; i++) stepActor(ctl.actor, 1 / 60);
    expect(isTraveling(ctl.actor)).toBe(false);
    const seat = g.nodes.get(desk('sala-1'));
    expect(ctl.actor.pos.x).toBeCloseTo(seat?.x ?? NaN, 6);
    expect(ctl.actor.pos.z).toBeCloseTo(seat?.z ?? NaN, 6);
    expect(ctl.actor.sit).toBe(1);
    expect(leadActivity(ctl, lead('meeting'))).toBe('typing');

    // sin sala: el escritorio de lider de la primera, tomando cafe en la silla
    syncLead(ctl, layout, g, null, null);
    expect(ctl.targetNode).toBe(desk('sala-0'));
    expect(ctl.actor.mug).toBe(true);
    expect(leadActivity(ctl, null)).toBe('coffee');
    // una sala que no esta en el layout cuenta como sin sala
    const gone = createLead();
    syncLead(gone, layout, g, 'sala-9', 'lab');
    expect(gone.targetNode).toBe(desk('sala-0'));
    expect(gone.actor.sit).toBe(1);
    expect(gone.actor.mug).toBe(true);
    expect(leadActivity(gone, lead('lab'))).toBe('coffee');
    // sin lugar (snapshot viejo): su escritorio, sin taza
    const legacy = createLead();
    syncLead(legacy, layout, g, 'sala-1', null);
    expect(legacy.targetNode).toBe(desk('sala-1'));
    expect(legacy.actor.mug).toBe(false);
  });
});

describe('actividad por lugar', () => {
  it('desk como siempre; cada zona con su pose; el que termino celebra', () => {
    const a = agent('a', 1);
    expect(activityOf({ ...a, place: 'desk' })).toBe('typing');
    expect(activityOf({ ...a, action: null })).toBe('thinking');
    expect(activityOf({ ...a, status: 'idle' })).toBe('idle');
    expect(activityOf({ ...a, status: 'done', place: 'library' })).toBe('done');
    expect(activityOf(a, 'lab')).toBe('lab');
    expect(activityOf(a, 'review')).toBe('reviewing');
    expect(activityOf(a, 'door')).toBe('waiting');
    expect(activityOf({ ...a, status: 'idle' }, 'sleep')).toBe('sleeping');
  });
});

describe('demo con lugares y alertas', () => {
  it('los agentes rotan por lugares y hay una sala con alerta y un agente alertado', () => {
    const base = Date.UTC(2026, 0, 1, 10, 0, 0);
    const seen = new Set<AgentPlace>();
    for (let s = 0; s < 240; s += 5) {
      const snap = createMockSnapshot(base + s * 1000);
      for (const r of snap.rooms) for (const a of [r.lead, ...r.subagents]) if (a.place) seen.add(a.place);
      expect(snap.rooms.some((r) => r.alert)).toBe(true);
      expect(snap.rooms.flatMap((r) => r.subagents).some((a) => a.alert && a.status !== 'done')).toBe(true);
    }
    for (const place of ['desk', 'library', 'lab', 'meeting', 'review', 'door'] as const) expect(seen.has(place), place).toBe(true);
  });
});
