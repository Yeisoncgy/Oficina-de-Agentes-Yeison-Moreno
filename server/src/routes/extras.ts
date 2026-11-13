import type { FastifyInstance } from 'fastify';
import type { HistoryRange, IngestHealth } from '@shared/contract';
import { SAFE_ID } from '../ingest/paths';
import { parseFlatPrice, PRICE_MAX, type PriceBook } from '../ingest/priceBook';
import type { Extras } from '../state/extras';
import type { Settings } from '../state/settings';
import type { RulesService } from '../habits/rules';
import { rangeStart } from './history';

const RANGES: readonly HistoryRange[] = ['today', 'week', 'month', 'all'];
const MODEL_RE = /^[A-Za-z0-9._-]{1,100}$/;

export interface ExtrasRouteDeps {
  extras: Extras;
  priceBook: PriceBook;
  settings: Settings;
  rules: RulesService;
  clock: () => number;
  /** estado vivo de la lectura (cola, contadores del lector, arranque) */
  live: () => Parameters<Extras['health']>[0];
  /** los precios o un ajuste cambiaron: se recalcula todo lo que depende del costo y se avisa a las pestanas */
  changed: () => void;
  /** apaga el servidor; null si este proceso no ofrece apagado */
  shutdown: () => (() => void) | null;
}

/** paneles nuevos: precios, conciliacion, meses, sesiones, linea de tiempo, archivos, "y si", informe y salud */
export function registerExtrasRoutes(app: FastifyInstance, deps: ExtrasRouteDeps): void {
  const { extras, priceBook, settings, rules, clock, changed } = deps;

  app.get('/api/prices', async () => priceBook.list());

  app.put<{ Params: { model: string }; Body: unknown }>('/api/prices/:model', async (req, reply) => {
    const { model } = req.params;
    if (!MODEL_RE.test(model)) return reply.code(400).send({ error: 'modelo invalido' });
    const price = parseFlatPrice(req.body);
    if (!price) {
      return reply
        .code(400)
        .send({ error: `se esperan input, output, cacheWrite5m, cacheWrite1h y cacheRead entre 0 y ${PRICE_MAX} (USD por millon)` });
    }
    priceBook.setCustom(model, price);
    changed();
    return priceBook.list();
  });

  app.delete<{ Params: { model: string } }>('/api/prices/:model', async (req, reply) => {
    const { model } = req.params;
    if (!MODEL_RE.test(model)) return reply.code(400).send({ error: 'modelo invalido' });
    priceBook.setCustom(model, null);
    changed();
    return priceBook.list();
  });

  app.get('/api/history/reconcile', async () => extras.reconcile());
  app.get('/api/history/months', async () => extras.months());

  app.get<{ Querystring: { range?: string } }>('/api/history/sessions', async (req, reply) => {
    const range = (req.query.range ?? 'month') as HistoryRange;
    if (!RANGES.includes(range)) return reply.code(400).send({ error: 'range debe ser today|week|month|all' });
    return extras.sessions(range, rangeStart(range, clock()));
  });

  app.get<{ Querystring: { range?: string } }>('/api/history/whatif', async (req, reply) => {
    const range = req.query.range ?? 'month';
    if (range !== 'week' && range !== 'month' && range !== 'all') {
      return reply.code(400).send({ error: 'range debe ser week|month|all' });
    }
    return extras.whatIf(range, rangeStart(range, clock()));
  });

  app.get<{ Querystring: { range?: string } }>('/api/history/report', async (req, reply) => {
    const range = req.query.range ?? 'week';
    if (range !== 'week' && range !== 'month') return reply.code(400).send({ error: 'range debe ser week|month' });
    return extras.report(range);
  });

  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>('/api/agents/:id/actions', async (req, reply) => {
    if (!SAFE_ID.test(req.params.id)) return reply.code(400).send({ error: 'id invalido' });
    const res = extras.actions(req.params.id, req.query.cursor || undefined);
    if (!res) return reply.code(400).send({ error: 'cursor invalido' });
    return res;
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id/files', async (req, reply) => {
    if (!SAFE_ID.test(req.params.id)) return reply.code(400).send({ error: 'id invalido' });
    return extras.files(req.params.id);
  });

  app.get('/api/health/ingest', async (): Promise<IngestHealth> => extras.health(deps.live()));

  app.put<{ Body: { notifyDesktop?: unknown; keepAlive?: unknown } }>('/api/settings/system', async (req, reply) => {
    const { notifyDesktop, keepAlive } = req.body ?? {};
    const patch: { notifyDesktop?: boolean; keepAlive?: boolean } = {};
    if (notifyDesktop !== undefined) {
      if (typeof notifyDesktop !== 'boolean') return reply.code(400).send({ error: 'notifyDesktop debe ser booleano' });
      patch.notifyDesktop = notifyDesktop;
    }
    if (keepAlive !== undefined) {
      if (typeof keepAlive !== 'boolean') return reply.code(400).send({ error: 'keepAlive debe ser booleano' });
      patch.keepAlive = keepAlive;
    }
    if (patch.notifyDesktop === undefined && patch.keepAlive === undefined) {
      return reply.code(400).send({ error: 'falta notifyDesktop o keepAlive' });
    }
    settings.setSystem(patch);
    return rules.list();
  });

  app.post('/api/shutdown', async (_req, reply) => {
    const stop = deps.shutdown();
    if (!stop) return reply.code(409).send({ error: 'este servidor no ofrece apagado desde la app' });
    // responde primero: el apagado cierra la conexion
    setTimeout(stop, 150).unref();
    return { ok: true };
  });
}
