import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { HABITS_LIST_MAX, type HabitFinding, type HabitKind, type HabitsResponse, type RulesResponse } from '@shared/contract';
import { COMPACT_COMMAND } from '../src/habits/copy';
import { RulesService } from '../src/habits/rules';
import { HabitsService, type HabitsDeps } from '../src/habits/service';
import { registerHabitsRoutes } from '../src/routes/habits';
import { Settings } from '../src/state/settings';
import { habitsDb, MIN, NOW, Seed, SONNET } from './habitsDb';

const S = 'sesion-1';
const S2 = 'sesion-2';

function setup(open?: readonly string[], extra: Pick<HabitsDeps, 'busyIds' | 'personaName'> = {}) {
  const db = habitsDb();
  const seed = new Seed(db);
  const rules = new RulesService(db, () => NOW);
  const habits = new HabitsService({
    db,
    clock: () => NOW,
    rules,
    ...(open ? { openIds: () => new Set(open) } : {}),
    ...extra,
  });
  return { db, seed, rules, habits };
}

function of(res: HabitsResponse, kind: HabitKind): HabitFinding[] {
  return res.findings.filter((f) => f.kind === kind);
}

/** cada detector por separado: 'live' (misma ventana que 'today') solo junta 4+ del mismo tipo en una sesion */
function detected(habits: HabitsService, kind: HabitKind): HabitFinding[] {
  return of(habits.findings('live'), kind);
}

describe('repeated_read', () => {
  it('3 lecturas completas sin editar = info; 5 = warning; ahorro con el precio de cache write', () => {
    const { db, seed, habits } = setup();
    new Settings(db).setLeadName('Ana');
    seed.session(S);
    const office = 'C:\\proyectos\\demo\\server\\src\\office.ts';
    for (let i = 0; i < 3; i++) {
      seed.action(S, S, 'Read', NOW - 30 * MIN + i * MIN, { target: office, readPartial: 0, resultChars: 8_000 });
    }
    const app = 'C:\\proyectos\\demo\\web\\App.tsx';
    for (let i = 0; i < 5; i++) {
      seed.action(S, S, 'Read', NOW - 20 * MIN + i * MIN, { target: app, readPartial: 0, resultChars: 4_000 });
    }
    const reads = detected(habits, 'repeated_read');
    expect(reads).toHaveLength(2);
    const first = reads.find((f) => f.title.includes('office.ts'));
    expect(first?.severity).toBe('info');
    expect(first?.title).toBe('Leyó office.ts 3 veces sin editarlo');
    expect(first?.evidence[0]).toEqual({ label: 'Lecturas sin editar', value: 3, unit: 'count' });
    // 2 relecturas x 2.000 tokens estimados x $5/MTok (cache write 5m de Opus 5.5)
    expect(first?.savingsUsd).toBeCloseTo(0.02, 6);
    // el lead sale con el nombre que eligio el usuario
    expect(first?.agentName).toBe('Ana');
    expect(first?.roomId).toBe(S);
    expect(reads.find((f) => f.title.includes('App.tsx'))?.severity).toBe('warning');
  });

  it('una edicion exitosa, una compactacion o leer tramos distintos cortan la racha', () => {
    const { seed, habits } = setup();
    seed.session(S);
    let t = NOW - 50 * MIN;
    const read = (file: string, o: Parameters<Seed['action']>[4] = {}) =>
      seed.action(S, S, 'Read', (t += MIN), { target: file, readPartial: 0, resultChars: 1_000, ...o });
    read('C:\\p\\a.ts');
    read('C:\\p\\a.ts');
    seed.action(S, S, 'Edit', (t += MIN), { target: 'C:\\p\\a.ts' });
    read('C:\\p\\a.ts');

    read('C:\\p\\b.ts');
    read('C:\\p\\b.ts');
    seed.event(S, S, (t += MIN), 'compact', { trigger: 'manual', preTokens: 90_000, postTokens: 10_000 });
    read('C:\\p\\b.ts');

    for (const h of ['h1', 'h2', 'h3']) read('C:\\p\\c.ts', { readPartial: 1, inputHash: h });
    // el mismo tramo tres veces si cuenta
    for (let i = 0; i < 3; i++) read('C:\\p\\d.ts', { readPartial: 1, inputHash: 'mismo-tramo' });
    // una edicion rechazada no cuenta como cambio
    read('C:\\p\\e.ts');
    read('C:\\p\\e.ts');
    seed.action(S, S, 'Edit', (t += MIN), { target: 'C:\\p\\e.ts', isError: true, denied: 'user-rejected' });
    read('C:\\p\\e.ts');

    const titles = detected(habits, 'repeated_read').map((f) => f.title).sort();
    expect(titles).toEqual(['Leyó d.ts 3 veces sin editarlo', 'Leyó e.ts 3 veces sin editarlo']);
  });
});

describe('full_read', () => {
  it('Read sin offset/limit de un archivo largo, agrupado por agente', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.action(S, S, 'Read', NOW - 10 * MIN, { target: 'C:\\p\\big.ts', readPartial: 0, resultLines: 900, resultChars: 36_000 });
    seed.action(S, S, 'Read', NOW - 9 * MIN, { target: 'C:\\p\\tramo.ts', readPartial: 1, resultLines: 3_000, resultChars: 8_000 });
    seed.action(S, S, 'Read', NOW - 8 * MIN, { target: 'C:\\p\\small.ts', readPartial: 0, resultLines: 300, resultChars: 12_000 });
    seed.action(S, S, 'Read', NOW - 7 * MIN, { target: 'C:\\p\\notas.md', readPartial: 0, resultChars: 50_000 });

    const found = of(habits.findings('today'), 'full_read');
    expect(found).toHaveLength(1);
    const f = found[0]!;
    expect(f.title).toBe('Leyó completos 2 archivos largos: big.ts y notas.md');
    expect(f.evidence).toContainEqual({ label: 'Archivo más largo', value: 900, unit: 'lines' });
    expect(f.evidence).toContainEqual({ label: 'Tokens leídos', value: 21_500, unit: 'tokens', estimated: true });
    // solo big.ts sabe sus lineas: 9.000 tokens x (1 - 200/900) x $5/MTok
    expect(f.savingsUsd).toBeCloseTo(9_000 * (1 - 200 / 900) * 5e-6, 4);
    expect(f.copyText).toContain('offset/limit');
  });

  it('sin archivos largos leidos completos no hay hallazgo', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.action(S, S, 'Read', NOW - 9 * MIN, { target: 'C:\\p\\tramo.ts', readPartial: 1, resultLines: 3_000, resultChars: 8_000 });
    seed.action(S, S, 'Read', NOW - 8 * MIN, { target: 'C:\\p\\small.ts', readPartial: 0, resultLines: 300, resultChars: 12_000 });
    expect(of(habits.findings('today'), 'full_read')).toHaveLength(0);
  });
});

