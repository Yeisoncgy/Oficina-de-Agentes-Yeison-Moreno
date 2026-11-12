import type { FastifyInstance } from 'fastify';
import type { OfficeSnapshot } from '@shared/contract';
import type { SnapshotHub } from '../state/hub';

export interface HealthStatus {
  backfill: 'pendiente' | 'en curso' | 'listo' | 'error';
  filesTotal: number;
  filesDone: number;
}

export function registerOfficeRoutes(
  app: FastifyInstance,
  deps: { build: () => OfficeSnapshot; hub: SnapshotHub; status: HealthStatus },
): void {
  app.get('/api/office', async () => deps.build());

  app.get('/api/health', async () => ({
    ok: true,
    backfill: deps.status.backfill,
    filesTotal: deps.status.filesTotal,
    filesDone: deps.status.filesDone,
    sseClients: deps.hub.size,
  }));

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const cleanup = (): void => deps.hub.remove(res);
    req.raw.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    deps.hub.add(res);
  });
}
