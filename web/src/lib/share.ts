// Comparte con el dato anterior todo lo que llega igual. El servidor manda la foto completa cada pocos segundos
// y casi todo se repite (las salas quietas, los agentes que no cambiaron, el presupuesto del mes, los
// pendientes): con la misma identidad, los selectores de zustand y los componentes con memo no se vuelven a
// renderizar por datos que no cambiaron. Solo datos de JSON (objetos planos, arreglos y primitivos). Lo que
// cambio conserva la identidad del dato nuevo (quien guardo el snapshot que llego lo sigue reconociendo).

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** id de un elemento de lista (salas, agentes, corridas): asi un elemento nuevo al principio no rompe a los demas */
function idOf(v: unknown): string | undefined {
  if (!isPlain(v)) return undefined;
  const id = v.id ?? v.runId;
  return typeof id === 'string' ? id : undefined;
}

function shareArray(prev: readonly unknown[], next: unknown[]): readonly unknown[] {
  let byId: Map<string, unknown> | null = null;
  let same = prev.length === next.length;
  for (let i = 0; i < next.length; i++) {
    const item = next[i];
    let before = prev[i];
    const id = idOf(item);
    if (id !== undefined && idOf(before) !== id) {
      if (!byId) {
        byId = new Map();
        for (const p of prev) {
          const pid = idOf(p);
          if (pid !== undefined) byId.set(pid, p);
        }
      }
      before = byId.get(id);
    }
    const v = shareEqual(before, item);
    if (v !== item) next[i] = v;
    if (v !== prev[i]) same = false;
  }
  return same ? prev : next;
}

function shareObject(prev: Plain, next: Plain): Plain {
  const keys = Object.keys(next);
  let same = keys.length === Object.keys(prev).length;
  for (const k of keys) {
    const before = prev[k];
    const item = next[k];
    const v = shareEqual(before, item);
    if (v !== item) next[k] = v;
    if (v !== before || !(k in prev)) same = false;
  }
  return same ? prev : next;
}

/**
 * Si `next` llega igual a `prev`, devuelve `prev`. Si no, devuelve `next` con sus partes iguales a las de
 * `prev` reemplazadas por las de `prev` (misma identidad). Escribe en `next` (un dato recien llegado, sin
 * cambiar su valor); `prev` no se toca. Un `next` congelado no se toca: sale tal cual.
 */
export function shareEqual<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T;
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next;
    return (Object.isFrozen(next) ? (deepEqual(prev, next) ? prev : next) : shareArray(prev, next)) as T;
  }
  if (isPlain(next)) {
    if (!isPlain(prev)) return next;
    return (Object.isFrozen(next) ? (deepEqual(prev, next) ? prev : next) : shareObject(prev, next)) as T;
  }
  return next;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isPlain(a) && isPlain(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}
