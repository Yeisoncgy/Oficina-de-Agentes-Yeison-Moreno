// HUD en vivo (W2b): identidad, alertas, tira del flujo, pronostico, notificaciones y atajo A. Solo logica
// pura: los componentes leen estas funciones.
import { describe, expect, it } from 'vitest';
import {
  riskOf,
  type LiveAlert,
  type OfficeAgent,
  type OfficeRoom,
  type OfficeSnapshot,
  type TokenBreakdown,
  type WorkflowAgentRef,
  type WorkflowRun,
} from '@shared/contract';
import {
  agentIdentity,
  agentRole,
  childrenTotals,
  drawerAlert,
  habitsBadge,
  PLACE_LABEL,
  projectBranchText,
  roomAlert,
} from '@/lib/office';
import {
  flowPipeline,
  forecastDetail,
  forecastText,
  letterAction,
  pipelineText,
  ROLE_LABEL,
  runForecast,
  WORKFLOW_ROLES,
} from '@/lib/workflows';
import {
  ALERT_FORGET_AFTER_MS,
  alertKey,
  createAlertNotifier,
  liveAlerts,
  MAX_NOTICES_AT_ONCE,
  type AlertNotice,
  type NotifyEnv,
} from '@/hud/useAlertNotifications';

// ---- datos sinteticos ----

const tokens = (total = 0): TokenBreakdown => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, total });

function agent(id: string, partial: Partial<OfficeAgent> = {}): OfficeAgent {
  return {
    id,
    kind: 'subagent',
    agentType: 'tr-builder',
    displayName: id,
    status: 'working',
    task: null,
    action: null,
    model: 'claude-opus-5-5',
    tokens: tokens(),
    costUsd: 0,
    deskIndex: 1,
    ...partial,
  };
}

function room(id: string, partial: Partial<OfficeRoom> = {}): OfficeRoom {
  return {
    id,
    projectName: 'proyecto-prueba',
    title: 'proyecto-prueba',
    cwd: '/tmp/proyecto-prueba',
    open: true,
    busy: true,
    lastActivityAt: '2026-09-28T19:59:00Z',
    lead: agent(id, { kind: 'lead', agentType: 'lead', displayName: 'Ana', deskIndex: 0 }),
    subagents: [],
    tokens: tokens(),
    costUsd: 0,
    ...partial,
  };
}

function snapshot(rooms: OfficeRoom[], habits?: OfficeSnapshot['habits']): OfficeSnapshot {
  return {
    generatedAt: '2026-09-28T20:00:00Z',
    leadRoomId: rooms[0]?.id ?? null,
    rooms,
    today: { costUsd: 0, tokens: tokens() },
    habits,
  };
}

function ref(partial: Partial<WorkflowAgentRef> & Pick<WorkflowAgentRef, 'agentId'>): WorkflowAgentRef {
  return {
    label: 'etiqueta',
    phase: 'Fase A',
    displayName: 'Agente',
    agentType: 'tr-builder',
    role: 'builder',
    status: 'working',
    model: 'claude-opus-5-5',
    tokens: tokens(100),
    costUsd: 0.1,
    startedAt: '2026-09-28T19:50:00Z',
    endedAt: null,
    ...partial,
  };
}

function run(partial: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: 'wf_prueba',
    name: 'flujo-de-prueba',
    description: '',
    status: 'running',
    startedAt: '2026-09-28T19:50:00Z',
    endedAt: null,
    phases: [],
    agents: [],
    tokens: tokens(),
    costUsd: 0,
    ...partial,
  };
}

const critical = (title: string): LiveAlert => ({ level: 'critical', title, source: 'rule', ruleId: 'agent_cost' });
const warning = (title: string): LiveAlert => ({ level: 'warning', title, source: 'errors' });

// ---- identidad ----

