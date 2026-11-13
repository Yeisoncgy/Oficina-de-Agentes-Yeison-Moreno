// Titulo real de la tarea de un agente de flujo, sacado de sus acciones (sin gastar tokens):
// "Construyendo frontend · FlowsDock.tsx", "Revisando backend · parser.ts", "Explorando diseno · Kit 3D.html".
import type { WorkflowRole } from '@shared/contract';
import { normalizeText } from '../ingest/roles';

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob']);

export interface TargetCount {
  tool: string;
  target: string;
  n: number;
  last: number;
}

export interface WorkInput {
  role: WorkflowRole;
  label: string | null;
  phase: string | null;
  cwd: string | null;
  targets: readonly TargetCount[];
}

const FIX_WORDS = ['correc', 'corrig', 'fix', 'arregl', 'repar', 'bug'];

function verbFor(input: WorkInput, hasEdits: boolean, hasReads: boolean): string {
  const text = normalizeText(`${input.label ?? ''} ${input.phase ?? ''}`);
  switch (input.role) {
    case 'builder':
      return FIX_WORDS.some((w) => text.includes(w)) ? 'Arreglando' : 'Construyendo';
    case 'reviewer':
      return 'Revisando';
    case 'tester':
      return 'Probando';
    case 'security':
      return 'Auditando';
    case 'explorer':
      return 'Explorando';
    case 'planner':
      return 'Planeando';
    case 'docs':
      return 'Documentando';
    case 'generalist':
      return hasEdits ? 'Construyendo' : hasReads ? 'Explorando' : 'Trabajando en';
  }
}

/** partes de la ruta, relativa al cwd si cae dentro; `outside` = quedo absoluta (fuera del cwd) */
function splitPath(p: string, cwd: string | null): { segs: string[]; outside: boolean } {
  let s = p.replace(/\\/g, '/');
  if (cwd) {
    const c = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    if (s.toLowerCase().startsWith(`${c.toLowerCase()}/`)) s = s.slice(c.length + 1);
  }
  const outside = /^([a-z]:)?\//i.test(s);
  return { segs: s.split('/').filter((x) => x.length > 0 && !/^[a-z]:$/i.test(x)), outside };
}

function toSegments(p: string, cwd: string | null): string[] {
  return splitPath(p, cwd).segs;
}

/** zona del proyecto a la que pertenece una ruta */
export function areaOf(p: string, cwd: string | null): string {
  const { segs, outside } = splitPath(p, cwd);
  const lower = segs.map((s) => s.toLowerCase());
  const file = lower[lower.length - 1] ?? '';
  const has = (...names: string[]) => lower.some((s) => names.includes(s));
  if (has('test', 'tests', '__tests__') || /\.(test|spec)\./.test(file)) return 'pruebas';
  if (has('.claude')) return 'Claude Code';
  if (has('_analisis')) return 'análisis';
  if (has('design', 'diseno')) return 'diseño';
  if (has('scene', 'three', '3d')) return 'escena 3D';
  if (has('hud')) return 'interfaz';
  if (has('server', 'backend', 'api')) return 'backend';
  if (has('shared')) return 'contrato';
  if (has('web', 'frontend', 'client', 'ui', 'components', 'pages', 'app')) return 'frontend';
  if (file.endsWith('.md')) return 'documentación';
  // fuera del cwd el primer segmento es la raiz del disco ('Users'), no una zona del proyecto
  if (outside) return '';
  return segs.length > 1 ? (segs[0] ?? '') : '';
}

function moduleOf(p: string, cwd: string | null): string {
  const segs = toSegments(p, cwd).filter((s) => !s.includes('*'));
  return segs[segs.length - 1] ?? p;
}

function pickFocus(list: readonly TargetCount[]): TargetCount | undefined {
  let best: TargetCount | undefined;
  for (const t of list) {
    if (!best || t.n > best.n || (t.n === best.n && t.last > best.last)) best = t;
  }
  return best;
}

/** que esta haciendo de verdad, segun las rutas que mas toca */
export function describeWork(input: WorkInput): string {
  const edits = input.targets.filter((t) => EDIT_TOOLS.has(t.tool));
  const reads = input.targets.filter((t) => READ_TOOLS.has(t.tool));
  const verb = verbFor(input, edits.length > 0, reads.length > 0);
  const prefersEdits = input.role === 'builder' || input.role === 'docs' || input.role === 'generalist';
  const focus = (prefersEdits && edits.length > 0 ? pickFocus(edits) : undefined) ?? pickFocus(reads) ?? pickFocus(edits);
  if (!focus) {
    const label = (input.label ?? '').trim();
    return label ? `${verb} · ${label}` : verb;
  }
  const area = areaOf(focus.target, input.cwd);
  const mod = moduleOf(focus.target, input.cwd);
  return area ? `${verb} ${area} · ${mod}` : `${verb} · ${mod}`;
}

/** etiqueta y fase del script, como detalle de la tarea */
export function scriptDetail(label: string | null, phase: string | null): string {
  const l = (label ?? '').trim();
  const p = (phase ?? '').trim();
  if (p && l) return `${p} · ${l}`;
  return p || l;
}
