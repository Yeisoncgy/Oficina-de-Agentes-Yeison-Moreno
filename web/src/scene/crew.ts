// Traduce snapshots a personajes: quien entra, quien se va, a que lugar camina cada uno y a donde va
// el lider. Mutaciones sobre objetos estables; idempotente si se llama dos veces con lo mismo.
// Las coordenadas salen de layout (puestos, desborde) y de zones (plazas): aqui no hay coordenadas.
//
// Lugar (OfficeAgent.place, pasado por seatedPlace: trabajando con puesto = desk): desk o sleep = su
// puesto (deskIndex; sin puesto, el desborde) · library, lab, meeting, review, door, coffee = una plaza
// libre de esa zona, reservada mientras la ocupa (la del lider nunca la toma un subagente); sin plaza
// libre, el desborde. Cambiar de lugar espera MIN_STAY_S
// desde que llego al anterior (no va y vuelve). Un subagente nuevo aparece en el pasillo y camina directo
// a su lugar. Sin place (snapshots viejos, fixtures) todo queda como antes: su puesto.
// Puestos 7 en adelante: el agente vive en el anexo de su sala (annex.ts), con su puesto local y las zonas
// del anexo; roomId del miembro = el lugar del mapa donde vive.

import type { AgentPlace, OfficeAgent, OfficeRoom } from '@shared/contract';
import { LEAD_PERSONA } from '@shared/personas';
import type { Activity, Actor, Destination } from './actors';
import { createActor, HOP_TIME, isTraveling, placeAt, routeTo, setRouteSpeeds, stopAt } from './actors';
import { homeOf } from './annex';
import { MOTION, reducedMotion } from './characters/motion';
import type { NavGraph, OfficeLayout } from './layout';
import {
  deskSpec,
  NODE,
  officeNode,
  OVERFLOW_HEADING,
  OVERFLOW_SLOTS,
  ROOM_NAV,
  SEAT_HEADING,
  seatNode,
  slotNode,
  worldGround,
} from './layout';
import { type Plaza, type ZoneId, ZONES, zoneOf } from './zones';

/** permanencia minima en un lugar antes de ir a otro (s) */
export const MIN_STAY_S = 3;

/** reloj de la escena (s): el mismo para reconcileCrew, tickCrew y el lider */
export function sceneNow(): number {
  return performance.now() / 1000;
}

export interface CrewMember {
  actor: Actor;
  roomId: string;
  /** ultimo dato conocido del agente (se conserva mientras sale caminando) */
  agent: OfficeAgent;
  targetNode: string;
  /** lugar aplicado (al que camina o donde esta); el del snapshot entra tras la permanencia minima */
  place: AgentPlace | undefined;
  /** llave del lugar aplicado ('library', 'desk:3'...) y la del que pide el snapshot */
  key: string;
  want: string;
  /** reloj de la escena cuando llego a su destino actual; null = caminando */
  arrivedAt: number | null;
}

export interface Crew {
  members: Map<string, CrewMember>;
  /** el primer snapshot sienta a todos sin animacion de entrada */
  initialized: boolean;
}

export function createCrew(): Crew {
  return { members: new Map(), initialized: false };
}

/**
 * Actividad de un agente en un lugar (por defecto, el suyo). desk: tecleando / pensando / inactivo como
 * siempre; las zonas y el sueno tienen su pose. El que termino celebra en cualquier lugar.
 */
export function activityOf(agent: OfficeAgent, place: AgentPlace | undefined = agent.place): Activity {
  if (agent.status === 'done') return 'done';
  switch (place) {
    case 'library':
      return 'reading';
    case 'lab':
      return 'lab';
    case 'meeting':
      return 'meeting';
    case 'review':
      return 'reviewing';
    case 'door':
      return 'waiting';
    case 'coffee':
      return 'coffee';
    case 'sleep':
      return 'sleeping';
    default:
      break;
  }
  if (agent.status === 'idle') return 'idle';
  return agent.action ? 'typing' : 'thinking';
}