describe('identidad del agente', () => {
  it('padre: el lider de la sesion (parentId = sessionId), otro subagente visible o uno que ya salio', () => {
    const lanzador = agent('ag-lanzador', { displayName: 'Bruno', parentId: 'sala-1', childCount: 3 });
    const hijo = agent('ag-hijo', { displayName: 'Elena', parentId: 'ag-lanzador' });
    const huerfano = agent('ag-huerfano', { displayName: 'Gael', parentId: 'ag-que-salio' });
    const sala = room('sala-1', { subagents: [lanzador, hijo, huerfano], gitBranch: 'feature/habitos' });
    const snap = snapshot([sala]);

    expect(agentIdentity(lanzador, sala, snap).parent).toEqual({ kind: 'lead', id: 'sala-1' });
    expect(agentIdentity(hijo, sala, snap).parent).toEqual({ kind: 'agent', id: 'ag-lanzador', name: 'Bruno' });
    expect(agentIdentity(huerfano, sala, snap).parent).toEqual({ kind: 'gone', id: 'ag-que-salio' });
    expect(agentIdentity(sala.lead, sala, snap).parent).toEqual({ kind: 'none' });
  });

  it('subagentes: childCount de toda la vida y los nombres de los que siguen en la oficina', () => {
    const lanzador = agent('ag-lanzador', { displayName: 'Bruno', parentId: 'sala-1', childCount: 3 });
    const hijo = agent('ag-hijo', { displayName: 'Elena', parentId: 'ag-lanzador' });
    const otro = agent('ag-otro', { displayName: 'Marco', parentId: 'sala-1' });
    const sala = room('sala-1', { subagents: [lanzador, hijo, otro] });
    const snap = snapshot([sala]);

    const deBruno = agentIdentity(lanzador, sala, snap);
    expect(deBruno.childCount).toBe(3);
    expect(deBruno.children).toEqual([{ id: 'ag-hijo', name: 'Elena' }]);

    // el lead: los que lanzo directamente (parentId = sessionId); sin childCount cuenta los visibles
    const delLider = agentIdentity(sala.lead, sala, snap);
    expect(delLider.children.map((c) => c.name)).toEqual(['Bruno', 'Marco']);
    expect(delLider.childCount).toBe(2);
    expect(agentIdentity(hijo, sala, snap).childCount).toBe(0);
  });

  it('subagentes del lead: los de flujo van aparte y no tapan los de Agent/Task que ya salieron', () => {
    const flujo = (id: string, name: string) =>
      agent(id, {
        displayName: name,
        parentId: 'sala-1',
        workflow: { runId: 'wf_1', name: 'flujo', phase: 'Fase A', label: 'etiqueta', sourceType: 'tr-builder', role: 'builder' },
      });
    const lead = agent('sala-1', { kind: 'lead', agentType: 'lead', displayName: 'Ana', deskIndex: 0, childCount: 3 });
    // los 3 de Agent/Task ya salieron; corren 5 de un flujo, que cuelgan del lead (parentId = sessionId)
    const soloFlujo = room('sala-1', {
      lead,
      subagents: [flujo('f1', 'Gael'), flujo('f2', 'Dora'), flujo('f3', 'Paula'), flujo('f4', 'Guido'), flujo('f5', 'Marco')],
    });
    const id = agentIdentity(soloFlujo.lead, soloFlujo, snapshot([soloFlujo]));
    expect(id.children).toEqual([]);
    expect(id.flowChildren.map((c) => c.name)).toEqual(['Gael', 'Dora', 'Paula', 'Guido', 'Marco']);
    expect(id.childCount).toBe(3);
    expect(childrenTotals(id)).toEqual({ total: 8, left: 3 });

    // uno de Agent/Task sigue en la oficina y uno de flujo tambien
    const mezcla = room('sala-1', { lead, subagents: [agent('ag-1', { displayName: 'Bruno', parentId: 'sala-1' }), flujo('f1', 'Gael')] });
    const idMezcla = agentIdentity(mezcla.lead, mezcla, snapshot([mezcla]));
    expect(idMezcla.children.map((c) => c.name)).toEqual(['Bruno']);
    expect(idMezcla.flowChildren.map((c) => c.name)).toEqual(['Gael']);
    expect(childrenTotals(idMezcla)).toEqual({ total: 4, left: 2 });

    // sin childCount del server: los de Agent/Task visibles, sin "ya salieron"
    const sinDato = room('sala-1', { subagents: [flujo('f1', 'Gael')] });
    expect(childrenTotals(agentIdentity(sinDato.lead, sinDato, null))).toEqual({ total: 1, left: 0 });
  });

  it('proyecto y rama: sin git (HEAD o null) queda solo el proyecto', () => {
    const conRama = room('s', { gitBranch: 'main' });
    const sinGit = room('s', { gitBranch: 'HEAD' });
    const idConRama = agentIdentity(conRama.lead, conRama, null);
    expect(idConRama.branch).toBe('main');
    expect(projectBranchText(idConRama)).toBe('proyecto-prueba · main');
    expect(agentIdentity(sinGit.lead, sinGit, null).branch).toBeNull();
    expect(projectBranchText(agentIdentity(room('s').lead, room('s'), null))).toBe('proyecto-prueba');
  });

  it('rol y lugar: el lead es el Orquestador aunque no venga el campo; etiquetas de los roles', () => {
    const sala = room('s');
    expect(agentRole(sala.lead)).toBe('orchestrator');
    expect(agentRole(agent('a', { role: 'tester' }))).toBe('tester');
    expect(agentRole(agent('b'))).toBeNull();
    expect(ROLE_LABEL.orchestrator).toBe('Orquestador');
    expect(ROLE_LABEL.tester).toBe('Pruebas');
    expect(ROLE_LABEL.security).toBe('Seguridad');
    expect(WORKFLOW_ROLES).toContain('tester');
    expect(WORKFLOW_ROLES).toContain('security');
    expect(WORKFLOW_ROLES).not.toContain('orchestrator');
    expect(PLACE_LABEL.door).toBe('Puerta: espera tu respuesta');
    const withPlace = agentIdentity(agent('c', { place: 'lab', startedAt: '2026-09-28T19:00:00Z' }), sala, null);
    expect(withPlace.place).toBe('lab');
    expect(withPlace.startedAt).toBe('2026-09-28T19:00:00Z');
    expect(withPlace.lastActivityAt).toBeNull();
  });
});

