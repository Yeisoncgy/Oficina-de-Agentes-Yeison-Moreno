import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runBackfill, type AppContext } from '../src/app';
import { openDb } from '../src/db/connection';

export const FIXTURE_HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-home');
export const SESSION_ID = '11111111-2222-4333-8444-555555555555';
export const EXPLORE_ID = 'aexplore0000000001';
export const BUILDER_ID = 'abuilder0000000001';

export function at(isoTime: string): number {
  return Date.parse(isoTime);
}

/** ingiere el CLAUDE_HOME sintetico en una DB :memory: con un reloj fijo */
export async function loadFixture(nowIso = '2026-01-15T10:11:00.000Z', home = FIXTURE_HOME): Promise<AppContext> {
  const now = at(nowIso);
  const ctx = createContext({ db: openDb(':memory:'), claudeHome: home, now: () => now, log: () => {} });
  await runBackfill(ctx);
  return ctx;
}

/** CLAUDE_HOME sintetico con una corrida del tool Workflow (subagents/workflows/wf_falso) */
export const WORKFLOW_HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'workflow-home');
export const WF_SESSION_ID = '33333333-4444-4555-8666-777777777777';
export const WF_PROJECT = 'C--demo-flujo-falso';

/** CLAUDE_HOME temporal (fuera del arbol del proyecto) para pruebas que escriben archivos */
export class TempHome {
  readonly root: string;
  private readonly files: string[] = [];
  private readonly dirs: string[] = [];

  constructor() {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'oficina-test-'));
    this.dirs.push(this.root);
  }

  path(...parts: string[]): string {
    return path.join(this.root, ...parts);
  }

  write(rel: string, content: string): string {
    const full = this.path(rel);
    this.ensureDir(path.dirname(full));
    fs.writeFileSync(full, content);
    if (!this.files.includes(full)) this.files.push(full);
    return full;
  }

  append(rel: string, content: string): void {
    fs.appendFileSync(this.path(rel), content);
  }

  /** borra solo lo que creo, archivo por archivo (sin borrado recursivo) */
  cleanup(): void {
    for (const f of this.files) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ya no existe
      }
    }
    for (const d of [...this.dirs].reverse()) {
      try {
        fs.rmdirSync(d);
      } catch {
        // no vacio o ya no existe
      }
    }
  }

  private ensureDir(dir: string): void {
    const missing: string[] = [];
    let cur = dir;
    while (!fs.existsSync(cur)) {
      missing.push(cur);
      cur = path.dirname(cur);
    }
    for (const d of missing.reverse()) {
      fs.mkdirSync(d);
      this.dirs.push(d);
    }
  }
}

export function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}
