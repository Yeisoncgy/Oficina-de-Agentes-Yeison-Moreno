import path from 'node:path';

/** runId presente = agente lanzado por el tool Workflow */
export type FileTarget =
  | { kind: 'lead'; path: string; sessionId: string; projectDir: string }
  | { kind: 'subagent'; path: string; sessionId: string; agentId: string; projectDir: string; runId?: string }
  | { kind: 'meta'; path: string; sessionId: string; agentId: string; projectDir: string; runId?: string }
  | { kind: 'journal'; path: string; sessionId: string; runId: string; projectDir: string }
  | { kind: 'wfstate'; path: string; sessionId: string; runId: string; projectDir: string };

export const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const SUBAGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;
const META_FILE = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/;
const JOURNAL_FILE = 'journal.jsonl';
/** carpetas de proyecto o de sesion que no son sesiones */
export const SKIP_DIRS = new Set(['memory', 'tool-results', 'workflows']);

/** clave estable de un archivo para file_offsets (Windows no distingue mayusculas) */
export function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function projectsDir(claudeHome: string): string {
  return path.join(claudeHome, 'projects');
}

export function sessionsDir(claudeHome: string): string {
  return path.join(claudeHome, 'sessions');
}

/** true si `child` queda dentro de `parent` */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function relParts(root: string, absPath: string): string[] {
  return path.relative(path.resolve(root), path.resolve(absPath)).split(/[\\/]+/);
}

/**
 * Interpreta una ruta dentro de CLAUDE_HOME/projects:
 *   <proyecto>/<sessionId>.jsonl                                           -> lead
 *   <proyecto>/<sessionId>/subagents/agent-<id>.jsonl                      -> subagent
 *   <proyecto>/<sessionId>/subagents/agent-<id>.meta.json                  -> meta
 *   <proyecto>/<sessionId>/subagents/workflows/<runId>/agent-<id>.jsonl     -> subagent (con runId)
 *   <proyecto>/<sessionId>/subagents/workflows/<runId>/agent-<id>.meta.json -> meta (con runId)
 *   <proyecto>/<sessionId>/subagents/workflows/<runId>/journal.jsonl       -> journal
 *   <proyecto>/<sessionId>/workflows/<runId>.json                          -> wfstate (estado final)
 * <proyecto>/<sessionId>/workflows/scripts/ no genera targets.
 */
export function classifyPath(claudeHome: string, absPath: string): FileTarget | null {
  const root = projectsDir(claudeHome);
  if (!isInside(root, absPath)) return null;
  const parts = relParts(root, absPath);
  const projectDir = parts[0];
  if (!projectDir) return null;
  if (parts.length === 2) {
    const file = parts[1] ?? '';
    if (!file.endsWith('.jsonl')) return null;
    const sessionId = file.slice(0, -'.jsonl'.length);
    if (!SAFE_ID.test(sessionId)) return null;
    return { kind: 'lead', path: absPath, sessionId, projectDir };
  }
  const sessionId = parts[1] ?? '';
  if (!SAFE_ID.test(sessionId)) return null;
  if (parts.length === 4 && parts[2] === 'subagents') {
    return agentFile(absPath, parts[3] ?? '', sessionId, projectDir, undefined);
  }
  if (parts.length === 4 && parts[2] === 'workflows') {
    const file = parts[3] ?? '';
    if (!file.endsWith('.json')) return null;
    const runId = file.slice(0, -'.json'.length);
    if (!SAFE_ID.test(runId)) return null;
    return { kind: 'wfstate', path: absPath, sessionId, runId, projectDir };
  }
  if (parts.length === 6 && parts[2] === 'subagents' && parts[3] === 'workflows') {
    const runId = parts[4] ?? '';
    const file = parts[5] ?? '';
    if (!SAFE_ID.test(runId)) return null;
    if (file === JOURNAL_FILE) return { kind: 'journal', path: absPath, sessionId, runId, projectDir };
    return agentFile(absPath, file, sessionId, projectDir, runId);
  }
  return null;
}

function agentFile(
  absPath: string,
  file: string,
  sessionId: string,
  projectDir: string,
  runId: string | undefined,
): FileTarget | null {
  const extra = runId ? { runId } : {};
  const sub = SUBAGENT_FILE.exec(file);
  if (sub?.[1]) return { kind: 'subagent', path: absPath, sessionId, agentId: sub[1], projectDir, ...extra };
  const meta = META_FILE.exec(file);
  if (meta?.[1]) return { kind: 'meta', path: absPath, sessionId, agentId: meta[1], projectDir, ...extra };
  return null;
}

/**
 * Carpetas de CLAUDE_HOME/projects que el watcher recorre: proyecto, sesion, subagents,
 * subagents/workflows/<runId> y <sesion>/workflows (solo sus .json; scripts/ queda fuera).
 */
export function isWatchedDir(claudeHome: string, absPath: string): boolean {
  const root = projectsDir(claudeHome);
  if (path.resolve(root) === path.resolve(absPath)) return true;
  if (!isInside(root, absPath)) return false;
  const parts = relParts(root, absPath);
  const [projectDir = '', sessionId = '', third = '', fourth = '', fifth = ''] = parts;
  if (SKIP_DIRS.has(projectDir)) return false;
  if (parts.length === 1) return true;
  if (SKIP_DIRS.has(sessionId) || !SAFE_ID.test(sessionId)) return false;
  if (parts.length === 2) return true;
  if (parts.length === 3) return third === 'subagents' || third === 'workflows';
  if (parts.length === 4) return third === 'subagents' && fourth === 'workflows';
  if (parts.length === 5) return third === 'subagents' && fourth === 'workflows' && SAFE_ID.test(fifth);
  return false;
}

/** <proyecto>/<sessionId>/subagents/workflows */
export function workflowRunsDir(projectDirPath: string, sessionId: string): string {
  return path.join(projectDirPath, sessionId, 'subagents', 'workflows');
}

/** <proyecto>/<sessionId>/workflows (estado final <runId>.json y scripts/) */
export function workflowStateDir(projectDirPath: string, sessionId: string): string {
  return path.join(projectDirPath, sessionId, 'workflows');
}

/** nombre de carpeta que Claude Code usa para un cwd (todo lo no alfanumerico -> '-') */
export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}
