// Rol de los subagentes (tool Agent y tool Workflow). Los tipos del elenco y los tipos cuyo nombre lo dice
// fijan el rol; general-purpose, workflow-subagent y los demas lo infieren de su etiqueta, el titulo de su
// fase y SOLO el inicio de su encargo. Modulo puro: sin archivos ni DB.
import type { WorkflowRole } from '@shared/contract';

/** agentType tecnico de los agentes del tool Workflow cuando el script no pidio otro */
export const WORKFLOW_AGENT_TYPE = 'workflow-subagent';

/** rol mientras no llega el inicio del encargo */
export const PROVISIONAL_ROLE: WorkflowRole = 'generalist';

/** tipo del elenco (nombre y personaje del frontend) de cada rol; explorer en Haiku usa HAIKU_EXPLORER_TYPE */
export const ROLE_LOOK: Readonly<Record<WorkflowRole, string>> = {
  explorer: 'Explore',
  builder: 'tr-builder',
  reviewer: 'claude-code-guide',
  tester: 'tester',
  security: 'security',
  planner: 'Plan',
  docs: 'tr-docs',
  generalist: 'general-purpose',
};
export const HAIKU_EXPLORER_TYPE = 'tr-explorer';

/** tipos con rol propio: conservan su look (su nombre y personaje) */
const OWN_ROLE: ReadonlyMap<string, WorkflowRole> = new Map([
  ['Explore', 'explorer'],
  [HAIKU_EXPLORER_TYPE, 'explorer'],
  ['tr-builder', 'builder'],
  ['Plan', 'planner'],
  ['tr-docs', 'docs'],
  ['claude-code-guide', 'explorer'],
]);

/** en empate gana el primero ("corregir el diseno" es construir, no planear; "revision de seguridad" es seguridad) */
const PRIORITY: readonly WorkflowRole[] = ['security', 'reviewer', 'tester', 'docs', 'builder', 'planner', 'explorer'];

const WEIGHT = { label: 3, phase: 2, prompt: 1 } as const;

/** tope del inicio del encargo que se clasifica */
export const PROMPT_HEAD_MAX = 400;

// Vocabulario ya normalizado (minusculas, sin tildes). `x*` = palabra que empieza por x; con espacios
// = frase de palabras seguidas. Formas exactas donde un prefijo atraparia otra cosa (porta ≠
// portabilidad, critica ≠ critico, valida ≠ valid).
const KEYWORDS: Readonly<Record<Exclude<WorkflowRole, 'generalist'>, readonly string[]>> = {
  explorer: [
    'explor*', 'investig*', 'busc*', 'busqued*', 'lee', 'leer', 'leyendo', 'read', 'reads', 'reading',
    'inventari*', 'inventory', 'inventories', 'mape*', 'sonde*', 'research*', 'search*', 'find', 'finds',
    'scan', 'scans', 'scanning', 'escane*', 'discover*', 'descubr*', 'survey*',
  ],
  builder: [
    'constru*', 'build', 'builds', 'building', 'builder', 'implement*',
    'escrib* codigo', 'escrib* el codigo', 'writ* code', 'writ* the code',
    'porta', 'portar', 'portea', 'portear', 'port', 'ports', 'porting', 'ported',
    'corrige', 'corrigen', 'corregir', 'corrigiendo', 'corrija', 'correccion', 'correcciones', 'corrector*',
    'integra', 'integrar', 'integrando', 'integracion', 'integraciones',
    'integrate', 'integrates', 'integrating', 'integration',
    'refactor*', 'migra*', 'arregl*', 'fix', 'fixes', 'fixing', 'fixed',
    'apply', 'applies', 'applying', 'aplica', 'aplicar', 'aplicando',
  ],
  reviewer: [
    'revis*', 'review*', 'verif*', 'audit*',
    'critica', 'criticas', 'critican', 'criticar', 'critique*', 'critic', 'critics', 'criticism', 'criticize',
    'refut*', 'juzg*', 'judg*', 'evalu*',
    'valida', 'validar', 'validando', 'validacion', 'validaciones', 'validate', 'validates', 'validating', 'validation',
    'adversari*', 'skeptic*', 'esceptic*',
  ],
  tester: ['prueba*', 'probar', 'probando', 'test*', 'qa', 'vitest', 'jest', 'e2e', 'smoke'],
  // secret* cubre secreto, secretos y secrets
  security: [
    'seguridad', 'security', 'vulnerab*', 'secret*', 'pentest', 'pentesting', 'auditoria de seguridad', 'cve', 'cves',
  ],
  planner: [
    'plan', 'plans', 'planning', 'planea', 'planear', 'planeando', 'planifica*', 'disen*', 'design*',
    'arquitect*', 'architect*', 'especificacion', 'especificaciones', 'spec', 'specs', 'specification*',
    'propon*', 'propuesta*', 'propose*', 'proposal*', 'estrategi*', 'strateg*', 'roadmap*',
  ],
  docs: [
    'documenta', 'documentar', 'documentando', 'documentacion', 'document', 'documenting', 'documentation',
    'redact*', 'redacc*', 'readme*', 'changelog*', 'manual', 'docs', 'doc', 'write up', 'writeup',
    'borrador de texto',
  ],
};