// ---- alertas ----

describe('alertas en el panel del agente y en la lista', () => {
  it('panel: la del agente; el lead tambien muestra la de su sala; un subagente no hereda la de la sala', () => {
    const sub = agent('ag-1');
    const sala = room('s', { alert: warning('27 turnos sin compactar'), subagents: [sub] });
    expect(drawerAlert(sala.lead, sala)?.title).toBe('27 turnos sin compactar');
    expect(drawerAlert(sub, sala)).toBeNull();
    const propio = agent('ag-2', { alert: critical('Costo $3,40 > $2,00') });
    expect(drawerAlert(propio, sala)?.level).toBe('critical');
  });

  it('panel del lead con alerta propia: la mas severa entre la suya y la de la sala, como la lista', () => {
    const conLead = (leadAlert: LiveAlert, salaAlert: LiveAlert): OfficeRoom => {
      const base = room('s', { alert: salaAlert });
      return { ...base, lead: { ...base.lead, alert: leadAlert } };
    };
    // el lead avisa (warning) y la sala tiene una critica: el panel no la esconde
    const salaCritica = conLead(warning('Falló 2 veces seguidas'), critical('Hoy $6,00 > $5,00'));
    expect(drawerAlert(salaCritica.lead, salaCritica)?.title).toBe('Hoy $6,00 > $5,00');
    expect(drawerAlert(salaCritica.lead, salaCritica)).toBe(roomAlert(salaCritica)?.alert);
    // la del lead es la critica
    const leadCritico = conLead(critical('Repitió 4 veces lo mismo'), warning('27 turnos sin compactar'));
    expect(drawerAlert(leadCritico.lead, leadCritico)?.title).toBe('Repitió 4 veces lo mismo');
    // empate: la de la sala, igual que roomAlert
    const empate = conLead(warning('Falló 2 veces seguidas'), warning('27 turnos sin compactar'));
    expect(drawerAlert(empate.lead, empate)?.title).toBe('27 turnos sin compactar');
    expect(drawerAlert(empate.lead, empate)).toBe(roomAlert(empate)?.alert);
    // sin alerta de sala queda la del lead
    const soloLead = { ...room('s'), lead: { ...room('s').lead, alert: warning('Falló 2 veces seguidas') } };
    expect(drawerAlert(soloLead.lead, soloLead)?.title).toBe('Falló 2 veces seguidas');
  });

  it('lista: la mas severa entre la sala y sus agentes presentes, con el nombre del agente', () => {
    const sala = room('s', {
      alert: warning('27 turnos sin compactar'),
      subagents: [agent('ag-1', { displayName: 'Bruno', alert: critical('Costo $3,40 > $2,00') })],
    });
    expect(roomAlert(sala)).toEqual({ alert: critical('Costo $3,40 > $2,00'), agentName: 'Bruno' });

    const empate = room('s', {
      alert: warning('27 turnos sin compactar'),
      subagents: [agent('ag-1', { alert: warning('Fallo 2 veces seguidas') })],
    });
    expect(roomAlert(empate)?.agentName).toBeNull();

    const saliendo = room('s', { subagents: [agent('ag-1', { status: 'done', alert: critical('Costo $9,00 > $2,00') })] });
    expect(roomAlert(saliendo)).toBeNull();
    expect(roomAlert(room('s'))).toBeNull();
  });

  it('insignia de habitos: alertas rojas primero, luego hallazgos, sin datos queda quieta', () => {
    expect(habitsBadge(undefined)).toMatchObject({ tone: 'quiet', count: 0 });
    const conAlertas = habitsBadge({ active: 5, alerts: 2, savingsUsd: 1.2, notifyBrowser: false });
    expect(conAlertas).toMatchObject({ tone: 'alert', count: 2 });
    expect(conAlertas.label).toContain('2 alertas rojas');
    expect(conAlertas.label).toContain('5 hallazgos vivos');
    expect(conAlertas.label).toContain('$1,20');
    expect(habitsBadge({ active: 1, alerts: 0, savingsUsd: 0, notifyBrowser: false })).toMatchObject({
      tone: 'findings',
      count: 1,
    });
    expect(habitsBadge({ active: 0, alerts: 0, savingsUsd: 0, notifyBrowser: true }).tone).toBe('quiet');
  });
});