describe('big_context', () => {
  it('> 150 k warning, > 300 k critical; ahorro = exceso x precio cache read', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.agent('sub-1', S);
    seed.agent('sub-2', S);
    seed.usage(S, S, NOW - 5 * MIN, { input: 0, cacheRead: 200_000, cacheWrite5m: 0 });
    seed.usage('sub-1', S, NOW - 4 * MIN, { input: 0, cacheRead: 350_000, cacheWrite5m: 0 });
    seed.usage('sub-2', S, NOW - 3 * MIN, { input: 0, cacheRead: 100_000, cacheWrite5m: 0 });

    const found = detected(habits, 'big_context');
    expect(found.map((f) => f.agentId).sort()).toEqual([S, 'sub-1']);
    const lead = found.find((f) => f.agentId === S)!;
    expect(lead.severity).toBe('warning');
    expect(lead.savingsUsd).toBeCloseTo(50_000 * 0.2e-6, 6);
    expect(lead.copyText).toBe(COMPACT_COMMAND);
    const sub = found.find((f) => f.agentId === 'sub-1')!;
    expect(sub.severity).toBe('critical');
    expect(sub.evidence[0]).toEqual({ label: 'Contexto máximo', value: 350_000, unit: 'tokens' });
  });
});

describe('needs_compact', () => {
  it('30+ llamadas desde la ultima compactacion con contexto reciente > 120 k', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.session(S2);
    for (let i = 0; i < 30; i++) {
      seed.usage(S, S, NOW - 60 * MIN + i * MIN, { input: 0, cacheRead: 130_000, cacheWrite5m: 0 });
      seed.usage(S2, S2, NOW - 60 * MIN + i * MIN, { input: 0, cacheRead: 130_000, cacheWrite5m: 0 });
    }
    // S2 compacto hace poco: solo 10 llamadas despues
    seed.event(S2, S2, NOW - 40 * MIN - 1, 'compact', { trigger: 'auto', preTokens: 160_000, postTokens: 20_000 });

    const found = of(habits.findings('today'), 'needs_compact');
    expect(found.map((f) => f.roomId)).toEqual([S]);
    expect(found[0]?.copyText.startsWith('/compact')).toBe(true);
    // 10 llamadas x (130 k - 30 k) x $0,20/MTok
    expect(found[0]?.savingsUsd).toBeCloseTo(0.2, 6);
  });
});

describe('loop', () => {
  it('la misma herramienta con el mismo input N veces seguidas; con la regla encendida es critico', () => {
    const { seed, habits, rules } = setup();
    seed.session(S);
    seed.agent('sub-1', S);
    seed.agent('sub-2', S);
    for (let i = 0; i < 3; i++) seed.action('sub-1', S, 'Bash', NOW - 10 * MIN + i * MIN, { inputHash: 'mismo' });
    seed.spend('sub-1', S, NOW - 9 * MIN, 0.1);
    seed.spend('sub-1', S, NOW - 8 * MIN, 0.1);
    for (const h of ['h1', 'h2', 'h1']) seed.action('sub-2', S, 'Bash', NOW - 5 * MIN, { inputHash: h });

    const found = of(habits.findings('today'), 'loop');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ agentId: 'sub-1', severity: 'critical', ruleId: 'loop_repeats' });
    expect(found[0]?.title).toBe('Repitió Bash 3 veces seguidas con el mismo input');
    // 2 vueltas de sobra x $0,10 por llamada
    expect(found[0]?.savingsUsd).toBeCloseTo(0.2, 6);
    // la regla no sale repetida como hallazgo 'rule'
    expect(of(habits.findings('today'), 'rule').filter((f) => f.ruleId === 'loop_repeats')).toHaveLength(0);

    rules.update('loop_repeats', { enabled: false });
    const off = of(habits.findings('today'), 'loop');
    expect(off).toHaveLength(1);
    expect(off[0]?.severity).toBe('warning');
    expect(off[0]?.ruleId).toBeUndefined();
  });
});

describe('same_error', () => {
  it('3+ fallos iguales; los rechazos del usuario no cuentan', () => {
    const { seed, habits } = setup();
    seed.session(S);
    for (const id of ['sub-1', 'sub-2', 'sub-3']) seed.agent(id, S);
    for (let i = 0; i < 3; i++) {
      seed.action('sub-1', S, 'Bash', NOW - 10 * MIN + i * MIN, { isError: true, resultHash: 'e1' });
      seed.action('sub-2', S, 'Bash', NOW - 10 * MIN + i * MIN, { isError: true, resultHash: 'e2', denied: 'user-rejected' });
    }
    for (let i = 0; i < 2; i++) seed.action('sub-3', S, 'Bash', NOW - 5 * MIN + i * MIN, { isError: true, resultHash: 'e3' });

    const found = of(habits.findings('today'), 'same_error');
    expect(found.map((f) => f.agentId)).toEqual(['sub-1']);
    expect(found[0]?.title).toBe('Bash falló 3 veces con el mismo error');
    expect(found[0]?.severity).toBe('warning');
  });
});

describe('expensive_model', () => {
  it('subagente Opus que solo lee y busca; ahorro = costo real - costo con Sonnet 5', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.agent('opus-lee', S);
    seed.agent('sonnet-lee', S, { model: SONNET });
    seed.agent('opus-edita', S);
    for (const id of ['opus-lee', 'sonnet-lee', 'opus-edita']) {
      for (let i = 0; i < 7; i++) seed.action(id, S, 'Read', NOW - 20 * MIN + i * MIN);
      seed.action(id, S, 'Grep', NOW - 12 * MIN);
      seed.action(id, S, 'Bash', NOW - 11 * MIN, { cmdClass: 'git_read' });
      seed.usage(id, S, NOW - 10 * MIN, { model: id === 'sonnet-lee' ? SONNET : undefined, input: 0, output: 20_000, cacheRead: 0, cacheWrite5m: 0 });
    }
    for (let i = 0; i < 5; i++) seed.action('opus-edita', S, 'Edit', NOW - 9 * MIN + i * MIN, { target: `C:\\p\\f${i}.ts` });

    const found = of(habits.findings('today'), 'expensive_model');
    expect(found.map((f) => f.agentId)).toEqual(['opus-lee']);
    // 20 k de salida: $0,40 en Opus 5.5 vs $0,20 en Sonnet 5
    expect(found[0]?.savingsUsd).toBeCloseTo(0.2, 6);
    expect(found[0]?.evidence).toContainEqual({ label: 'Lectura y búsqueda', value: 1, unit: 'pct' });
    expect(found[0]?.recommendation).toContain('model: "sonnet"');
  });
});