/** ordenes al agente de no editar: vetan builder en la etiqueta, la fase o el inicio del encargo */
const NO_EDIT: readonly string[] = [
  'no edites', 'no edite', 'no editar', 'nunca edites', 'sin editar', 'sin modificar',
  'prohibido editar', 'prohibido modificar', 'no modifiques', 'do not edit', 'don t edit', 'dont edit',
  'do not modify', 'never edit',
];

/**
 * "solo lectura" veta builder solo en la etiqueta o la fase: en el encargo suele describir otra cosa
 * ("cero tokens, solo lectura de ~/.claude" es el producto, no el permiso del agente)
 */
const READ_ONLY: readonly string[] = ['solo lectura', 'read only', 'readonly', ...NO_EDIT];

type Pattern = ReadonlyArray<{ stem: string; prefix: boolean }>;

function compile(keyword: string): Pattern {
  return keyword.split(' ').map((w) => (w.endsWith('*') ? { stem: w.slice(0, -1), prefix: true } : { stem: w, prefix: false }));
}

const COMPILED = Object.fromEntries(
  Object.entries(KEYWORDS).map(([role, list]) => [role, list.map((k) => ({ keyword: k, pattern: compile(k) }))]),
) as Record<keyof typeof KEYWORDS, Array<{ keyword: string; pattern: Pattern }>>;
const READ_ONLY_COMPILED = READ_ONLY.map(compile);
const NO_EDIT_COMPILED = NO_EDIT.map(compile);

/** minusculas, sin tildes, todo lo que no es letra o digito (- _ : / . incluidos) como espacio */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function words(s: string | null): string[] {
  if (!s) return [];
  const n = normalizeText(s);
  return n ? n.split(' ') : [];
}

function matches(ws: readonly string[], pattern: Pattern): boolean {
  outer: for (let i = 0; i + pattern.length <= ws.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      const w = ws[i + j] ?? '';
      const p = pattern[j];
      if (!p || !(p.prefix ? w.startsWith(p.stem) : w === p.stem)) continue outer;
    }
    return true;
  }
  return false;
}

const FRAME_START = /^\[Workflow harness — [^\]\n]+\]/;
const COMPUTED_FRAME = /^\[Workflow harness — computed task\]/m;

/**
 * Texto del encargo de un mensaje user del agente. El harness del tool Workflow puede enviar antes
 * relevos que NO son el encargo ("[Workflow harness — user request]" con el pedido del usuario y
 * "— assistant context]"): devuelven null. El encargo llega plano o dentro de
 * "[Workflow harness — computed task]" con cada linea indentada: se devuelve sin la indentacion.
 */
export function taskText(message: string): string | null {
  const text = message.replace(/^﻿/, '').trimStart();
  if (!FRAME_START.test(text)) return text;
  // un marco en la columna cero es del harness: lo relevado siempre va indentado
  const computed = COMPUTED_FRAME.exec(text);
  if (!computed) return null;
  const lines = text.slice(computed.index).split(/\r?\n/).slice(1);
  const body: string[] = [];
  let started = false;
  for (const l of lines) {
    const blank = l.trim().length === 0;
    const indented = l.startsWith('  ');
    if (!started) {
      if (indented && !blank) started = true;
      else continue;
    } else if (!blank && !indented) break;
    body.push(l.startsWith('  ') ? l.slice(2) : l);
  }
  return body.join('\n');
}

/** inicio del encargo: su primer parrafo, como maximo PROMPT_HEAD_MAX caracteres (el resto suele ser reglas) */
export function promptHead(task: string): string {
  const first = task.trim().split(/\n\s*\n/)[0] ?? '';
  return first.trim().slice(0, PROMPT_HEAD_MAX);
}

export function isHaikuModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && /haiku/i.test(model);
}

export function lookTypeFor(role: WorkflowRole, model: string | null | undefined): string {
  return role === 'explorer' && isHaikuModel(model) ? HAIKU_EXPLORER_TYPE : ROLE_LOOK[role];
}