/**
 * Lugar al que camina un subagente. Trabajando y con puesto, se sienta en su escritorio: las zonas de pie (biblioteca, laboratorio, revision) lo dejaban parado, o en el desborde con el
 * escritorio libre. La puerta se respeta porque espera una respuesta del usuario, no trabaja. Sin puesto
 * (desborde, desde el agente 25) sigue yendo a su zona. El place real del snapshot no cambia: lo usan el
 * panel del agente y las etiquetas.
 */
export function seatedPlace(agent: OfficeAgent): AgentPlace | undefined {
  const { place } = agent;
  if (agent.status !== 'working' || place === undefined || place === 'desk' || place === 'door') return place;
  return agent.deskIndex >= 1 ? 'desk' : place;
}

/** llave del lugar: la zona o el puesto (desk y sleep van al puesto) */
function keyOf(place: AgentPlace | undefined, deskIndex: number): string {
  return zoneOf(place) ?? `desk:${deskIndex}`;
}

function memberActivity(m: CrewMember): Activity {
  return activityOf(m.agent, m.place);
}

interface Target {
  node: string;
  dest: Destination;
}

function plazaTarget(p: Plaza): Target {
  return { node: p.node, dest: { endHeading: p.heading, sit: p.sit } };
}

const onTheWayOut = (m: CrewMember): boolean => m.actor.phase !== 'entering' && m.actor.phase !== 'present';

/** destinos reservados por los demas de la sala (los que ya se van no reservan) */
function takenIn(crew: Crew, roomId: string, self: CrewMember | null): Set<string> {
  const taken = new Set<string>();
  for (const m of crew.members.values()) {
    if (m !== self && m.roomId === roomId && !onTheWayOut(m)) taken.add(m.targetNode);
  }
  return taken;
}

/** plaza libre de la zona (nunca la del lider); si ya tiene una de esa zona, se queda en ella */
function freePlaza(crew: Crew, roomId: string, self: CrewMember | null, zone: ZoneId): Plaza | null {
  const spec = ZONES[zone];
  const own = self ? spec.plazas.find((p, i) => i !== spec.lead && p.node === self.targetNode) : undefined;
  if (own) return own;
  const taken = takenIn(crew, roomId, self);
  return spec.plazas.find((p, i) => i !== spec.lead && !taken.has(p.node)) ?? null;
}

/** de pie en el desborde (sin puesto o sin plaza libre); si ya esta en uno, se queda */
function overflowTarget(crew: Crew, roomId: string, self: CrewMember | null): Target {
  const dest = { endHeading: OVERFLOW_HEADING, sit: false };
  if (self?.targetNode.startsWith('slot:')) return { node: self.targetNode, dest };
  const taken = takenIn(crew, roomId, self);
  let slot = OVERFLOW_SLOTS.findIndex((_, i) => !taken.has(slotNode(i)));
  if (slot < 0) slot = taken.size % Math.max(1, OVERFLOW_SLOTS.length);
  return { node: slotNode(slot), dest };
}

// busqueda de plaza libre sin asignar memoria (la repite en cada frame quien espera en el desborde)
let scanSelf: CrewMember | null = null;
let scanNode = '';
let scanTaken = false;

function scanMember(m: CrewMember): void {
  if (!scanTaken && scanSelf && m !== scanSelf && m.roomId === scanSelf.roomId && !onTheWayOut(m) && m.targetNode === scanNode) {
    scanTaken = true;
  }
}

/** quedo libre una plaza de su zona (nunca la del lider) */
function plazaFreed(crew: Crew, self: CrewMember, zone: ZoneId): boolean {
  const spec = ZONES[zone];
  let free = false;
  scanSelf = self;
  for (let i = 0; i < spec.plazas.length && !free; i++) {
    const plaza = spec.plazas[i];
    if (!plaza || i === spec.lead) continue;
    scanNode = plaza.node;
    scanTaken = false;
    crew.members.forEach(scanMember);
    free = !scanTaken;
  }
  scanSelf = null;
  return free;
}

/** de pie en el desborde porque su zona estaba llena, y ya se libero una plaza */
function overflowCanLeave(crew: Crew, m: CrewMember): boolean {
  if (!m.targetNode.startsWith('slot:')) return false;
  const zone = zoneOf(m.place);
  return zone !== null && plazaFreed(crew, m, zone);
}