// ---- tira del flujo ----

describe('tira del flujo', () => {
  const phases: WorkflowRun['phases'] = [
    { title: 'Exploracion', status: 'done', agentsStarted: 2, agentsDone: 2 },
    { title: 'Construccion', status: 'running', agentsStarted: 2, agentsDone: 1 },
    { title: 'Revision', status: 'pending', agentsStarted: 0, agentsDone: 0 },
  ];
  const agents = [
    ref({ agentId: 'a1', phase: 'Exploracion', label: 'e1', status: 'done', endedAt: '2026-09-28T19:55:00Z' }),
    ref({ agentId: 'a2', phase: 'Exploracion', label: 'e2', status: 'done', endedAt: '2026-09-28T19:55:00Z' }),
    ref({ agentId: 'a3', phase: 'Construccion', label: 'c1', status: 'done', endedAt: '2026-09-28T19:58:00Z' }),
    ref({ agentId: 'a4', phase: 'Construccion', label: 'c2' }),
  ];

  it('Solicitud -> Orquestador -> una etapa por fase -> Aprobacion humana -> Completado', () => {
    const nodes = flowPipeline(run({ phases, agents }), room('s'));
    expect(nodes.map((n) => n.label)).toEqual([
      'Solicitud',
      'Orquestador',
      'Exploracion',
      'Construccion',
      'Revision',
      'Aprobación humana',
      'Completado',
    ]);
    expect(nodes.map((n) => n.status)).toEqual(['done', 'done', 'done', 'active', 'pending', 'pending', 'pending']);
    expect(nodes.find((n) => n.label === 'Construccion')?.detail).toBe('1/2');
    expect(nodes.find((n) => n.label === 'Revision')?.detail).toBeNull();
  });

  it('Aprobacion humana se enciende cuando el lead de la sala esta en la puerta', () => {
    const esperando = room('s');
    esperando.lead = { ...esperando.lead, place: 'door' };
    const nodes = flowPipeline(run({ phases, agents }), esperando);
    expect(nodes.find((n) => n.kind === 'approval')?.status).toBe('waiting');
    expect(pipelineText(nodes)).toContain('Aprobación humana, espera tu respuesta');
    expect(pipelineText(nodes)).toContain('Construccion, en curso, 1/2');

    // una corrida vieja no se enciende por una pregunta nueva del lead
    const vieja = run({ runId: 'wf_vieja', status: 'done', endedAt: '2026-09-28T19:40:00Z', startedAt: '2026-09-28T19:00:00Z' });
    const nueva = run({ runId: 'wf_nueva', status: 'done', endedAt: '2026-09-28T19:59:00Z' });
    const conDos = { ...esperando, workflows: [nueva, vieja] };
    expect(flowPipeline(vieja, conDos).find((n) => n.kind === 'approval')?.status).toBe('done');
    expect(flowPipeline(nueva, conDos).find((n) => n.kind === 'approval')?.status).toBe('waiting');
  });

  it('corrida terminada, fallida o sin agentes', () => {
    const done = flowPipeline(
      run({ status: 'done', endedAt: '2026-09-28T20:00:00Z', phases: phases.map((p) => ({ ...p, status: 'done' })), agents }),
      room('s'),
    );
    expect(done.at(-1)).toMatchObject({ label: 'Completado', status: 'done' });
    expect(done.find((n) => n.kind === 'approval')?.status).toBe('done');

    const failed = flowPipeline(run({ status: 'failed', endedAt: '2026-09-28T20:00:00Z', phases, agents }), room('s'));
    expect(failed.at(-1)).toMatchObject({ label: 'Falló', status: 'failed' });
    expect(failed.find((n) => n.kind === 'approval')?.status).toBe('pending');

    const empty = flowPipeline(run(), room('s'));
    expect(empty.map((n) => n.status)).toEqual(['done', 'active', 'pending', 'pending', 'pending']);
    expect(empty[2]).toMatchObject({ kind: 'phase', label: 'Agentes' });
  });
});