/**
 * rol que fija el tipo por si solo: los tipos con rol propio y los que lo dicen en su nombre
 * ('code-reviewer', 'test-runner', 'security-auditor'); null = general-purpose, workflow-subagent y
 * demas tipos, que se clasifican por palabras
 */
export function roleOfAgentType(agentType: string): WorkflowRole | null {
  const own = OWN_ROLE.get(agentType);
  if (own) return own;
  const t = agentType.toLowerCase();
  if (t.includes('secur')) return 'security';
  if (t.includes('review')) return 'reviewer';
  if (t.includes('test')) return 'tester';
  return null;
}

export interface RoleResult {
  role: WorkflowRole;
  /** tipo del elenco que usa el frontend para nombre y personaje */
  lookType: string;
}

/** rol y look que fija el tipo; los tipos sin look propio toman el de su rol. null = se decide por palabras */
export function fixedRole(agentType: string): RoleResult | null {
  const role = roleOfAgentType(agentType);
  if (!role) return null;
  return { role, lookType: OWN_ROLE.has(agentType) ? agentType : ROLE_LOOK[role] };
}

export function isWorkflowRole(v: unknown): v is WorkflowRole {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ROLE_LOOK, v);
}

/** Bash/PowerShell minimos, y parte que deben ser tests, para que un generalist pase a tester */
export const TESTER_MIN_SHELLS = 4;
export const TESTER_MIN_TEST_SHARE = 0.5;

/** unica excepcion a "el rol se decide una vez": un generalist que corre sobre todo tests es tester */
export function isTesterByCommands(shells: number, tests: number): boolean {
  return shells >= TESTER_MIN_SHELLS && tests >= shells * TESTER_MIN_TEST_SHARE;
}

export interface RoleInput {
  /** etiqueta: la del agente en el script (flujo) o la descripcion con que se lanzo (tool Agent) */
  label: string | null;
  /** titulo de su fase (workflowPhase); null fuera de un flujo */
  phase: string | null;
  /** inicio del encargo; si llega el encargo entero, solo se usa su inicio (promptHead) */
  promptHead: string | null;
  /** alias del meta (haiku/sonnet/opus) o id completo del modelo */
  model: string | null;
  /** agentType del meta: un tipo con rol propio o que lo dice en su nombre se respeta (fixedRole) */
  sourceType?: string | null;
}

export interface RoleExplanation extends RoleResult {
  scores: Record<WorkflowRole, number>;
  readOnly: boolean;
  /** 'rol:palabra' del vocabulario que coincidio en cada fuente */
  matched: { label: string[]; phase: string[]; prompt: string[] };
}

/** clasificacion con el detalle de puntajes (para pruebas y diagnostico) */
export function explainWorkflowRole(input: RoleInput): RoleExplanation {
  const scores: Record<WorkflowRole, number> = {
    explorer: 0, builder: 0, reviewer: 0, tester: 0, security: 0, planner: 0, docs: 0, generalist: 0,
  };
  const matched = { label: [] as string[], phase: [] as string[], prompt: [] as string[] };
  const fixed = fixedRole(input.sourceType ?? WORKFLOW_AGENT_TYPE);
  if (fixed) return { ...fixed, scores, readOnly: false, matched };
  const sources = {
    label: words(input.label),
    phase: words(input.phase),
    prompt: words(input.promptHead === null ? null : promptHead(input.promptHead)),
  };
  const readOnly =
    READ_ONLY_COMPILED.some((p) => matches(sources.label, p) || matches(sources.phase, p)) ||
    NO_EDIT_COMPILED.some((p) => matches(sources.prompt, p));
  for (const role of PRIORITY) {
    if (role === 'builder' && readOnly) continue;
    for (const { keyword, pattern } of COMPILED[role as keyof typeof COMPILED]) {
      for (const key of ['label', 'phase', 'prompt'] as const) {
        if (!matches(sources[key], pattern)) continue;
        scores[role] += WEIGHT[key];
        matched[key].push(`${role}:${keyword}`);
      }
    }
  }
  let role: WorkflowRole = 'generalist';
  let best = 0;
  for (const r of PRIORITY) {
    if (scores[r] > best) {
      best = scores[r];
      role = r;
    }
  }
  return { role, lookType: lookTypeFor(role, input.model), scores, readOnly, matched };
}

/** rol y tipo del elenco de un subagente (de flujo o del tool Agent) */
export function classifyWorkflowRole(input: RoleInput): RoleResult {
  const { role, lookType } = explainWorkflowRole(input);
  return { role, lookType };
}