function targetFor(crew: Crew, roomId: string, self: CrewMember | null, agent: OfficeAgent): Target {
  const zone = zoneOf(agent.place);
  if (zone) {
    const plaza = freePlaza(crew, roomId, self, zone);
    return plaza ? plazaTarget(plaza) : overflowTarget(crew, roomId, self);
  }
  const desk = agent.deskIndex >= 1 ? deskSpec(agent.deskIndex) : undefined;
  if (desk) return { node: seatNode(desk.index), dest: { endHeading: desk.heading, sit: true } };
  return overflowTarget(crew, roomId, self);
}

/** lleva al miembro a un destino nuevo (con movimiento reducido aparece directo) */
function moveTo(m: CrewMember, g: NavGraph, target: Target, now: number): void {
  m.place = m.agent.place;
  m.key = m.want;
  m.actor.activity = memberActivity(m);
  if (target.node === m.targetNode) return;
  m.targetNode = target.node;
  m.arrivedAt = null;
  if (reducedMotion() || !routeTo(m.actor, g, target.node, target.dest)) {
    placeAt(m.actor, g, target.node, target.dest);
    m.arrivedAt = now;
  }
}

/**
 * Aplica lo pendiente de un miembro que sigue en la sala: registra cuando llego, cambia de lugar si el
 * snapshot pide otro y ya cumplio la permanencia, y deja el desborde cuando se libera una plaza de su zona.
 * Sin asignar memoria mientras no haya nada que hacer (corre en cada frame).
 */
function settle(crew: Crew, m: CrewMember, g: NavGraph, now: number): void {
  if (m.arrivedAt === null) {
    if (isTraveling(m.actor)) return;
    m.arrivedAt = now;
  }
  if (now - m.arrivedAt < MIN_STAY_S) return;
  if (m.want === m.key && !overflowCanLeave(crew, m)) return;
  moveTo(m, g, targetFor(crew, m.roomId, m, m.agent), now);
}

function startLeaving(m: CrewMember, g: NavGraph, celebrate: boolean): void {
  const a = m.actor;
  a.phase = 'leaving';
  a.hop = celebrate ? HOP_TIME : 0;
  a.activity = memberActivity(m);
  if (reducedMotion() || !routeTo(a, g, NODE.spawn, { endHeading: null, sit: false })) {
    a.phase = 'vanishing';
    a.vanishT = 0;
  }
}

/**
 * Entra un subagente: aparece en el pasillo y camina directo a su lugar (su puesto, o su zona o el desborde
 * si no tiene puesto) y alli se sienta. El primer snapshot (o con movimiento reducido) lo sienta sin caminar.
 */
function enter(crew: Crew, roomId: string, agent: OfficeAgent, g: NavGraph, now: number): CrewMember {
  const spawn = g.nodes.get(NODE.spawn) ?? { x: 0, z: 0 };
  const actor = createActor(agent.id, spawn, 0);
  const want = keyOf(agent.place, agent.deskIndex);
  const m: CrewMember = { actor, roomId, agent, targetNode: NODE.spawn, place: agent.place, key: want, want, arrivedAt: null };
  const instant = !crew.initialized || reducedMotion();
  const target = targetFor(crew, roomId, null, agent);
  m.targetNode = target.node;
  actor.activity = memberActivity(m);
  if (instant) {
    placeAt(actor, g, target.node, target.dest);
    m.arrivedAt = now;
    return m;
  }
  // aparece en el pasillo (nunca dentro de la sala) y camina 150 ms despues
  actor.lastNode = NODE.spawn;
  actor.pop = 0;
  actor.appearT = 0;
  actor.delay = MOTION.appearToWalk;
  actor.phase = 'entering';
  if (!routeTo(actor, g, target.node, target.dest)) {
    placeAt(actor, g, target.node, target.dest);
    m.arrivedAt = now;
  }
  return m;
}

const localCache = new WeakMap<OfficeAgent, OfficeAgent>();

/**
 * El agente como vive en su casa: con el puesto local y el lugar al que camina (seatedPlace). Mientras el
 * agente del snapshot no cambie (store: misma identidad), devuelve el mismo objeto: su personaje y su tarjeta
 * no se vuelven a renderizar.
 */