describe('low_cache', () => {
  it('aciertos < 50 % con 10+ llamadas, o 3+ llamadas con la cache vencida tras pausas de 5+ min', () => {
    const { seed, habits } = setup();
    seed.session(S);
    for (const id of ['poca', 'vencida', 'buena']) seed.agent(id, S);
    for (let i = 0; i < 10; i++) {
      seed.usage('poca', S, NOW - 30 * MIN + i * MIN, { input: 1_000, cacheRead: 1_000, cacheWrite5m: 5_000 });
      seed.usage('buena', S, NOW - 30 * MIN + i * MIN, { input: 100, cacheRead: 50_000, cacheWrite5m: 1_000 });
    }
    for (let i = 0; i < 4; i++) {
      seed.usage('vencida', S, NOW - 30 * MIN + i * 6 * MIN, { input: 0, cacheRead: 10_000, cacheWrite5m: 50_000 });
    }

    const found = detected(habits, 'low_cache');
    expect(found.map((f) => f.agentId).sort()).toEqual(['poca', 'vencida']);
    const poca = found.find((f) => f.agentId === 'poca')!;
    expect(poca.title).toBe('Solo 14 % del contexto sale de la cache');
    // 50 k escritos x ($5 - $0,20)/MTok
    expect(poca.savingsUsd).toBeCloseTo(50_000 * 4.8e-6, 6);
    const vencida = found.find((f) => f.agentId === 'vencida')!;
    expect(vencida.title).toBe('La cache se venció 3 veces por pausas de más de 5 min');
    expect(vencida.savingsUsd).toBeCloseTo(150_000 * 4.8e-6, 6);
  });
});

describe('long_output', () => {
  it('3+ respuestas de mas de 8 k sin editar; con Write en la misma respuesta no cuenta', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.agent('charla', S);
    seed.agent('escribe', S);
    for (let i = 0; i < 3; i++) {
      const t = NOW - 20 * MIN + i * MIN;
      seed.usage('charla', S, t, { output: 9_000 });
      seed.usage('escribe', S, t, { output: 9_000 });
      seed.action('escribe', S, 'Write', t + 5_000, { target: `C:\\p\\nuevo${i}.ts` });
    }

    const found = of(habits.findings('today'), 'long_output');
    expect(found.map((f) => f.agentId)).toEqual(['charla']);
    // 3 x (9.000 - 4.000) x $20/MTok de salida
    expect(found[0]?.savingsUsd).toBeCloseTo(0.3, 6);
    expect(found[0]?.severity).toBe('info');
  });
});

describe('idle_no_changes', () => {
  it('agente de Desarrollo 10+ min y 15+ acciones sin editar', () => {
    const { seed, habits } = setup();
    seed.session(S);
    const times = { startedAt: NOW - 15 * MIN, lastActivityAt: NOW - MIN };
    seed.agent('dev-quieto', S, { role: 'builder', ...times });
    seed.agent('dev-edita', S, { role: 'builder', ...times });
    seed.agent('explorador', S, { role: 'explorer', ...times });
    for (const id of ['dev-quieto', 'dev-edita', 'explorador']) {
      for (let i = 0; i < 16; i++) seed.action(id, S, 'Grep', NOW - 14 * MIN + i * 30_000);
    }
    seed.action('dev-edita', S, 'Edit', NOW - 2 * MIN, { target: 'C:\\p\\x.ts' });

    const found = of(habits.findings('today'), 'idle_no_changes');
    expect(found.map((f) => f.agentId)).toEqual(['dev-quieto']);
    expect(found[0]?.title).toBe('14 min y 16 acciones sin editar ningún archivo');
    expect(found[0]?.savingsUsd).toBeNull();
  });
});

describe('mcp_unused', () => {
  it('oculto: un servidor MCP cargado sin uso no genera hallazgo', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.event(S, S, NOW - 50 * MIN, 'mcp_loaded', { servers: [{ name: 'supabase', tools: 20 }] });
    seed.action(S, S, 'Read', NOW - 10 * MIN);

    expect(of(habits.findings('today'), 'mcp_unused')).toEqual([]);
  });
});

describe('dup_instructions', () => {
  it('500+ caracteres repetidos entre las instrucciones; ahorro por llamada de la sesion', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.session(S2);
    const files = [
      { name: 'CLAUDE.md', type: 'project', chars: 6_000 },
      { name: 'MEMORY.md', type: 'memory', chars: 3_000 },
    ];
    seed.event(S, S, NOW - 50 * MIN, 'instructions', { files, totalChars: 9_000, dupChars: 1_200 });
    seed.event(S2, S2, NOW - 50 * MIN, 'instructions', { files, totalChars: 9_000, dupChars: 100 });
    for (let i = 0; i < 4; i++) seed.usage(S, S, NOW - 40 * MIN + i * MIN);

    const found = of(habits.findings('today'), 'dup_instructions');
    expect(found.map((f) => f.roomId)).toEqual([S]);
    expect(found[0]?.title).toBe('Instrucciones con ~300 tokens repetidos (CLAUDE.md y MEMORY.md)');
    // 300 tokens x 4 llamadas x $0,20/MTok
    expect(found[0]?.savingsUsd).toBeCloseTo(300 * 4 * 0.2e-6, 6);
  });
});

describe('discarded', () => {
  it('agentes killed/failed/stopped + intentos de workflow reemplazados; savings = su costo', () => {
    const { seed, habits } = setup();
    seed.session(S);
    const ended = { endedAt: NOW - 10 * MIN };
    seed.agent('matado', S, ended);
    seed.notification('matado', S, NOW - 10 * MIN, 'killed');
    seed.spend('matado', S, NOW - 12 * MIN, 0.3);
    seed.agent('bien', S, ended);
    seed.notification('bien', S, NOW - 10 * MIN, 'completed');
    seed.spend('bien', S, NOW - 12 * MIN, 0.4);

    seed.run('wf-1', S, { finalStatus: 'completed' });
    const attempts: Array<[string, string, number, string, number]> = [
      ['wa1', 'k', 1, 'superseded', 0.2],
      ['wa2', 'k', 2, 'result', 0.1],
      ['wb1', 'j', 3, 'failed', 0.1],
      ['wb2', 'j', 4, 'result', 0.05],
      // fallo y nadie lo reintento: tambien es trabajo descartado
      ['wc1', 'm', 5, 'failed', 0.15],
    ];
    for (const [id, key, seq, endStatus, usd] of attempts) {
      seed.agent(id, S, ended);
      seed.runAgent(id, 'wf-1', S, { key, seq, endStatus });
      seed.spend(id, S, NOW - 15 * MIN, usd);
    }

    const found = of(habits.findings('today'), 'discarded');
    expect(found).toHaveLength(1);
    const f = found[0]!;
    expect(f.evidence).toContainEqual({ label: 'Agentes descartados', value: 4, unit: 'count' });
    expect(f.evidence).toContainEqual({ label: 'Reintentos de flujo', value: 2, unit: 'count' });
    expect(f.savingsUsd).toBeCloseTo(0.75, 6);
    expect(f.title).toBe('Trabajo descartado: 4 agentes por $0,75');
  });
});

