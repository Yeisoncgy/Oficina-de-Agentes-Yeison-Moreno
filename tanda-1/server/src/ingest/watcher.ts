import type { Stats } from 'node:fs';
import { watch, type FSWatcher } from 'chokidar';
import { baseName } from './labels';
import { classifyPath, isInside, isWatchedDir, projectsDir, sessionsDir, type FileTarget } from './paths';

export interface WatcherHandlers {
  onFile: (target: FileTarget) => void;
  onRegistry: () => void;
  onError?: (err: unknown) => void;
}

/**
 * filtro de chokidar: en projects solo recorre las carpetas de isWatchedDir y solo acepta los
 * archivos que classifyPath reconoce; en sessions solo .json
 */
export function makeIgnored(claudeHome: string): (p: string, stats?: Stats) => boolean {
  const sessions = sessionsDir(claudeHome);
  const projects = projectsDir(claudeHome);
  return (p, stats) => {
    const name = baseName(p);
    const looksLikeFile = stats ? stats.isFile() : /\.[A-Za-z0-9]+$/.test(name);
    if (isInside(sessions, p)) return looksLikeFile ? !name.endsWith('.json') : true;
    if (!isInside(projects, p)) return false;
    if (!looksLikeFile) return !isWatchedDir(claudeHome, p);
    return classifyPath(claudeHome, p) === null;
  };
}

export function startWatcher(claudeHome: string, handlers: WatcherHandlers): FSWatcher {
  const sessions = sessionsDir(claudeHome);
  const watcher = watch([projectsDir(claudeHome), sessions], {
    ignoreInitial: true,
    // <proyecto>/<sesion>/subagents/workflows/<runId>/agent-<id>.jsonl
    depth: 5,
    ignored: makeIgnored(claudeHome),
    persistent: true,
  });
  const onPath = (p: string): void => {
    if (isInside(sessions, p)) {
      handlers.onRegistry();
      return;
    }
    const target = classifyPath(claudeHome, p);
    if (target) handlers.onFile(target);
  };
  watcher.on('add', onPath);
  watcher.on('change', onPath);
  watcher.on('unlink', (p) => {
    if (isInside(sessions, p)) handlers.onRegistry();
  });
  watcher.on('error', (err) => handlers.onError?.(err));
  return watcher;
}