// ---- pronostico ----

describe('pronostico en vuelo', () => {
  it('"~$bajo–$alto" con el riesgo contra el presupuesto por workflow', () => {
    const forecast = { lowUsd: 1.2, highUsd: 2.4, budgetUsd: 2, risk: riskOf(2.4, 2), unknownAgents: 1 };
    expect(forecast.risk).toBe('high');
    expect(forecastText(forecast)).toBe('~$1,20–$2,40');
    expect(forecastText({ lowUsd: 0.5, highUsd: 0.5 })).toBe('~$0,50');
    const detail = forecastDetail(forecast);
    expect(detail).toContain('Riesgo alto');
    expect(detail).toContain('$2,00');
    expect(detail).toContain('1 agente sin historial');
    expect(forecastDetail({ ...forecast, budgetUsd: null, risk: null, unknownAgents: 0 })).toContain('regla está apagada');
    expect(riskOf(0.1, 2)).toBe('low');
    expect(riskOf(0.3, 2)).toBe('medium');
  });

  it('solo corridas en curso; sin historial no hay cifra', () => {
    const forecast = { lowUsd: 1, highUsd: 2, budgetUsd: 10, risk: riskOf(2, 10), unknownAgents: 0 };
    expect(runForecast(run({ forecast }))).toEqual(forecast);
    expect(runForecast(run({ forecast: null }))).toBeNull();
    expect(runForecast(run())).toBeNull();
    expect(runForecast(run({ status: 'done', forecast }))).toBeNull();
  });
});

// ---- notificaciones del navegador ----

function fakeEnv(partial: Partial<{ permission: NotificationPermission | 'unsupported'; hidden: boolean }> = {}) {
  const shown: AlertNotice[] = [];
  const state = { permission: 'granted' as NotificationPermission | 'unsupported', hidden: true, ...partial };
  const env: NotifyEnv = {
    permission: () => state.permission,
    hidden: () => state.hidden,
    show: (notice) => shown.push(notice),
  };
  return { env, shown, state };
}

