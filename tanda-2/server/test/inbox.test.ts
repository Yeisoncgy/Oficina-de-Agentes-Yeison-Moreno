import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { HabitsInboxResponse, InboxItem } from '@shared/contract';
import { openDb } from '../src/db/connection';
import { DISMISS_FORGET_MS, DismissedAlerts, inboxGroup } from '../src/habits/inbox';
import { RulesService } from '../src/habits/rules';
import { HabitsService } from '../src/habits/service';
import { registerHabitsRoutes } from '../src/routes/habits';
import { habitsDb, MIN, NOW, Seed } from './habitsDb';

const S = 'sesion-1';
const COSTLY = 'f:rule:agent_cost:costoso';
const ERRORS = 'a:agent:fallando:errors:-';

/** sala abierta con el lead trabajando: un agente sobre el tope de costo, uno con fallos seguidos y uno con ambos */
function setup() {
  const db = habitsDb();
  const seed = new Seed(db);
  const rules = new RulesService(db, () => NOW);
  const service = () => new HabitsService({ db, clock: () => NOW, rules, openIds: () => new Set([S]) });
  const habits = service();
  seed.session(S, { turnOpen: true, lastPromptAt: NOW - 5 * MIN, lastActivityAt: NOW - MIN });
  for (const id of ['costoso', 'fallando', 'mixto']) seed.agent(id, S);
  seed.spend('costoso', S, NOW - 3 * MIN, 0.8);
  seed.action('fallando', S, 'Bash', NOW - 5 * MIN);
  seed.action('fallando', S, 'Bash', NOW - 4 * MIN, { isError: true });
  seed.action('fallando', S, 'Bash', NOW - 3 * MIN, { isError: true });
  seed.spend('mixto', S, NOW - 3 * MIN, 0.9);
  seed.action('mixto', S, 'Bash', NOW - 4 * MIN, { isError: true });
  seed.action('mixto', S, 'Bash', NOW - 3 * MIN, { isError: true });
  habits.refresh();
  return { db, seed, rules, habits, service };
}

const keys = (res: HabitsInboxResponse, level: 'alerts' | 'warnings') => res[level].items.map((i) => i.key);

const item = (o: Partial<InboxItem> & Pick<InboxItem, 'key' | 'title' | 'instruction'>): InboxItem => ({
  level: 'critical',
  roomId: 'r1',
  roomTitle: 'Fase 2',
  projectName: 'office-site',
  agentName: null,
  ...o,
});

describe('texto de la bandeja', () => {
  it('ordenado por sala, numerado de corrido, sin repetir instrucciones y con los comandos de barra al final', () => {
    const items = [
      item({ key: 'k1', title: 'Costo del agente $3,40 > $2,00', agentName: 'Bruno', instruction: 'Divide los encargos.' }),
      item({ key: 'k2', roomId: 'r2', roomTitle: 'Notas', projectName: 'Notas', title: '31 turnos sin compactar', instruction: '/compact Conserva las decisiones.' }),
      item({ key: 'k3', title: 'Leyó rig.ts 7 veces sin editarlo', agentName: 'Elena', instruction: 'Divide los encargos.' }),
      item({ key: 'k4', level: 'warning', title: 'Un aviso', instruction: 'Otra cosa.' }),
    ];
    const group = inboxGroup('critical', items);
    expect(group.items.map((i) => i.key)).toEqual(['k1', 'k3', 'k2']);
    expect(group.text).toBe(
      [
        'Estas son las alertas críticas de consumo de tokens que detectó mi Oficina Virtual en mis sesiones de Claude Code. Corrígelas en este orden y aplica cada instrucción desde ahora:',
        '',
        'Sala "Fase 2" (office-site)',
        '1. Costo del agente $3,40 > $2,00 · Bruno',
        '   Qué hacer: Divide los encargos.',
        '2. Leyó rig.ts 7 veces sin editarlo · Elena',
        '   Qué hacer: lo mismo que el punto 1.',
        '',
        'Sala "Notas"',
        '3. 31 turnos sin compactar',
        '   Qué hacer: lo ejecuto yo con el comando del final.',
        '',
        'Para ejecutar yo (tú no puedes correr comandos de barra):',
        '- Sala "Notas": /compact Conserva las decisiones.',
        '',
        'Cuando termines, dime en una línea qué cambiaste en cada punto.',
      ].join('\n'),
    );
    expect(inboxGroup('warning', []).text).toBe('');
  });
});

