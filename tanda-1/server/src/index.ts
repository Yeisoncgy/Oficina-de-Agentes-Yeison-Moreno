import { buildApp, createContext, runBackfill, startRuntime } from './app';
import { CLAUDE_HOME, DB_PATH, HOST, IDLE_EXIT_MS, PORT } from './config';
import { openDb } from './db/connection';

const db = openDb(DB_PATH);
const ctx = createContext({ db, claudeHome: CLAUDE_HOME });
const app = buildApp(ctx);

await app.listen({ host: HOST, port: PORT });
console.log(`[server] escuchando en http://${HOST}:${PORT}`);

// escucha primero; el backfill corre despues sin bloquear las rutas
await ctx.registry.refresh();
const runtime = startRuntime(ctx);
runBackfill(ctx).catch((err: unknown) => {
  console.error(`[backfill] fallo: ${err instanceof Error ? err.message : String(err)}`);
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[server] ${signal}: cerrando`);
  try {
    await runtime.stop();
    await app.close();
  } catch (err) {
    console.error(`[server] error al cerrar: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    db.close();
    process.exit(0);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
// Windows lo manda al cerrar la ventana de la consola (asi se apaga Colmena.cmd) y da unos segundos
process.once('SIGHUP', () => void shutdown('SIGHUP'));

if (IDLE_EXIT_MS !== null) {
  const idleMs = IDLE_EXIT_MS;
  let lastClientAt = Date.now();
  setInterval(() => {
    if (ctx.hub.size > 0) lastClientAt = Date.now();
    else if (Date.now() - lastClientAt >= idleMs) void shutdown('sin pestanas abiertas');
  }, Math.min(15_000, idleMs / 4)).unref();
}
