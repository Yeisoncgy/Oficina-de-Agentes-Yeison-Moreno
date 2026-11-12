import type { FastifyInstance } from 'fastify';
import { cleanLeadName } from '@shared/agents';
import type { LeadNameResponse } from '@shared/contract';
import type { Settings } from '../state/settings';

/** ajustes del usuario que viajan en el snapshot; cada cambio sale enseguida por SSE */
export function registerSettingsRoutes(app: FastifyInstance, deps: { settings: Settings; changed: () => void }): void {
  const { settings, changed } = deps;

  app.get('/api/settings/lead-name', async (): Promise<LeadNameResponse> => ({ name: settings.leadName() }));

  app.put<{ Body: { name?: unknown } }>('/api/settings/lead-name', async (req, reply) => {
    const name = cleanLeadName(req.body?.name);
    if (!name) return reply.code(400).send({ error: 'Escribe un nombre' });
    settings.setLeadName(name);
    changed();
    const res: LeadNameResponse = { name };
    return res;
  });
}