describe('bandeja: copiar y descartar', () => {
  it('la alerta viva que cuenta un hallazgo no se duplica; la de fallos seguidos entra sola como aviso', () => {
    const { habits } = setup();
    const res = habits.inbox();
    expect(keys(res, 'alerts')).toContain(COSTLY);
    expect(keys(res, 'alerts')).not.toContain('a:agent:costoso:rule:agent_cost');
    expect(keys(res, 'warnings')).toContain(ERRORS);
    expect(res.dismissed).toBe(0);
    // nunca texto de prompts ni el nombre del lead como agente
    expect(res.alerts.text).toContain('Qué hacer:');
  });

  it('descartar apaga la alerta en todos lados; si el costo sigue subiendo no vuelve; restaurar la devuelve', () => {
    const { seed, habits, service } = setup();
    const before = habits.current().summary().alerts;
    const res = habits.dismiss('critical', [COSTLY, 'llave-que-no-existe']);
    expect(keys(res, 'alerts')).not.toContain(COSTLY);
    expect(res.dismissed).toBe(1);
    expect(habits.current().agent('costoso')).toBeNull();
    expect(habits.current().summary().alerts).toBe(before - 1);
    expect(habits.findings('live').findings.some((f) => f.id === 'rule:agent_cost:costoso')).toBe(false);
    // en el historico los dos costos van juntados: el grupo sale "Enviada" cuando se copiaron todos
    const todayGroup = () => habits.findings('today').findings.find((f) => f.kind === 'rule' && f.ruleId === 'agent_cost');
    expect(todayGroup()?.dismissed).toBeUndefined();
    habits.dismiss('critical', ['f:rule:agent_cost:mixto']);
    expect(todayGroup()?.dismissed).toBe(true);
    habits.restore(['f:rule:agent_cost:mixto']);

    seed.spend('costoso', S, NOW - MIN, 1.5);
    habits.refresh();
    expect(habits.current().agent('costoso')).toBeNull();

    // queda guardado: otro arranque del server lo sigue ocultando
    const again = service();
    again.refresh();
    expect(again.current().agent('costoso')).toBeNull();

    const back = habits.restore([COSTLY]);
    expect(keys(back, 'alerts')).toContain(COSTLY);
    expect(habits.current().agent('costoso')?.ruleId).toBe('agent_cost');
  });

  it('si la peor alerta de un agente esta descartada, sale la siguiente', () => {
    const { habits } = setup();
    expect(habits.current().agent('mixto')?.ruleId).toBe('agent_cost');
    habits.dismiss('critical', ['f:rule:agent_cost:mixto']);
    expect(habits.current().agent('mixto')).toMatchObject({ level: 'warning', source: 'errors' });
  });

  it('un aviso se descarta solo desde su nivel', () => {
    const { habits } = setup();
    expect(keys(habits.dismiss('critical', [ERRORS]), 'warnings')).toContain(ERRORS);
    const res = habits.dismiss('warning', [ERRORS]);
    expect(keys(res, 'warnings')).not.toContain(ERRORS);
    expect(habits.current().agent('fallando')).toBeNull();
  });
});