describe('reglas como hallazgos', () => {
  it('agent_cost, session_day_cost, workflow_cost, turns_without_compact y subagents_per_turn', () => {
    const { seed, habits } = setup();
    seed.session(S, { turnOpen: true, lastPromptAt: NOW - 5 * MIN });
    seed.agent('caro', S, { endedAt: NOW - 20 * MIN });
    seed.spend('caro', S, NOW - 25 * MIN, 0.8);
    seed.spend(S, S, NOW - 30 * MIN, 6);
    seed.run('wf-1', S);
    seed.agent('wa', S, { endedAt: NOW - 20 * MIN });
    seed.runAgent('wa', 'wf-1', S, { key: 'a', seq: 1, endStatus: 'result' });
    seed.spend('wa', S, NOW - 25 * MIN, 3);
    for (let i = 0; i < 30; i++) seed.turn(S, NOW - 5 * 60 * MIN + i * 8 * MIN, NOW - 5 * 60 * MIN + i * 8 * MIN + 5 * MIN);
    for (let i = 0; i < 5; i++) seed.launch(S, S, NOW - 4 * MIN + i * 10_000);

    const found = detected(habits, 'rule');
    const ids = found.map((f) => `${f.ruleId}:${f.agentId ?? ''}`).sort();
    expect(ids).toEqual([
      'agent_cost:caro',
      'agent_cost:wa',
      'session_day_cost:',
      `subagents_per_turn:${S}`,
      `turns_without_compact:${S}`,
      'workflow_cost:',
    ]);
    expect(found.every((f) => f.severity === 'critical' && f.savingsUsd === null)).toBe(true);
    expect(found.find((f) => f.ruleId === 'agent_cost' && f.agentId === 'caro')?.title).toBe('Costo del agente $0,80 > $0,50');
    expect(found.find((f) => f.ruleId === 'turns_without_compact')?.title).toBe('31 turnos sin compactar');
  });
});

describe('alertas vivas', () => {
  it('agente trabajando: costo sobre el tope, racha repetida y fallos seguidos; gana la mas severa', () => {
    const { seed, habits } = setup([S]);
    seed.session(S, { turnOpen: true, lastPromptAt: NOW - 5 * MIN, lastActivityAt: NOW - MIN });
    for (const id of ['costoso', 'enrollado', 'fallando', 'mixto']) seed.agent(id, S);
    seed.agent('terminado', S, { endedAt: NOW - 2 * MIN });
    seed.spend('costoso', S, NOW - 3 * MIN, 0.8);
    seed.spend('terminado', S, NOW - 3 * MIN, 5);
    for (let i = 0; i < 3; i++) seed.action('enrollado', S, 'Bash', NOW - 5 * MIN + i * MIN, { inputHash: 'igual' });
    seed.action('fallando', S, 'Bash', NOW - 5 * MIN);
    seed.action('fallando', S, 'Bash', NOW - 4 * MIN, { isError: true });
    seed.action('fallando', S, 'Bash', NOW - 3 * MIN, { isError: true });
    // la que sigue abierta no corta la racha de fallos
    seed.action('fallando', S, 'Bash', NOW - 2 * MIN, { endedAt: null });
    seed.spend('mixto', S, NOW - 3 * MIN, 0.9);
    seed.action('mixto', S, 'Bash', NOW - 4 * MIN, { isError: true });
    seed.action('mixto', S, 'Bash', NOW - 3 * MIN, { isError: true });
    seed.action(S, S, 'Read', NOW - 4 * MIN, { isError: true });
    seed.action(S, S, 'Read', NOW - 3 * MIN, { isError: true });

    habits.refresh();
    const idx = habits.current();
    expect(idx.agent('costoso')).toEqual({ level: 'critical', title: 'Costo $0,80 > $0,50', source: 'rule', ruleId: 'agent_cost' });
    expect(idx.agent('enrollado')).toEqual({ level: 'critical', title: 'Repitió Bash 3 veces', source: 'rule', ruleId: 'loop_repeats' });
    expect(idx.agent('fallando')).toEqual({ level: 'warning', title: 'Falló 2 veces seguidas', source: 'errors' });
    expect(idx.agent('mixto')?.ruleId).toBe('agent_cost');
    expect(idx.agent(S)?.source).toBe('errors');
    expect(idx.agent('terminado')).toBeNull();
  });

  it('sala: costo de hoy, corrida en curso, turnos sin compactar y subagentes del turno abierto', () => {
    const { seed, habits, rules } = setup(['s1', 's2', 's3', 's4', 's5']);
    for (const id of ['s1', 's2', 's3', 's4', 's5']) seed.session(id);
    seed.spend('s1', 's1', NOW - 30 * MIN, 6);

    seed.turn('s2', NOW - 6 * 60 * MIN, NOW - 6 * 60 * MIN + MIN);
    seed.event('s2', 's2', NOW - 5 * 60 * MIN, 'compact', { trigger: 'manual', preTokens: null, postTokens: null });
    for (let i = 0; i < 30; i++) seed.turn('s2', NOW - 4 * 60 * MIN + i * 6 * MIN, NOW - 4 * 60 * MIN + i * 6 * MIN + MIN);

    seed.db.prepare(`UPDATE sessions SET turn_open = 1, last_prompt_at = ? WHERE session_id = 's3'`).run(NOW - 10 * MIN);
    for (let i = 0; i < 5; i++) seed.launch('s3', 's3', NOW - 9 * MIN + i * MIN);

    seed.run('wf-4', 's4');
    seed.agent('wa', 's4');
    seed.runAgent('wa', 'wf-4', 's4', { key: 'a', seq: 1 });
    seed.spend('wa', 's4', NOW - 5 * MIN, 3);

    habits.refresh();
    const idx = habits.current();
    expect(idx.room('s1')).toEqual({ level: 'critical', title: 'Hoy $6,00 > $5,00', source: 'rule', ruleId: 'session_day_cost' });
    expect(idx.room('s2')).toEqual({
      level: 'warning',
      title: '30 turnos sin compactar',
      source: 'rule',
      ruleId: 'turns_without_compact',
    });
    expect(idx.room('s3')).toEqual({ level: 'warning', title: '5 subagentes en este turno', source: 'rule', ruleId: 'subagents_per_turn' });
    expect(idx.room('s4')).toEqual({ level: 'critical', title: 'Flujo $3,00 > $2,00', source: 'rule', ruleId: 'workflow_cost' });
    expect(idx.room('s5')).toBeNull();

    const live = habits.findings('live');
    const summary = idx.summary();
    // 4 salas + el agente de flujo que trabaja con $3 (> $0,50)
    expect(summary.alerts).toBe(5);
    expect(summary.active).toBe(live.findings.length);
    expect(summary.savingsUsd).toBeCloseTo(live.totalSavingsUsd, 6);
    expect(summary.notifyBrowser).toBe(false);
    expect(idx.habitCount('s2')).toBe(live.findings.filter((f) => f.roomId === 's2').length);
    expect(idx.habitCount('s2')).toBeGreaterThan(0);

    // apagar una regla apaga su alerta en el siguiente refresh
    rules.update('session_day_cost', { enabled: false });
    rules.setNotify(true);
    habits.refresh();
    expect(habits.current().room('s1')).toBeNull();
    expect(habits.current().summary().notifyBrowser).toBe(true);
  });

  it('antes del primer refresh no hay alertas', () => {
    const { habits } = setup();
    expect(habits.current().summary()).toEqual({ active: 0, alerts: 0, savingsUsd: 0, notifyBrowser: false });
  });
});

