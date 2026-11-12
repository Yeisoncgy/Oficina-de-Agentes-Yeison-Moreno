// Anexos de sala (decision de diseno: con muchos agentes nadie se queda de pie contra la pared).
// Una sala tiene 6 escritorios. El server numera los puestos de una sesion de corrido: 1-6 = la sala,
// 7-12 = anexo 1, 13-18 = anexo 2, 19-24 = anexo 3 (DESK_ORDER en server/src/config.ts). Cada anexo es
// una sala mas en el mapa, con la misma geometria y zonas, pero sin lider: el agente vive ahi (su
// escritorio y las zonas del anexo). Los anexos van al final del mapa para no mover ninguna sala y se
// quitan cuando no les queda nadie.

import type { OfficeRoom } from '@shared/contract';

export const DESKS_PER_ROOM = 6;
export const MAX_ANNEXES = 3;
const ANNEX_SEP = '~anexo';

/** 0 = la sala; 1..MAX_ANNEXES = su anexo. Sin puesto (deskIndex < 1) = la sala */
export function annexIndexOf(deskIndex: number): number {
  if (deskIndex < 1) return 0;
  return Math.min(MAX_ANNEXES, Math.floor((deskIndex - 1) / DESKS_PER_ROOM));
}

/** puesto dentro de su sala o anexo (1..6); sin puesto se conserva (0 lider, -1 sin puesto) */
export function localDesk(deskIndex: number): number {
  if (deskIndex < 1) return deskIndex;
  if (deskIndex > DESKS_PER_ROOM * (MAX_ANNEXES + 1)) return -1;
  return ((deskIndex - 1) % DESKS_PER_ROOM) + 1;
}

export function annexId(roomId: string, annex: number): string {
  return annex <= 0 ? roomId : `${roomId}${ANNEX_SEP}${annex}`;
}

/** sesion duena de una sala del mapa (la misma si no es anexo) */
export function ownerOf(placementId: string): string {
  const i = placementId.lastIndexOf(ANNEX_SEP);
  return i < 0 ? placementId : placementId.slice(0, i);
}

/** 0 si la sala del mapa no es anexo */
export function annexOfPlacement(placementId: string): number {
  const i = placementId.lastIndexOf(ANNEX_SEP);
  if (i < 0) return 0;
  const n = Number(placementId.slice(i + ANNEX_SEP.length));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** anexos que necesita la sala: hasta el mas alto con alguien (tambien los que salen caminando) */
export function annexesNeeded(room: Pick<OfficeRoom, 'subagents'>): number {
  return room.subagents.reduce((m, a) => Math.max(m, annexIndexOf(a.deskIndex)), 0);
}

/** ids de las salas del mapa: primero todas las salas y despues los anexos (al final, asi nadie se mueve) */
export function mapIds(rooms: readonly Pick<OfficeRoom, 'id' | 'subagents'>[]): string[] {
  const annexes = rooms.flatMap((r) => Array.from({ length: annexesNeeded(r) }, (_, i) => annexId(r.id, i + 1)));
  return [...rooms.map((r) => r.id), ...annexes];
}

/**
 * Donde vive un agente: la sala del mapa (anexo si su puesto es > 6 y el anexo esta en el mapa) y su
 * puesto local. Si el anexo no esta, queda en la sala sin puesto (desborde) hasta que aparezca.
 */
export function homeOf(roomId: string, deskIndex: number, placed: ReadonlySet<string>): { placementId: string; deskIndex: number } {
  const annex = annexIndexOf(deskIndex);
  if (annex === 0) return { placementId: roomId, deskIndex };
  const id = annexId(roomId, annex);
  if (placed.has(id)) return { placementId: id, deskIndex: localDesk(deskIndex) };
  return { placementId: roomId, deskIndex: -1 };
}
