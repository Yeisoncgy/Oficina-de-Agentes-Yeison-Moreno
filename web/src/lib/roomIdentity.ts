// Identidad visual de una sala: numero y color propio, iguales en la lista, la oficina 3D y el panel de la sala
// (una sola experiencia visual). Sale del lugar fijo del mapa (slot), que no
// cambia mientras la sala siga en la oficina, asi el color no salta.
import type { OfficeRoom } from '@shared/contract';

/**
 * Colores de sala: ninguno es un color de estado (cian trabajando, verde hecho, rojo error, amarillo aviso,
 * ambar espera), para que el color diga "que sala" y el LED diga "como esta".
 */
export const ROOM_ACCENTS = [
  '#F07BA8', // rosa neon
  '#5B8DEF', // azul rey
  '#2FA6A6', // verde azulado
  '#D9673B', // brasa
  '#B98BE0', // lila
  '#7FB069', // hoja
  '#E0A8FF', // orquidea
  '#C9A26B', // miel
] as const;

export interface RoomIdentity {
  /** 1..N: "Sala 3" (el cartel de la sala en 3D usa el mismo numero) */
  number: number;
  /** "03": para el numero grande en pixel */
  label: string;
  accent: string;
}

/** slot ausente (demo o fixtures): el indice en la lista, para que igual tenga numero y color estables en la pagina */
export function roomIdentity(room: Pick<OfficeRoom, 'slot'>, fallbackIndex = 0): RoomIdentity {
  const slot = room.slot ?? fallbackIndex;
  const number = slot + 1;
  return {
    number,
    label: String(number).padStart(2, '0'),
    accent: ROOM_ACCENTS[slot % ROOM_ACCENTS.length] ?? ROOM_ACCENTS[0],
  };
}