describe('cuando vuelve lo descartado', () => {
  const seen = (level: 'critical' | 'warning' | 'info', size = 0) => ({ level, size });
  const none = () => [];

  it('vuelve si sube de nivel, si el grupo suma miembros o si se fue mas de 30 min y regresa', () => {
    const db = openDb(':memory:');
    const d = new DismissedAlerts(db, NOW);
    d.add(
      [
        { key: 'f:read', level: 'warning', size: 0, children: [] },
        { key: 'f:grupo:loop:s1', level: 'critical', size: 4, children: [{ key: 'f:loop:a1', level: 'critical' }] },
        { key: 'a:room:s1:rule:session_day_cost', level: 'critical', size: 0, children: [] },
      ],
      NOW,
    );
    // igual que al descartar: nada vuelve
    d.observe(new Map([['f:read', seen('warning')], ['f:grupo:loop:s1', seen('critical', 4)]]), NOW + MIN, none);
    expect(['f:read', 'f:grupo:loop:s1', 'f:loop:a1'].every((k) => d.has(k))).toBe(true);
    // sube a critico y el grupo suma un agente
    d.observe(new Map([['f:read', seen('critical')], ['f:grupo:loop:s1', seen('critical', 5)]]), NOW + 2 * MIN, () => ['f:loop:a1']);
    expect(d.has('f:read')).toBe(false);
    expect(d.has('f:grupo:loop:s1')).toBe(false);
    expect(d.has('f:loop:a1')).toBe(false);
    // la de sala no se vio: se olvida recien pasados 30 min
    expect(d.has('a:room:s1:rule:session_day_cost')).toBe(true);
    d.observe(new Map(), NOW + DISMISS_FORGET_MS + MIN, none);
    expect(d.has('a:room:s1:rule:session_day_cost')).toBe(false);
  });

  it('se guarda en la DB (tabla de la v16) y sobrevive a un reinicio', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(19);
    new DismissedAlerts(db, NOW).add([{ key: 'f:x', level: 'warning', size: 0, children: [] }], NOW);
    expect(new DismissedAlerts(db, NOW + MIN).has('f:x')).toBe(true);
  });
});

describe('rutas de la bandeja', () => {
  async function app() {
    const ctx = setup();
    let changes = 0;
    const server = Fastify({ logger: false });
    registerHabitsRoutes(server, { habits: ctx.habits, rules: ctx.rules, changed: () => changes++ });
    return { server, changes: () => changes };
  }

  it('GET, descartar (ignorando llaves desconocidas), restaurar y validar; cada cambio avisa por SSE', async () => {
    const { server, changes } = await app();
    const get = await server.inject({ method: 'GET', url: '/api/habits/inbox' });
    expect(get.statusCode).toBe(200);
    expect(keys(get.json() as HabitsInboxResponse, 'alerts')).toContain(COSTLY);

    const unknown = await server.inject({ method: 'POST', url: '/api/habits/inbox/dismiss', payload: { level: 'critical', keys: ['nada'] } });
    expect(unknown.statusCode).toBe(200);
    expect((unknown.json() as HabitsInboxResponse).dismissed).toBe(0);

    const dismissed = await server.inject({ method: 'POST', url: '/api/habits/inbox/dismiss', payload: { level: 'critical', keys: [COSTLY] } });
    expect(keys(dismissed.json() as HabitsInboxResponse, 'alerts')).not.toContain(COSTLY);
    const restored = await server.inject({ method: 'POST', url: '/api/habits/inbox/restore', payload: { keys: [COSTLY] } });
    expect(keys(restored.json() as HabitsInboxResponse, 'alerts')).toContain(COSTLY);
    expect(changes()).toBe(3);

    const bad = [
      { url: '/api/habits/inbox/dismiss', payload: { level: 'info', keys: [COSTLY] } },
      { url: '/api/habits/inbox/dismiss', payload: { level: 'critical', keys: [] } },
      { url: '/api/habits/inbox/dismiss', payload: { level: 'critical', keys: [''] } },
      { url: '/api/habits/inbox/restore', payload: { keys: 'no-es-lista' } },
    ];
    for (const b of bad) expect((await server.inject({ method: 'POST', ...b })).statusCode).toBe(400);
    expect(changes()).toBe(3);
    await server.close();
  });
});