const ON = { active: 1, alerts: 1, savingsUsd: 0, notifyBrowser: true };

function officeWith(alerts: { sub?: LiveAlert; room?: LiveAlert } = {}, habits = ON): OfficeSnapshot {
  const sub = agent('ag-1', { displayName: 'Bruno', alert: alerts.sub ?? null });
  return snapshot([room('sala-1', { title: 'office-site', alert: alerts.room ?? null, subagents: [sub] })], habits);
}

describe('notificaciones de alertas', () => {
  it('las del primer snapshot ya estaban: no avisan (recargar no repite)', () => {
    const { env, shown } = fakeEnv();
    const notify = createAlertNotifier(env);
    notify(officeWith({ sub: critical('Costo $3,40 > $2,00') }));
    expect(shown).toHaveLength(0);
  });

  it('una alerta nueva avisa una sola vez, aunque cambien las cifras de su titulo', () => {
    const { env, shown } = fakeEnv();
    const notify = createAlertNotifier(env);
    notify(officeWith());
    notify(officeWith({ sub: critical('Costo $3,40 > $2,00') }));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: 'Bruno · Sala office-site', body: 'Costo $3,40 > $2,00', level: 'critical' });
    expect(shown[0]?.target).toEqual({ kind: 'agent', id: 'ag-1' });
    notify(officeWith({ sub: critical('Costo $3,90 > $2,00') }));
    notify(officeWith({ sub: critical('Costo $4,10 > $2,00') }));
    expect(shown).toHaveLength(1);
    // la sala con su propia alerta es otra alerta
    notify(officeWith({ sub: critical('Costo $4,10 > $2,00'), room: warning('31 turnos sin compactar') }));
    expect(shown).toHaveLength(2);
    expect(shown[1]?.target).toEqual({ kind: 'room', id: 'sala-1' });
  });

  it('con la pestana a la vista no avisa y la alerta queda vista', () => {
    const { env, shown, state } = fakeEnv({ hidden: false });
    const notify = createAlertNotifier(env);
    notify(officeWith());
    notify(officeWith({ sub: warning('Fallo 2 veces seguidas') }));
    state.hidden = true;
    notify(officeWith({ sub: warning('Fallo 3 veces seguidas') }));
    expect(shown).toHaveLength(0);
  });

  it('sin la opcion de Reglas o sin permiso concedido no avisa', () => {
    for (const setup of [
      { habits: { ...ON, notifyBrowser: false }, permission: 'granted' as const },
      { habits: ON, permission: 'default' as const },
      { habits: ON, permission: 'denied' as const },
      { habits: ON, permission: 'unsupported' as const },
    ]) {
      const { env, shown } = fakeEnv({ permission: setup.permission });
      const notify = createAlertNotifier(env);
      notify(officeWith({}, setup.habits));
      notify(officeWith({ sub: critical('Costo $3,40 > $2,00') }, setup.habits));
      expect(shown).toHaveLength(0);
    }
  });

  it('muchas alertas nuevas juntas salen en un solo aviso, la critica primero', () => {
    const { env, shown } = fakeEnv();
    const notify = createAlertNotifier(env);
    const subs = ['Bruno', 'Elena', 'Marco', 'Dora'].map((name, i) =>
      agent(`ag-${i}`, { displayName: name, alert: i === 3 ? critical('Costo $3,40 > $2,00') : warning('Fallo 2 veces seguidas') }),
    );
    notify(snapshot([room('sala-1', { subagents: subs.map((s) => ({ ...s, alert: null })) })], ON));
    notify(snapshot([room('sala-1', { subagents: subs })], ON));
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe(`${subs.length} alertas nuevas en la oficina`);
    expect(shown[0]?.body.split('\n')[0]).toBe('Dora: Costo $3,40 > $2,00');
    expect(shown[0]?.body.split('\n')).toHaveLength(MAX_NOTICES_AT_ONCE + 1);
  });

  it('una alerta que se apago el tiempo de olvido y vuelve es un episodio nuevo y avisa otra vez', () => {
    const at = (min: number, snap: OfficeSnapshot): OfficeSnapshot => ({
      ...snap,
      generatedAt: new Date(Date.UTC(2026, 8, 28, 20, min)).toISOString(),
    });
    const forgetMin = ALERT_FORGET_AFTER_MS / 60_000;
    const hoy = room('sala-1', { title: 'office-site', alert: critical('Hoy $6,00 > $5,00') });
    const conAlerta = snapshot([hoy], ON);
    const sinAlerta = snapshot([{ ...hoy, alert: null }], ON);
    const { env, shown } = fakeEnv();
    const notify = createAlertNotifier(env);
    notify(at(0, sinAlerta));
    notify(at(1, conAlerta));
    expect(shown).toHaveLength(1);
    // parpadea: vuelve un minuto antes de cumplir el tiempo de olvido sin verse, no repite
    notify(at(2, sinAlerta));
    const back = 1 + forgetMin - 1;
    notify(at(back, conAlerta));
    expect(shown).toHaveLength(1);
    // se apaga, pasa el tiempo de olvido con snapshots de por medio y vuelve: avisa
    notify(at(back + 1, sinAlerta));
    notify(at(back + forgetMin, sinAlerta));
    const second = back + forgetMin + 1;
    notify(at(second, conAlerta));
    expect(shown).toHaveLength(2);
    // se apaga y vuelve al cumplir el tiempo de olvido, sin ningun snapshot entre medio: tambien avisa
    notify(at(second + 1, sinAlerta));
    const third = second + forgetMin;
    notify(at(third, conAlerta));
    expect(shown).toHaveLength(3);
    // sigue presente aunque el siguiente snapshot llegue tarde: es la misma alerta
    notify(at(third + 3 * forgetMin, conAlerta));
    expect(shown).toHaveLength(3);
  });

  it('solo cuentan las alertas de agentes presentes; la llave ignora las cifras', () => {
    const saliendo = agent('ag-9', { status: 'done', alert: critical('Costo $9,00 > $2,00') });
    expect(liveAlerts(snapshot([room('s', { subagents: [saliendo] })]))).toHaveLength(0);
    expect(alertKey('agent', 'ag-1', critical('Costo $3,40 > $2,00'))).toBe(
      alertKey('agent', 'ag-1', critical('Costo $12,05 > $2,00')),
    );
    expect(alertKey('agent', 'ag-1', warning('Fallo 2 veces seguidas'))).not.toBe(
      alertKey('room', 'ag-1', warning('Fallo 2 veces seguidas')),
    );
  });
});