describe('alcance y privacidad', () => {
  it('live deja fuera las salas archivadas sin actividad posterior; today las incluye', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.spend(S, S, NOW - 30 * MIN, 6);
    seed.db.prepare(`INSERT INTO archived_rooms (session_id, archived_at) VALUES (?, ?)`).run(S, NOW - 30 * 1000);
    expect(habits.findings('live').findings).toHaveLength(0);
    expect(habits.findings('today').findings.length).toBeGreaterThan(0);
  });

  it('nunca sale el texto de un prompt', () => {
    const { seed, habits } = setup([S]);
    seed.session(S, { turnOpen: true, lastPromptAt: NOW - 5 * MIN, lastPromptTitle: 'PROMPT SECRETO del usuario' });
    for (let i = 0; i < 31; i++) seed.turn(S, NOW - 5 * 60 * MIN + i * 8 * MIN, NOW - 5 * 60 * MIN + i * 8 * MIN + MIN, 'PROMPT SECRETO');
    seed.spend(S, S, NOW - 30 * MIN, 6);
    const res = habits.findings('live');
    expect(res.findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(res)).not.toContain('SECRETO');
  });

  it('ordena por severidad y luego por ahorro; byKind y total cuadran', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.agent('sub-1', S);
    seed.usage('sub-1', S, NOW - 4 * MIN, { input: 0, cacheRead: 350_000, cacheWrite5m: 0 });
    for (let i = 0; i < 3; i++) {
      seed.action(S, S, 'Read', NOW - 30 * MIN + i * MIN, { target: 'C:\\p\\a.ts', readPartial: 0, resultChars: 8_000 });
    }
    const res = habits.findings('today');
    const rank = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < res.findings.length; i++) {
      expect(rank[res.findings[i - 1]!.severity]).toBeLessThanOrEqual(rank[res.findings[i]!.severity]);
    }
    const total = res.findings.reduce((s, f) => s + (f.savingsUsd ?? 0), 0);
    expect(res.totalSavingsUsd).toBeCloseTo(total, 4);
    expect(res.byKind.reduce((s, k) => s + k.count, 0)).toBe(res.findings.length);
  });
});

describe('rutas', () => {
  async function app() {
    const ctx = setup();
    ctx.seed.session(S);
    let changes = 0;
    const server = Fastify({ logger: false });
    registerHabitsRoutes(server, { habits: ctx.habits, rules: ctx.rules, changed: () => changes++ });
    return { server, changes: () => changes };
  }

  it('GET /api/habits con rango valido e invalido', async () => {
    const { server } = await app();
    const live = await server.inject({ method: 'GET', url: '/api/habits' });
    expect(live.statusCode).toBe(200);
    expect((live.json() as HabitsResponse).range).toBe('live');
    const week = await server.inject({ method: 'GET', url: '/api/habits?range=week' });
    expect((week.json() as HabitsResponse).range).toBe('week');
    expect((await server.inject({ method: 'GET', url: '/api/habits?range=all' })).statusCode).toBe(400);
    await server.close();
  });

  it('GET y PUT de reglas: valor, apagar, validacion y notificacion; cada cambio avisa', async () => {
    const { server, changes } = await app();
    const list = (await server.inject({ method: 'GET', url: '/api/rules' })).json() as RulesResponse;
    expect(list.rules.map((r) => r.id)).toEqual([
      'agent_cost',
      'session_day_cost',
      'workflow_cost',
      'turns_without_compact',
      'subagents_per_turn',
      'loop_repeats',
    ]);
    expect(list.windowDays).toBe(30);

    const put = await server.inject({ method: 'PUT', url: '/api/rules/agent_cost', payload: { value: 1.5 } });
    expect(put.statusCode).toBe(200);
    const custom = (put.json() as RulesResponse).rules.find((r) => r.id === 'agent_cost');
    expect(custom).toMatchObject({ value: 1.5, source: 'custom', enabled: true });

    const off = (await server.inject({ method: 'PUT', url: '/api/rules/loop_repeats', payload: { enabled: false } })).json() as RulesResponse;
    expect(off.rules.find((r) => r.id === 'loop_repeats')?.enabled).toBe(false);

    const back = (await server.inject({ method: 'PUT', url: '/api/rules/agent_cost', payload: { value: null } })).json() as RulesResponse;
    expect(back.rules.find((r) => r.id === 'agent_cost')?.source).toBe('floor');

    const bad = [
      { url: '/api/rules/agent_cost', payload: { value: 0 } },
      // redondea a $0,00: quedaria guardado como un tope de 0
      { url: '/api/rules/agent_cost', payload: { value: 0.001 } },
      { url: '/api/rules/agent_cost', payload: { value: 'x' } },
      { url: '/api/rules/loop_repeats', payload: { value: 2.5 } },
      // con 1 toda accion seria un bucle; mas de 50 no cabe en la cola de las alertas
      { url: '/api/rules/loop_repeats', payload: { value: 1 } },
      { url: '/api/rules/loop_repeats', payload: { value: 51 } },
      { url: '/api/rules/agent_cost', payload: { enabled: 'si' } },
      { url: '/api/rules/agent_cost', payload: {} },
      { url: '/api/rules/notify', payload: { enabled: 1 } },
    ];
    for (const b of bad) expect((await server.inject({ method: 'PUT', ...b })).statusCode).toBe(400);
    const tiny = await server.inject({ method: 'PUT', url: '/api/rules/agent_cost', payload: { value: 0.001 } });
    expect((tiny.json() as { error: string }).error).toBe('value debe ser un monto entre $0,01 y $100.000');
    const one = await server.inject({ method: 'PUT', url: '/api/rules/loop_repeats', payload: { value: 1 } });
    expect((one.json() as { error: string }).error).toBe('value debe ser un entero entre 2 y 50');
    expect((await server.inject({ method: 'PUT', url: '/api/rules/no_existe', payload: { value: 1 } })).statusCode).toBe(404);

    const notify = (await server.inject({ method: 'PUT', url: '/api/rules/notify', payload: { enabled: true } })).json() as RulesResponse;
    expect(notify.notifyBrowser).toBe(true);
    expect(changes()).toBe(4);
    await server.close();
  });
});