function localAgent(agent: OfficeAgent, deskIndex: number): OfficeAgent {
  const housed = deskIndex === agent.deskIndex ? agent : { ...agent, deskIndex };
  const place = seatedPlace(housed);
  if (housed === agent && place === agent.place) return agent;
  const hit = localCache.get(agent);
  if (hit && hit.deskIndex === deskIndex && hit.place === place) return hit;
  const local = place === housed.place ? housed : { ...housed, place };
  localCache.set(agent, local);
  return local;
}

/**
 * Sincroniza la tripulacion con las salas del snapshot. Devuelve true si entro o se quito alguien
 * (hay que volver a renderizar la lista de personajes). Los cambios de lugar no piden render.
 */
export function reconcileCrew(
  crew: Crew,
  rooms: readonly OfficeRoom[],
  placedRoomIds: ReadonlySet<string>,
  g: NavGraph = ROOM_NAV,
  now: number = sceneNow(),
): boolean {
  let changed = false;
  const seen = new Set<string>();
  for (const room of rooms) {
    if (!placedRoomIds.has(room.id)) continue;
    for (const agent of room.subagents) {
      seen.add(agent.id);
      // su casa: la sala o su anexo, con el puesto local de ese lugar del mapa
      const home = homeOf(room.id, agent.deskIndex, placedRoomIds);
      const local = localAgent(agent, home.deskIndex);
      let existing = crew.members.get(agent.id);
      // cambio de casa (esperaba en el desborde y aparecio su anexo): entra de nuevo en la suya. El que ya
      // termino o se va sale desde donde esta
      if (existing && existing.roomId !== home.placementId && !onTheWayOut(existing) && local.status !== 'done') {
        crew.members.delete(agent.id);
        existing = undefined;
        changed = true;
      }
      if (existing) {
        existing.agent = local;
        existing.want = keyOf(local.place, local.deskIndex);
        if (onTheWayOut(existing)) continue;
        if (local.status === 'done') {
          startLeaving(existing, g, true);
          continue;
        }
        existing.actor.activity = memberActivity(existing);
        settle(crew, existing, g, now);
        continue;
      }
      if (local.status === 'done') continue;
      crew.members.set(agent.id, enter(crew, home.placementId, local, g, now));
      changed = true;
    }
  }
  for (const [id, m] of crew.members) {
    if (seen.has(id)) continue;
    if (!placedRoomIds.has(m.roomId)) {
      crew.members.delete(id);
      changed = true;
      continue;
    }
    if (!onTheWayOut(m)) startLeaving(m, g, false);
  }
  crew.initialized = true;
  return changed;
}

// estado del recorrido de cada frame en variables del modulo: ni objetos ni cierres nuevos por llamada
let tickCrewRef: Crew | null = null;
let tickGraph: NavGraph = ROOM_NAV;
let tickNow = 0;

function tickMember(m: CrewMember): void {
  if (tickCrewRef && !onTheWayOut(m)) settle(tickCrewRef, m, tickGraph, tickNow);
}

/** En cada frame: llegadas y cambios de lugar que esperaban */
export function tickCrew(crew: Crew, now: number, g: NavGraph = ROOM_NAV): void {
  tickCrewRef = crew;
  tickGraph = g;
  tickNow = now;
  crew.members.forEach(tickMember);
  tickCrewRef = null;
}

// ---------------------------------------------------------------- lider (el usuario)

export interface LeadControl {
  actor: Actor;
  targetNode: string | null;
  layoutKey: string | null;
  /** sala (null = sin sala o una que no esta en el layout) y lugar del lider aplicados */
  roomId: string | null;
  place: AgentPlace | null;
}

export function createLead(): LeadControl {
  const actor = createActor(LEAD_PERSONA, { x: 0, z: 0 }, 0);
  return { actor, targetNode: null, layoutKey: null, roomId: null, place: null };
}

export interface LeadTarget {
  node: string;
  roomId: string;
  /** con la taza en la mano */
  mug: boolean;
  dest: Destination;
}

/**
 * El lider siempre sentado en el escritorio de lider de su sala, sea cual sea su lugar (no anda por la
 * sala estorbando): el lugar solo cambia la pose sentada (leadActivity: trabajando, teclea) y en el cafe
 * la taza, que toma en su silla. Sin sala (o con una que no esta en el layout) se sienta en el de la primera, con la taza.
 */
