/**
 * Lugar de cada sala en el mapa (decision de diseno: que no se mueva y que no queden huecos).
 * - Los lugares son 0..N-1, sin huecos. Las visibles conservan su orden relativo, asi que agregar una sala no
 *   mueve a nadie: la nueva va al final.
 * - Si una sala sale (archivada, eliminada o cerrada de otro dia), su espacio desaparece del mapa y las que
 *   venian despues avanzan un lugar. Si vuelve, entra al final como nueva.
 * El orden de `visible` solo decide el reparto de las nuevas que llegan juntas.
 */
export function assignRoomSlots(saved: ReadonlyMap<string, number>, visible: readonly string[]): Map<string, number> {
  const unique = visible.filter((id, i) => visible.indexOf(id) === i);
  const known = unique.filter((id) => saved.has(id)).sort((a, b) => (saved.get(a) ?? 0) - (saved.get(b) ?? 0));
  const fresh = unique.filter((id) => !saved.has(id));
  return new Map([...known, ...fresh].map((id, i) => [id, i]));
}

/**
 * El usuario arrastro las salas en la lista (que va por lugar): las mismas celdas se reparten en el orden
 * nuevo. Ids sin lugar o repetidos se ignoran; las salas que no vienen en `ids` no se mueven.
 */
export function reorderSlots(saved: ReadonlyMap<string, number>, ids: readonly string[]): Map<string, number> {
  const known = ids.filter((id, i) => saved.has(id) && ids.indexOf(id) === i);
  const cells = known.map((id) => saved.get(id) ?? 0).sort((a, b) => a - b);
  const next = new Map(saved);
  known.forEach((id, i) => next.set(id, cells[i] ?? 0));
  return next;
}

export function sameSlots(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, slot] of a) if (b.get(id) !== slot) return false;
  return true;
}