describe('lista: juntar, tope y total', () => {
  it('en los rangos historicos junta los del mismo tipo en una sesion; en live solo si son mas de 3', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.session(S2);
    for (let i = 0; i < 5; i++) {
      seed.agent(`sub-${i}`, S);
      seed.usage(`sub-${i}`, S, NOW - 10 * MIN + i * MIN, { input: 0, cacheRead: 200_000 + i * 50_000, cacheWrite5m: 0 });
    }
    for (let i = 0; i < 3; i++) {
      seed.agent(`otro-${i}`, S2);
      seed.usage(`otro-${i}`, S2, NOW - 10 * MIN, { input: 0, cacheRead: 160_000, cacheWrite5m: 0 });
    }

    const today = habits.findings('today');
    const big = of(today, 'big_context');
    expect(big.map((f) => f.id).sort()).toEqual([`grupo:big_context:${S}`, `grupo:big_context:${S2}`]);
    const g = big.find((f) => f.roomId === S)!;
    expect(g.title).toBe('5 agentes con más de 150 k tokens de contexto en una llamada');
    expect(g).toMatchObject({ severity: 'critical', agentId: null, agentName: null, live: true });
    expect(g.evidence).toEqual([
      { label: 'Agentes', value: 5, unit: 'count' },
      { label: 'Contexto máximo', value: 400_000, unit: 'tokens' },
      { label: 'Llamadas sobre 150 k', value: 5, unit: 'count' },
    ]);
    // exceso 50 k + 100 k + 150 k + 200 k + 250 k x $0,20/MTok (cache read de Opus 5.5)
    expect(g.savingsUsd).toBeCloseTo(750_000 * 0.2e-6, 6);
    expect(today.total).toBe(2);
    expect(today.byKind).toEqual([{ kind: 'big_context', count: 2, savingsUsd: 0.156 }]);

    const live = habits.findings('live');
    const liveBig = of(live, 'big_context');
    expect(liveBig.filter((f) => f.roomId === S).map((f) => f.id)).toEqual([`grupo:big_context:${S}`]);
    expect(liveBig.filter((f) => f.roomId === S2).map((f) => f.agentId).sort()).toEqual(['otro-0', 'otro-1', 'otro-2']);
    expect(live.total).toBe(4);
    expect(live.totalSavingsUsd).toBeCloseTo(today.totalSavingsUsd, 6);
    // el resumen de la oficina cuenta lo mismo que la lista viva
    habits.refresh();
    expect(habits.current().summary().active).toBe(4);
    expect(habits.current().habitCount(S)).toBe(1);
  });

  it('repeated_read juntado cuenta los archivos distintos y habla al lead por lo suyo y por sus subagentes', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.agent('dev', S, { role: 'builder' });
    let t = NOW - 50 * MIN;
    for (const file of ['C:\\p\\a.ts', 'C:\\p\\b.ts']) {
      for (let i = 0; i < 3; i++) seed.action('dev', S, 'Read', (t += MIN), { target: file, readPartial: 0, resultChars: 4_000 });
    }
    // el mismo a.ts, escrito distinto
    for (let i = 0; i < 3; i++) seed.action(S, S, 'Read', (t += MIN), { target: 'c:/p/A.ts', readPartial: 0, resultChars: 4_000 });

    const found = of(habits.findings('today'), 'repeated_read');
    expect(found).toHaveLength(1);
    const g = found[0]!;
    expect(g.id).toBe(`grupo:repeated_read:${S}`);
    expect(g.title).toBe('2 agentes releyeron 2 archivos sin editarlos');
    expect(g.evidence).toEqual([
      { label: 'Agentes', value: 2, unit: 'count' },
      { label: 'Archivos', value: 2, unit: 'count' },
      { label: 'Lecturas sin editar', value: 9, unit: 'count' },
      { label: 'Tokens releídos', value: 6_000, unit: 'tokens', estimated: true },
    ]);
    // 3 rachas x 2 relecturas x 1.000 tokens x $5/MTok
    expect(g.savingsUsd).toBeCloseTo(0.03, 6);
    expect(g.copyText.startsWith('Ya leíste varias veces')).toBe(true);
    expect(g.copyText).toContain('Cuando delegues trabajo a subagentes, pídeles que no relean');
  });

  it('reglas distintas no se juntan entre si', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.agent('caro', S, { endedAt: NOW - 20 * MIN });
    seed.spend('caro', S, NOW - 25 * MIN, 0.8);
    seed.spend(S, S, NOW - 30 * MIN, 6);
    seed.run('wf-1', S, { finalStatus: 'completed' });
    seed.agent('wa', S, { endedAt: NOW - 20 * MIN });
    seed.runAgent('wa', 'wf-1', S, { key: 'a', seq: 1, endStatus: 'result' });
    seed.spend('wa', S, NOW - 25 * MIN, 3);

    const rules = of(habits.findings('today'), 'rule');
    expect(rules.map((f) => f.id.replace(/:\d{4}-\d{2}-\d{2}$/, '')).sort()).toEqual([
      `grupo:rule:agent_cost:${S}`,
      `rule:session_day_cost:${S}`,
      'rule:workflow_cost:wf-1',
    ]);
    const agents = rules.find((f) => f.ruleId === 'agent_cost')!;
    expect(agents.title).toBe('2 agentes costaron más de $0,50');
    expect(agents.evidence).toContainEqual({ label: 'Costo del agente', value: 3.8, unit: 'usd' });
    expect(agents.evidence).toContainEqual({ label: 'Tope', value: 0.5, unit: 'usd' });
  });

  it('corta la lista en HABITS_LIST_MAX y manda el total; byKind y el ahorro cuentan todos', () => {
    const { seed, habits } = setup();
    for (let i = 0; i < HABITS_LIST_MAX + 5; i++) {
      const id = `sala-${String(i).padStart(3, '0')}`;
      seed.session(id);
      seed.usage(id, id, NOW - 10 * MIN, { input: 0, cacheRead: 160_000, cacheWrite5m: 0 });
    }
    const res = habits.findings('today');
    expect(res.findings).toHaveLength(HABITS_LIST_MAX);
    expect(res.total).toBe(HABITS_LIST_MAX + 5);
    expect(res.byKind).toHaveLength(1);
    expect(res.byKind[0]).toMatchObject({ kind: 'big_context', count: HABITS_LIST_MAX + 5 });
    // 10 k de exceso por sala x $0,20/MTok
    expect(res.byKind[0]?.savingsUsd).toBeCloseTo((HABITS_LIST_MAX + 5) * 10_000 * 0.2e-6, 6);
    expect(res.totalSavingsUsd).toBeCloseTo((HABITS_LIST_MAX + 5) * 10_000 * 0.2e-6, 6);
  });
});