// ---- atajos ----

describe('atajo A: historial en Habitos', () => {
  it('A abre Habitos; con Habitos a la vista lo cierra; desde otra pestana cambia a Habitos', () => {
    expect(letterAction('a', { historyOpen: false, historyTab: 'budget' })).toBe('open-habits');
    expect(letterAction('A', { historyOpen: false, historyTab: 'budget' })).toBe('open-habits');
    expect(letterAction('a', { historyOpen: true, historyTab: 'habits' })).toBe('close-history');
    expect(letterAction('a', { historyOpen: true, historyTab: 'ranking' })).toBe('open-habits');
  });

  it('H y F siguen igual; otras letras no hacen nada', () => {
    expect(letterAction('h', { historyOpen: false, historyTab: 'habits' })).toBe('open-history');
    expect(letterAction('H', { historyOpen: true, historyTab: 'budget' })).toBe('close-history');
    expect(letterAction('f', { historyOpen: false, historyTab: 'budget' })).toBe('toggle-flows');
    expect(letterAction('F', { historyOpen: true, historyTab: 'budget' })).toBeNull();
    expect(letterAction('x', { historyOpen: false, historyTab: 'budget' })).toBeNull();
    expect(letterAction('Alt', { historyOpen: false, historyTab: 'budget' })).toBeNull();
  });
});
