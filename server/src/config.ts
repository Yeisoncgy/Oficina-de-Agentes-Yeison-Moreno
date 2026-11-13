import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CLAUDE_HOME = process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude');
export const DB_PATH = path.join(SERVER_DIR, 'data', 'office.db');
export const HOST = '127.0.0.1';
// el monto del presupuesto mensual vive en settings (budget_usd); por defecto BUDGET_DEFAULT_USD del contrato

const DEFAULT_PORT = 4317;
/** puerto reservado por otra herramienta de la maquina: nunca se usa */
const FORBIDDEN_PORT = 8500;

function resolvePort(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0 || n > 65535) return DEFAULT_PORT;
  if (n === FORBIDDEN_PORT) {
    console.warn(`[config] OFFICE_PORT=${FORBIDDEN_PORT} no esta permitido; se usa ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return n;
}

export const PORT = resolvePort(process.env.OFFICE_PORT);

/**
 * Con el lanzador sin ventana (launcher/Colmena.js) nadie puede cerrar la consola: el server se apaga solo
 * cuando lleva este tiempo sin ninguna pestana conectada por SSE. Sin la variable no se apaga nunca.
 */
export const IDLE_EXIT_MS = (() => {
  const n = Number(process.env.OFFICE_IDLE_EXIT_MS);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

export const TIMING = {
  /** subagente terminado sigue visible (status done) para animar la salida */
  doneVisibleMs: 30_000,
  /** respaldo de fin de subagente: end_turn sin acciones abiertas y archivo quieto */
  subagentQuietMs: 90_000,
  /** lead sin registro: se considera trabajando si hubo actividad en esta ventana */
  leadActiveWindowMs: 10 * 60_000,
  /** registro de sesion viejo: updatedAt y mtime del transcript mas antiguos que esto */
  staleRegistryMs: 24 * 60 * 60_000,
  /** holgura entre la ultima linea de un subagente y la senal de fin en el padre */
  endSignalSlackMs: 10_000,
  /** corrida de Workflow sin senal de fin: sigue en curso si su journal cambio hace menos que esto */
  workflowQuietMs: 2 * 60_000,
  sweepMs: 5_000,
  pingMs: 15_000,
  debounceMs: 250,
} as const;

export const MAX_ROOMS = 12;
export const DESK_COUNT = 6;
/**
 * orden en que se llenan los puestos (decision de diseno): primero la fila de adelante (la mas cerca de la camara)
 * empezando por el de la derecha, de derecha a izquierda; luego la del fondo igual. Adelante nada tapa al
 * agente y la lista de salas tapa el lado izquierdo. Puestos: fondo 1-2-3 y adelante 4-5-6, de izquierda a derecha.
 * Con mas de 6 agentes la sala se amplia con anexos de 6 puestos (7-12, 13-18, 19-24; web/src/scene/annex.ts),
 * en el mismo orden; recien despues del 24 alguien queda sin puesto (-1).
 */
const ROOM_DESK_ORDER = [6, 5, 4, 3, 2, 1] as const;
const ANNEXES = 3;
export const DESK_ORDER: readonly number[] = Array.from({ length: ANNEXES + 1 }, (_, k) =>
  ROOM_DESK_ORDER.map((d) => k * ROOM_DESK_ORDER.length + d),
).flat();
/** corridas de Workflow por sala en el snapshot */
export const MAX_WORKFLOWS_PER_ROOM = 5;
/** dias de historico del costo por agente (simulador y pronostico de flujos) */
export const COST_HISTORY_DAYS = 30;
/** dias laborales que promedia la tendencia del presupuesto */
export const TREND_WORKDAYS = 5;