describe('ahorro sin contar dos veces', () => {
  it('bucle y error repetido de la misma llamada: cada uno conserva su ahorro, el total cuenta uno', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.agent('sub-1', S);
    for (let i = 0; i < 3; i++) {
      seed.action('sub-1', S, 'Bash', NOW - 10 * MIN + i * MIN, { inputHash: 'mismo', isError: true, resultHash: 'e1' });
    }
    seed.spend('sub-1', S, NOW - 9 * MIN, 0.1);
    seed.spend('sub-1', S, NOW - 8 * MIN, 0.1);

    const res = habits.findings('live');
    expect(of(res, 'loop')[0]?.savingsUsd).toBeCloseTo(0.2, 6);
    expect(of(res, 'same_error')[0]?.savingsUsd).toBeCloseTo(0.2, 6);
    expect(res.totalSavingsUsd).toBeCloseTo(0.2, 6);
    expect(res.byKind.reduce((s, k) => s + k.savingsUsd, 0)).toBeCloseTo(0.2, 6);
    expect(res.byKind.find((k) => k.kind === 'same_error')).toMatchObject({ count: 1, savingsUsd: 0 });
  });

  it('errores distintos o de otra llamada suman aparte', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.agent('sub-1', S);
    for (let i = 0; i < 3; i++) seed.action('sub-1', S, 'Bash', NOW - 20 * MIN + i * MIN, { inputHash: 'bucle' });
    for (let i = 0; i < 3; i++) {
      seed.action('sub-1', S, 'Bash', NOW - 10 * MIN + i * MIN, { inputHash: `otro-${i}`, isError: true, resultHash: 'e1' });
    }
    seed.spend('sub-1', S, NOW - 9 * MIN, 0.1);
    seed.spend('sub-1', S, NOW - 8 * MIN, 0.1);
    expect(habits.findings('live').totalSavingsUsd).toBeCloseTo(0.4, 6);
  });

  it('releer y leer completo el mismo archivo: el total cuenta el mayor', () => {
    const { seed, habits } = setup();
    seed.session(S);
    for (let i = 0; i < 3; i++) {
      seed.action(S, S, 'Read', NOW - 10 * MIN + i * MIN, {
        target: 'C:\\p\\big.ts',
        readPartial: 0,
        resultLines: 900,
        resultChars: 36_000,
        inputHash: 'misma-lectura',
      });
    }
    const res = habits.findings('live');
    // releer: 2 x 9.000 tokens x $5/MTok = 0,09 · completo: 3 x 9.000 x (1 - 200/900) x $5/MTok = 0,105
    expect(of(res, 'repeated_read')[0]?.savingsUsd).toBeCloseTo(0.09, 6);
    expect(of(res, 'full_read')[0]?.savingsUsd).toBeCloseTo(0.105, 6);
    expect(res.totalSavingsUsd).toBeCloseTo(0.105, 6);
  });
});

describe('detectores: casos corregidos', () => {
  it('esperar un proceso (BashOutput, TaskOutput, Monitor) no es un bucle ni dispara la alerta viva', () => {
    const { seed, habits } = setup([S]);
    seed.session(S);
    for (const tool of ['BashOutput', 'TaskOutput', 'Monitor']) {
      seed.agent(`espera-${tool}`, S);
      for (let i = 0; i < 4; i++) seed.action(`espera-${tool}`, S, tool, NOW - 5 * MIN + i * MIN, { inputHash: 'shell-1' });
    }
    expect(detected(habits, 'loop')).toHaveLength(0);
    habits.refresh();
    for (const tool of ['BashOutput', 'TaskOutput', 'Monitor']) expect(habits.current().agent(`espera-${tool}`)).toBeNull();
  });

  it('los copyText de subagentes le hablan al lead; idleCopy usa el modelo real y no pide lanzar subagentes al subagente', () => {
    const { seed, habits } = setup();
    seed.session(S);
    const times = { startedAt: NOW - 15 * MIN, lastActivityAt: NOW - MIN };
    seed.agent('dev', S, { role: 'builder', model: SONNET, ...times });
    seed.agent('dev-opus', S, { role: 'builder', ...times });
    let t = NOW - 14 * MIN;
    for (let i = 0; i < 3; i++) seed.action('dev', S, 'Read', (t += 10_000), { target: 'C:\\p\\a.ts', readPartial: 0, resultChars: 1_000 });
    for (let i = 0; i < 3; i++) seed.action('dev', S, 'Bash', (t += 10_000), { inputHash: 'igual' });
    for (const id of ['dev', 'dev-opus']) for (let i = 0; i < 16; i++) seed.action(id, S, 'Grep', (t += 10_000));
    for (let i = 0; i < 3; i++) seed.action(S, S, 'Read', (t += 10_000), { target: 'C:\\p\\b.ts', readPartial: 0, resultChars: 1_000 });

    const res = habits.findings('live');
    const reads = of(res, 'repeated_read');
    expect(reads.find((f) => f.agentId === S)?.copyText.startsWith('Ya leíste b.ts')).toBe(true);
    expect(reads.find((f) => f.agentId === 'dev')?.copyText).toBe(
      'Cuando delegues trabajo de Desarrollo, pídele al subagente que no relea completo un archivo que ya leyó (como a.ts): que use lo que ya tiene en el contexto y, si necesita un tramo, lo ubique con Grep y lo lea con offset/limit.',
    );
    expect(of(res, 'loop')[0]?.copyText.startsWith('Cuando delegues trabajo de Desarrollo, pídele al subagente que no repita Bash')).toBe(true);
    const idle = of(res, 'idle_no_changes');
    const sonnet = idle.find((f) => f.agentId === 'dev')!;
    expect(sonnet.recommendation).not.toContain('caro');
    expect(idle.find((f) => f.agentId === 'dev-opus')?.recommendation).toContain('con Opus, un modelo caro');
    expect(sonnet.copyText).toContain('lanza tú primero un subagente');
    for (const f of res.findings.filter((x) => x.agentId !== null && x.agentId !== S)) {
      expect(f.copyText).not.toMatch(/Ya leíste|Estás repitiendo|Llevas|delega esa búsqueda/);
    }
  });

  it('expensive_model no marca a revisores, planificadores, seguridad ni al tipo Plan', () => {
    const { seed, habits } = setup();
    seed.session(S);
    const readers: Array<[string, Parameters<Seed['agent']>[2]]> = [
      ['revisor', { role: 'reviewer' }],
      ['planificador', { role: 'planner' }],
      ['seguridad', { role: 'security' }],
      ['plan', { agentType: 'Plan' }],
      ['explorador', { role: 'explorer' }],
    ];
    for (const [id, o] of readers) {
      seed.agent(id, S, o);
      for (let i = 0; i < 8; i++) seed.action(id, S, 'Read', NOW - 20 * MIN + i * MIN);
      seed.usage(id, S, NOW - 10 * MIN, { input: 0, output: 20_000, cacheRead: 0, cacheWrite5m: 0 });
    }
    expect(detected(habits, 'expensive_model').map((f) => f.agentId)).toEqual(['explorador']);
  });

  it('una edicion exitosa de otro agente de la sesion corta la racha de relecturas', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.agent('dev', S, { role: 'builder' });
    const read = (file: string, ts: number) => seed.action(S, S, 'Read', ts, { target: file, readPartial: 0, resultChars: 1_000 });
    read('C:\\p\\office.ts', NOW - 30 * MIN);
    read('C:\\p\\office.ts', NOW - 29 * MIN);
    seed.action('dev', S, 'Edit', NOW - 28 * MIN, { target: 'c:/p/OFFICE.ts' });
    read('C:\\p\\office.ts', NOW - 27 * MIN);
    // una edicion fallida del subagente no corta
    read('C:\\p\\x.ts', NOW - 20 * MIN);
    read('C:\\p\\x.ts', NOW - 19 * MIN);
    seed.action('dev', S, 'Edit', NOW - 18 * MIN, { target: 'C:\\p\\x.ts', isError: true });
    read('C:\\p\\x.ts', NOW - 17 * MIN);

    expect(detected(habits, 'repeated_read').map((f) => f.title)).toEqual(['Leyó x.ts 3 veces sin editarlo']);
  });

  it('needs_compact solo para sesiones abiertas', () => {
    const { seed, habits } = setup([S2]);
    seed.session(S);
    seed.session(S2);
    for (let i = 0; i < 30; i++) {
      seed.usage(S, S, NOW - 60 * MIN + i * MIN, { input: 0, cacheRead: 130_000, cacheWrite5m: 0 });
      seed.usage(S2, S2, NOW - 60 * MIN + i * MIN, { input: 0, cacheRead: 130_000, cacheWrite5m: 0 });
    }
    expect(of(habits.findings('today'), 'needs_compact').map((f) => f.roomId)).toEqual([S2]);
  });

  it('long_output no cuenta las respuestas que lanzan un flujo, un encargo o una tarea', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.agent('charla', S);
    seed.agent('orquesta', S);
    const tools = ['Workflow', 'Agent', 'Task'];
    for (let i = 0; i < 3; i++) {
      const t = NOW - 20 * MIN + i * MIN;
      seed.usage('charla', S, t, { output: 9_000 });
      seed.usage('orquesta', S, t, { output: 9_000 });
      seed.action('orquesta', S, tools[i]!, t + 5_000);
    }
    const found = detected(habits, 'long_output');
    expect(found.map((f) => f.agentId)).toEqual(['charla']);
    expect(found[0]?.recommendation).toContain('razonamiento');
  });
});

