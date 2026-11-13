import { describe, expect, it } from 'vitest';
import type { RuleConfig, RuleId } from '@shared/contract';
import { p90, RulesService } from '../src/habits/rules';
import { DAY, habitsDb, MIN, NOW, Seed } from './habitsDb';

function setup() {
  const db = habitsDb();
  let now = NOW;
  const clock = { set: (ms: number) => (now = ms), get: () => now };
  const rules = new RulesService(db, () => now);
  return { db, seed: new Seed(db), rules, clock };
}

function rule(rules: RulesService, id: RuleId): RuleConfig {
  const r = rules.list().rules.find((x) => x.id === id);
  if (!r) throw new Error(`falta la regla ${id}`);
  return r;
}

describe('p90', () => {
  it('rango mas cercano: siempre devuelve una muestra real', () => {
    expect(p90([])).toBeNull();
    expect(p90([5])).toBe(5);
    expect(p90([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])).toBe(9);
    expect(p90(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(18);
  });
});

describe('calibracion', () => {
  it('con menos de RULE_MIN_SAMPLES muestras usa el piso', () => {
    const { seed, rules } = setup();
    for (let i = 0; i < 5; i++) seed.subagentTask('s', NOW - DAY, 3);
    expect(rule(rules, 'agent_cost')).toEqual({
      id: 'agent_cost',
      label: 'Costo de un agente',
      unit: 'usd',
      value: 0.5,
      source: 'floor',
      calibratedValue: null,
      samples: 5,
      floor: 0.5,
      enabled: true,
    });
    expect(rules.value('agent_cost')).toBe(0.5);
  });

  it('p90 de los ultimos 30 dias; nunca bajo el piso; lo viejo no cuenta', () => {
    const { seed, rules } = setup();
    for (let i = 1; i <= 20; i++) seed.subagentTask('s', NOW - DAY, i / 10);
    for (let i = 0; i < 20; i++) seed.subagentTask('s', NOW - 40 * DAY, 50);
    expect(rule(rules, 'agent_cost')).toMatchObject({ value: 1.8, source: 'calibrated', calibratedValue: 1.8, samples: 20 });

    const low = setup();
    for (let i = 0; i < 12; i++) low.seed.subagentTask('s', NOW - DAY, 0.1);
    expect(rule(low.rules, 'agent_cost')).toMatchObject({ value: 0.5, source: 'calibrated', calibratedValue: 0.1 });
  });

  it('calibra cada regla con sus propias muestras', () => {
    const { seed, rules } = setup();
    const t0 = NOW - 2 * DAY;
    for (let k = 1; k <= 12; k++) {
      const s = `sesion-${k}`;
      seed.session(s, { lastActivityAt: t0 });
      seed.spend(s, s, t0, k);
      // k turnos sin compactar; el primero lanza k subagentes
      for (let i = 0; i < k; i++) seed.turn(s, t0 + i * 10 * MIN, t0 + i * 10 * MIN + 5 * MIN);
      for (let i = 0; i < k; i++) seed.launch(s, s, t0 + MIN + i * 1_000);
    }
    // una sesion con compactacion: dos tramos de 3 turnos
    seed.session('compacta', { lastActivityAt: t0 });
    for (let i = 0; i < 6; i++) seed.turn('compacta', t0 + i * 10 * MIN, t0 + i * 10 * MIN + 5 * MIN);
    seed.event('compacta', 'compacta', t0 + 25 * MIN, 'compact', { trigger: 'manual', preTokens: null, postTokens: null });
    for (let r = 1; r <= 10; r++) {
      seed.run(`wf-${r}`, 'sesion-1');
      seed.agent(`wa-${r}`, 'sesion-1', { endedAt: t0 + MIN });
      seed.runAgent(`wa-${r}`, `wf-${r}`, 'sesion-1', { key: 'a', seq: 1 });
      seed.spend(`wa-${r}`, 'sesion-1', t0 + 30 * MIN, r);
      for (let i = 0; i < r; i++) seed.action(`wa-${r}`, 'sesion-1', 'Bash', t0 + i * MIN, { inputHash: 'igual' });
    }

    // costo por (sesion, dia): 12 sesiones con 1..12, mas sesion-1 con 1..10 de sus flujos ese mismo dia
    const day = rule(rules, 'session_day_cost');
    expect(day.samples).toBe(12);
    expect(day.calibratedValue).toBe(12);
    expect(rule(rules, 'workflow_cost')).toMatchObject({ samples: 10, calibratedValue: 9, value: 9 });
    // tramos: 1..12 y 3, 3 = 14 muestras; p90 = 11 < piso 30
    expect(rule(rules, 'turns_without_compact')).toMatchObject({ samples: 14, calibratedValue: 11, value: 30 });
    expect(rule(rules, 'subagents_per_turn')).toMatchObject({ samples: 12, calibratedValue: 11, value: 11 });
    // rachas maximas por agente: 1..10
    expect(rule(rules, 'loop_repeats')).toMatchObject({ samples: 10, calibratedValue: 9, value: 9, source: 'calibrated' });
  });

  it('se recalibra cuando la calibracion tiene mas de 1 h', () => {
    const { seed, rules, clock } = setup();
    const before = rules.list();
    expect(rule(rules, 'agent_cost').samples).toBe(0);
    for (let i = 1; i <= 10; i++) seed.subagentTask('s', NOW - MIN, i);
    clock.set(NOW + 59 * MIN);
    expect(rule(rules, 'agent_cost').samples).toBe(0);
    expect(rules.list().calibratedAt).toBe(before.calibratedAt);
    clock.set(NOW + 61 * MIN);
    expect(rule(rules, 'agent_cost')).toMatchObject({ samples: 10, calibratedValue: 9, value: 9 });
    expect(rules.list().calibratedAt).toBe(new Date(NOW + 61 * MIN).toISOString());
  });
});

describe('ajustes del usuario', () => {
  it('valor propio (custom) y volver al calibrado con null', () => {
    const { rules } = setup();
    const res = rules.update('workflow_cost', { value: 7.456 });
    expect(res.rules.find((r) => r.id === 'workflow_cost')).toMatchObject({ value: 7.46, source: 'custom' });
    expect(rules.value('workflow_cost')).toBe(7.46);
    rules.update('loop_repeats', { value: 4.4 });
    expect(rules.value('loop_repeats')).toBe(4);
    rules.update('workflow_cost', { value: null });
    expect(rule(rules, 'workflow_cost')).toMatchObject({ value: 2, source: 'floor' });
    expect(() => rules.update('agent_cost', { value: 0 })).toThrow(RangeError);
    expect(() => rules.update('agent_cost', { value: Number.NaN })).toThrow(RangeError);
  });

  it('apagada: value() null, enabled false y conserva su valor; se vuelve a encender', () => {
    const { rules } = setup();
    rules.update('agent_cost', { value: 3 });
    rules.update('agent_cost', { enabled: false });
    expect(rules.value('agent_cost')).toBeNull();
    expect(rule(rules, 'agent_cost')).toMatchObject({ enabled: false, value: 3, source: 'custom' });
    rules.update('agent_cost', { enabled: true });
    expect(rules.value('agent_cost')).toBe(3);
  });

  it('se guarda en settings (clave rules) y sobrevive a un reinicio', () => {
    const { db, rules } = setup();
    rules.update('session_day_cost', { value: 12 });
    rules.update('subagents_per_turn', { enabled: false });
    rules.setNotify(true);
    const stored = db.prepare(`SELECT value FROM settings WHERE key = 'rules'`).get() as { value: string };
    expect(JSON.parse(stored.value)).toEqual({
      overrides: { session_day_cost: 12 },
      disabled: ['subagents_per_turn'],
      notifyBrowser: true,
    });
    const again = new RulesService(db, () => NOW);
    expect(again.value('session_day_cost')).toBe(12);
    expect(again.value('subagents_per_turn')).toBeNull();
    expect(again.notifyBrowser()).toBe(true);
    expect(again.list().notifyBrowser).toBe(true);
  });

  it('el rango se mira ya redondeado: un monto que queda en $0,00 se rechaza', () => {
    const { rules } = setup();
    expect(() => rules.update('agent_cost', { value: 0.001 })).toThrow(RangeError);
    expect(rules.value('agent_cost')).toBe(0.5);
    rules.update('agent_cost', { value: 0.006 });
    expect(rules.value('agent_cost')).toBe(0.01);
  });

  it('loop_repeats va de 2 a 50; un valor guardado fuera de ese rango se recorta al leer', () => {
    const { db, rules } = setup();
    expect(() => rules.update('loop_repeats', { value: 1 })).toThrow(RangeError);
    expect(() => rules.update('loop_repeats', { value: 51 })).toThrow(RangeError);
    rules.update('loop_repeats', { value: 50 });
    expect(rules.value('loop_repeats')).toBe(50);

    db.prepare(`UPDATE settings SET value = ? WHERE key = 'rules'`).run(
      JSON.stringify({ overrides: { loop_repeats: 1 }, disabled: [], notifyBrowser: false }),
    );
    expect(new RulesService(db, () => NOW).value('loop_repeats')).toBe(2);
    db.prepare(`UPDATE settings SET value = ? WHERE key = 'rules'`).run(
      JSON.stringify({ overrides: { loop_repeats: 500 }, disabled: [], notifyBrowser: false }),
    );
    expect(rule(new RulesService(db, () => NOW), 'loop_repeats')).toMatchObject({ value: 50, source: 'custom' });
  });

  it('las esperas (BashOutput, TaskOutput, Monitor) no calibran loop_repeats', () => {
    const { seed, rules } = setup();
    for (let k = 0; k < 12; k++) {
      const id = `espera-${k}`;
      seed.agent(id, 's');
      for (let i = 0; i < 20; i++) seed.action(id, 's', ['BashOutput', 'TaskOutput', 'Monitor'][k % 3]!, NOW - DAY + i * MIN, { inputHash: 'shell' });
    }
    expect(rule(rules, 'loop_repeats')).toMatchObject({ samples: 0, value: 3, source: 'floor' });
  });

  it('un valor guardado corrupto se ignora', () => {
    const { db } = setup();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('rules', ?)`).run(
      JSON.stringify({ overrides: { agent_cost: -1, no_existe: 3, loop_repeats: 5 }, disabled: ['x', 'agent_cost'], notifyBrowser: 'si' }),
    );
    const rules = new RulesService(db, () => NOW);
    expect(rules.value('agent_cost')).toBeNull();
    expect(rules.value('loop_repeats')).toBe(5);
    expect(rules.notifyBrowser()).toBe(false);
  });
});