export function leadTarget(layout: OfficeLayout, leadRoomId: string | null, place: AgentPlace | null = null): LeadTarget | null {
  const own = leadRoomId ? layout.byId.get(leadRoomId) : undefined;
  const room = own ?? layout.rooms[0];
  if (!room) return null;
  return {
    node: officeNode(room.id, seatNode(0)),
    roomId: room.id,
    mug: !own || place === 'coffee',
    dest: { endHeading: deskSpec(0)?.heading ?? SEAT_HEADING, sit: true },
  };
}

/** En los pasillos el lider acelera de 1,5 a 2,0 u/s (D5: "acelera al cruzar la puerta") */
function goTo(a: Actor, layout: OfficeLayout, g: NavGraph, target: LeadTarget): void {
  if (reducedMotion() || !routeTo(a, g, target.node, target.dest)) {
    placeAt(a, g, target.node, target.dest);
    return;
  }
  setRouteSpeeds(a, (from, to) =>
    worldGround(layout, from.x, from.z) === 0 && worldGround(layout, to.x, to.z) === 0 ? MOTION.hallSpeed : MOTION.walkSpeed,
  );
}

export function updateLead(ctl: LeadControl, layout: OfficeLayout, g: NavGraph, target: LeadTarget | null): void {
  if (!target) return;
  const a = ctl.actor;
  // en el actor y no en una prop: Character la lee en cada frame
  a.mug = target.mug;
  if (ctl.layoutKey === null) {
    ctl.layoutKey = layout.key;
    ctl.targetNode = target.node;
    placeAt(a, g, target.node, target.dest);
    return;
  }
  if (ctl.layoutKey !== layout.key) {
    ctl.layoutKey = layout.key;
    const anchor = a.lastNode ? g.nodes.get(a.lastNode) : undefined;
    if (!anchor) {
      ctl.targetNode = target.node;
      placeAt(a, g, target.node, target.dest);
      return;
    }
    // la sala se movio en la grilla: se reubica en su ultimo nodo y sigue desde ahi
    stopAt(a, anchor);
    if (ctl.targetNode === target.node && a.lastNode === target.node) return;
    ctl.targetNode = target.node;
    goTo(a, layout, g, target);
    return;
  }
  if (ctl.targetNode !== target.node) {
    ctl.targetNode = target.node;
    goTo(a, layout, g, target);
  }
}

/**
 * El lider con lo que pide el snapshot: su sala (null = sin sala) y su lugar en ella. Idempotente.
 * Sin permanencia: cambiar de sala es inmediato y el lugar no lo mueve de su silla (solo pose y taza).
 */
export function syncLead(ctl: LeadControl, layout: OfficeLayout, g: NavGraph, roomId: string | null, place: AgentPlace | null): void {
  const known = roomId !== null && layout.byId.has(roomId) ? roomId : null;
  updateLead(ctl, layout, g, leadTarget(layout, known, place));
  ctl.roomId = known;
  ctl.place = place;
}

/** lugares en los que el lider, trabajando, sigue programando en su escritorio (no saca libro, matraz ni lupa) */
const LEAD_TYPES_AT: ReadonlySet<AgentPlace | undefined> = new Set<AgentPlace | undefined>([
  undefined,
  'desk',
  'library',
  'lab',
  'meeting',
  'review',
]);

/**
 * Actividad del personaje del lider. Trabajando teclea en su escritorio sea cual sea su lugar (leer, probar,
 * revisar o lanzar agentes se ve como programar; el teclear ya trae sus pausas para leer y pensar). Lo que
 * comunica otra cosa se respeta: la puerta (espera una respuesta del usuario), el cafe, el sueno, inactivo
 * y terminado. Sin sala, cafe.
 */
export function leadActivity(ctl: LeadControl, lead: OfficeAgent | null): Activity {
  if (!lead || ctl.roomId === null) return 'coffee';
  const place = ctl.place ?? undefined;
  if (lead.status === 'working' && LEAD_TYPES_AT.has(place)) return 'typing';
  return activityOf(lead, place);
}
