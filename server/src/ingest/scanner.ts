import fs from 'node:fs';
import path from 'node:path';
import {
  classifyPath,
  projectsDir,
  SAFE_ID,
  sanitizeCwd,
  SKIP_DIRS,
  workflowRunsDir,
  workflowStateDir,
  type FileTarget,
} from './paths';

async function readdirSafe(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function mtimeOf(file: string): Promise<number> {
  try {
    return (await fs.promises.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

/** metas primero y luego transcripts de los archivos agent-* de una carpeta */
async function agentTargets(claudeHome: string, dir: string): Promise<FileTarget[]> {
  const files = (await readdirSafe(dir)).filter((e) => e.isFile()).map((e) => e.name);
  const metas: FileTarget[] = [];
  const subs: FileTarget[] = [];
  for (const name of files) {
    const t = classifyPath(claudeHome, path.join(dir, name));
    if (t?.kind === 'meta') metas.push(t);
    else if (t?.kind === 'subagent') subs.push(t);
  }
  return [...metas, ...subs];
}

export interface SessionTargetOptions {
  /** omite las corridas de Workflow que ya tienen su estado final (<sesion>/workflows/<runId>.json) */
  skipFinishedWorkflows?: boolean;
}

/**
 * archivos de una sesion: lead, subagentes (metas antes que transcripts) y por cada corrida de
 * Workflow sus agentes, su journal y su estado final
 */
export async function sessionTargets(
  claudeHome: string,
  projectDirPath: string,
  sessionId: string,
  opts: SessionTargetOptions = {},
): Promise<FileTarget[]> {
  const out: FileTarget[] = [];
  const lead = classifyPath(claudeHome, path.join(projectDirPath, `${sessionId}.jsonl`));
  if (lead && fs.existsSync(lead.path)) out.push(lead);
  out.push(...(await agentTargets(claudeHome, path.join(projectDirPath, sessionId, 'subagents'))));

  const runsDir = workflowRunsDir(projectDirPath, sessionId);
  const stateDir = workflowStateDir(projectDirPath, sessionId);
  for (const run of await readdirSafe(runsDir)) {
    if (!run.isDirectory() || !SAFE_ID.test(run.name)) continue;
    const state = classifyPath(claudeHome, path.join(stateDir, `${run.name}.json`));
    const finished = state !== null && fs.existsSync(state.path);
    if (state && finished && opts.skipFinishedWorkflows) {
      out.push(state);
      continue;
    }
    const runDir = path.join(runsDir, run.name);
    out.push(...(await agentTargets(claudeHome, runDir)));
    const journal = classifyPath(claudeHome, path.join(runDir, 'journal.jsonl'));
    if (journal && fs.existsSync(journal.path)) out.push(journal);
    if (state && finished) out.push(state);
  }
  return out;
}

/**
 * Descubre todos los transcripts con readdir dirigido (projects/<p>/*.jsonl,
 * projects/<p>/<sesion>/subagents/* y subagents/workflows/<runId>/*), sin recorrer tool-results/,
 * memory/ ni workflows/scripts/. Las sesiones mas recientes van primero para que la oficina se
 * pueble rapido.
 */
export async function discoverTargets(claudeHome: string): Promise<FileTarget[]> {
  const root = projectsDir(claudeHome);
  const groups: Array<{ mtime: number; targets: FileTarget[] }> = [];
  for (const project of await readdirSafe(root)) {
    if (!project.isDirectory() || SKIP_DIRS.has(project.name)) continue;
    const dir = path.join(root, project.name);
    const entries = await readdirSafe(dir);
    const sessionIds = new Set<string>();
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) sessionIds.add(e.name.slice(0, -'.jsonl'.length));
      else if (e.isDirectory() && !SKIP_DIRS.has(e.name)) sessionIds.add(e.name);
    }
    for (const sessionId of sessionIds) {
      if (!SAFE_ID.test(sessionId)) continue;
      const targets = await sessionTargets(claudeHome, dir, sessionId);
      if (targets.length === 0) continue;
      groups.push({ mtime: await mtimeOf(path.join(dir, `${sessionId}.jsonl`)), targets });
    }
  }
  groups.sort((a, b) => b.mtime - a.mtime);
  return groups.flatMap((g) => g.targets);
}

/** carpeta de proyecto de un cwd (la mayuscula de la unidad varia: se compara sin distinguir) */
export async function findProjectDir(claudeHome: string, cwd: string): Promise<string | null> {
  const wanted = sanitizeCwd(cwd).toLowerCase();
  const root = projectsDir(claudeHome);
  for (const e of await readdirSafe(root)) {
    if (e.isDirectory() && e.name.toLowerCase() === wanted) return path.join(root, e.name);
  }
  return null;
}