describe('reglas: casos corregidos', () => {
  it('en una sesion abierta el lead inactivo segun el registro no tiene alertas ni aviso de subagentes del turno', () => {
    const busy = new Set<string>();
    const { seed, habits } = setup([S], { busyIds: () => busy });
    seed.session(S, { turnOpen: true, lastPromptAt: NOW - 10 * MIN, lastActivityAt: NOW - MIN });
    seed.action(S, S, 'Bash', NOW - 4 * MIN, { isError: true });
    seed.action(S, S, 'Bash', NOW - 3 * MIN, { isError: true });
    for (let i = 0; i < 5; i++) seed.launch(S, S, NOW - 9 * MIN + i * MIN);

    habits.refresh();
    expect(habits.current().agent(S)).toBeNull();
    expect(habits.current().room(S)).toBeNull();

    busy.add(S);
    habits.refresh();
    expect(habits.current().agent(S)?.source).toBe('errors');
    expect(habits.current().room(S)).toEqual({ level: 'warning', title: '5 subagentes en este turno', source: 'rule', ruleId: 'subagents_per_turn' });
  });

  it('agentName usa la persona de la oficina cuando el agente sigue visible', () => {
    const { seed, habits } = setup(undefined, { personaName: (id) => (id === 'sub-1' ? 'Persona visible' : null) });
    seed.session(S);
    for (const id of ['sub-1', 'sub-2']) {
      seed.agent(id, S, { agentType: 'Explore' });
      seed.usage(id, S, NOW - 5 * MIN, { input: 0, cacheRead: 200_000, cacheWrite5m: 0 });
    }
    const found = detected(habits, 'big_context');
    expect(found.find((f) => f.agentId === 'sub-1')?.agentName).toBe('Persona visible');
    const other = found.find((f) => f.agentId === 'sub-2')?.agentName;
    expect(other).toBeTruthy();
    expect(other).not.toBe('Persona visible');
  });

  it('agent_cost mide el costo de toda la vida del agente, como la alerta viva', () => {
    const { seed, habits } = setup();
    seed.session(S);
    seed.agent('largo', S, { startedAt: NOW - 15 * 60 * MIN });
    // antes de la medianoche (NOW es mediodia) y hoy
    seed.spend('largo', S, NOW - 14 * 60 * MIN, 0.4);
    seed.spend('largo', S, NOW - 10 * MIN, 0.3);
    const found = detected(habits, 'rule').filter((f) => f.ruleId === 'agent_cost');
    expect(found.map((f) => f.agentId)).toEqual(['largo']);
    expect(found[0]?.evidence).toContainEqual({ label: 'Costo del agente', value: 0.7, unit: 'usd' });
  });

  it('workflow_cost sigue en curso entre fases si el flujo se movio hace poco', () => {
    const { seed, habits } = setup([S]);
    seed.session(S);
    seed.run('wf-1', S);
    seed.agent('wa', S, { endedAt: NOW - 2 * MIN });
    seed.runAgent('wa', 'wf-1', S, { key: 'a', seq: 1, endStatus: 'result' });
    seed.spend('wa', S, NOW - 3 * MIN, 3);
    const launched = (ts: number) => seed.db.prepare(`UPDATE workflow_runs SET launched_at = ? WHERE run_id = 'wf-1'`).run(ts);

    launched(NOW - MIN);
    habits.refresh();
    expect(habits.current().room(S)).toEqual({ level: 'critical', title: 'Flujo $3,00 > $2,00', source: 'rule', ruleId: 'workflow_cost' });

    launched(NOW - 10 * MIN);
    habits.refresh();
    expect(habits.current().room(S)).toBeNull();
  });
});
