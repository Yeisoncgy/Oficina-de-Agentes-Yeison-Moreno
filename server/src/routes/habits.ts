import type { FastifyInstance } from 'fastify';
import type { HabitsResponse, InboxLevel } from '@shared/contract';
import { inRange, normalize, RULE_DEFS, type RulesService } from '../habits/rules';
import { isRuleId } from '../habits/ruleSettings';
import type { HabitsService } from '../habits/service';

const HABIT_RANGES: readonly HabitsResponse['range'][] = ['live', 'today', 'week', 'month'];
const usdFmt = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const countFmt = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

function isHabitRange(v: string): v is HabitsResponse['range'] {
  return (HABIT_RANGES as readonly string[]).includes(v);
}

/** tope de llaves por pedido de la bandeja */
const INBOX_KEYS_MAX = 500;

function isInboxLevel(v: unknown): v is InboxLevel {
  return v === 'critical' || v === 'warning';
}

/** llaves de la bandeja: 1..INBOX_KEYS_MAX textos de 1..2048 caracteres */
function inboxKeys(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > INBOX_KEYS_MAX) return null;
  return v.every((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 2048) ? v : null;
}

/** habitos (solo lectura) y reglas de aviso; cada cambio de regla recalcula las alertas y sale por SSE */
export function registerHabitsRoutes(
  app: FastifyInstance,
  deps: { habits: HabitsService; rules: RulesService; changed: () => void },
): void {
  const { habits, rules, changed } = deps;
  // las alertas vivas dependen de los umbrales: se recalculan antes de avisar a los clientes
  const apply = (): void => {
    habits.refresh();
    changed();
  };

  app.get<{ Querystring: { range?: string } }>('/api/habits', async (req, reply) => {
    const range = req.query.range ?? 'live';
    if (!isHabitRange(range)) return reply.code(400).send({ error: 'range debe ser live, today, week o month' });
    return habits.findings(range);
  });

  // bandeja: alertas y avisos para copiar a Claude Code; al copiar se descartan hasta que salga algo nuevo
  app.get('/api/habits/inbox', async () => habits.inbox());

  app.post<{ Body: { level?: unknown; keys?: unknown } }>('/api/habits/inbox/dismiss', async (req, reply) => {
    const level = req.body?.level;
    const keys = inboxKeys(req.body?.keys);
    if (!isInboxLevel(level)) return reply.code(400).send({ error: 'level debe ser critical o warning' });
    if (!keys) return reply.code(400).send({ error: `keys debe ser una lista de 1 a ${INBOX_KEYS_MAX} llaves` });
    const res = habits.dismiss(level, keys);
    changed();
    return res;
  });

  app.post<{ Body: { keys?: unknown } }>('/api/habits/inbox/restore', async (req, reply) => {
    const keys = inboxKeys(req.body?.keys);
    if (!keys) return reply.code(400).send({ error: `keys debe ser una lista de 1 a ${INBOX_KEYS_MAX} llaves` });
    const res = habits.restore(keys);
    changed();
    return res;
  });

  app.get('/api/rules', async () => rules.list());

  // ruta fija: gana sobre /api/rules/:id
  app.put<{ Body: { enabled?: unknown } }>('/api/rules/notify', async (req, reply) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled debe ser booleano' });
    const res = rules.setNotify(enabled);
    apply();
    return res;
  });

  app.put<{ Params: { id: string }; Body: { value?: unknown; enabled?: unknown } }>(
    '/api/rules/:id',
    async (req, reply) => {
      const { id } = req.params;
      if (!isRuleId(id)) return reply.code(404).send({ error: 'la regla no existe' });
      const { value, enabled } = req.body ?? {};
      const patch: { value?: number | null; enabled?: boolean } = {};
      if (enabled !== undefined) {
        if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled debe ser booleano' });
        patch.enabled = enabled;
      }
      if (value === null) {
        patch.value = null;
      } else if (value !== undefined) {
        const def = RULE_DEFS[id];
        const count = def.unit === 'count';
        // el rango se mira ya redondeado: 0,001 USD quedaria guardado como 0
        const valid =
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value > 0 &&
          (!count || Number.isInteger(value)) &&
          inRange(id, normalize(id, value));
        if (!valid) {
          const error = count
            ? `value debe ser un entero entre ${countFmt.format(def.min)} y ${countFmt.format(def.max)}`
            : `value debe ser un monto entre $${usdFmt.format(def.min)} y $${countFmt.format(def.max)}`;
          return reply.code(400).send({ error });
        }
        patch.value = value;
      }
      if (patch.value === undefined && patch.enabled === undefined) {
        return reply.code(400).send({ error: 'falta value o enabled' });
      }
      const res = rules.update(id, patch);
      apply();
      return res;
    },
  );
}
