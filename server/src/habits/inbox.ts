import type { HabitFinding, InboxGroup, InboxItem, InboxLevel, LiveAlert, RuleId } from '@shared/contract';
import type { Db } from '../db/connection';

// Bandeja: alertas (critical) y avisos (warning) vivos, con un texto listo para pegar en Claude Code. Lo que
// se copia queda descartado hasta que salga algo nuevo. Los descartes se cargan una vez y viven en memoria:
// refresh() no consulta la DB, solo escribe al descartar, restaurar u olvidar (tabla dismissed_alerts, v16).

/** un descarte ausente de lo vivo mas de esto se olvida: si vuelve despues, es un episodio nuevo */
export const DISMISS_FORGET_MS = 30 * 60_000;

export type Severity = HabitFinding['severity'];

const RANK: Readonly<Record<Severity, number>> = { critical: 0, warning: 1, info: 2 };

function isSeverity(v: string): v is Severity {
  return v === 'critical' || v === 'warning' || v === 'info';
}

export function findingKey(id: string): string {
  return `f:${id}`;
}

/** hallazgo juntado (group.ts): su llave puede volver si suma miembros */
const GROUP_KEY_PREFIX = findingKey('grupo:');

export function alertKey(scope: 'agent' | 'room', id: string, alert: Pick<LiveAlert, 'source' | 'ruleId'>): string {
  return `a:${scope}:${id}:${alert.source}:${alert.ruleId ?? '-'}`;
}

/** reglas cuya alerta viva va sobre el agente; las demas van sobre la sala */
const AGENT_RULES: ReadonlySet<RuleId> = new Set<RuleId>(['agent_cost', 'loop_repeats']);

/**
 * Alertas vivas que un hallazgo ya cuenta: no entran a la bandeja por separado y se descartan con el. Se
 * decide por la regla y no por agentId: turns_without_compact y subagents_per_turn llevan al lead como
 * agente, pero su alerta viva es de la sala.
 */
export function coveredAlertKeys(f: Pick<HabitFinding, 'kind' | 'ruleId' | 'agentId' | 'roomId'>): string[] {
  const ruleId = f.kind === 'loop' ? 'loop_repeats' : f.ruleId;
  if (!ruleId) return [];
  if (!AGENT_RULES.has(ruleId)) return [alertKey('room', f.roomId, { source: 'rule', ruleId })];
  return f.agentId !== null ? [alertKey('agent', f.agentId, { source: 'rule', ruleId })] : [];
}

/** lo que se ve vivo en una pasada, por llave */
export interface SeenItem {
  level: Severity;
  /** miembros de un grupo; 0 si no es grupo */
  size: number;
}

export interface DismissInput {
  key: string;
  level: Severity;
  size: number;
  /** se descartan con esta llave: sus alertas cubiertas y, si es un grupo, sus miembros */
  children: readonly { key: string; level: Severity }[];
}

interface Entry {
  level: Severity;
  size: number;
  /** solo en memoria: al arrancar vale "ahora" para todos */
  lastSeen: number;
}

/** descartes de la bandeja (lo que escribe el usuario: la DB no lo reconstruye) */
export class DismissedAlerts {
  private readonly db: Db;
  private readonly entries = new Map<string, Entry>();
  /** lo que se guardo con cada llave, para restaurarlo con ella */
  private readonly children = new Map<string, readonly string[]>();
  private readonly put;
  private readonly del;

  constructor(db: Db, now: number) {
    this.db = db;
    this.put = db.prepare<[string, string, number, number]>(
      `INSERT INTO dismissed_alerts (key, level, size, dismissed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET level = excluded.level, size = excluded.size, dismissed_at = excluded.dismissed_at`,
    );
    this.del = db.prepare<[string]>(`DELETE FROM dismissed_alerts WHERE key = ?`);
    const rows = db.prepare<[], { key: string; level: string; size: number }>(`SELECT key, level, size FROM dismissed_alerts`).all();
    for (const r of rows) this.entries.set(r.key, { level: isSeverity(r.level) ? r.level : 'critical', size: r.size, lastSeen: now });
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Marca lo visto y olvida los descartes que ya no aplican: ausente mas de DISMISS_FORGET_MS, nivel mas
   * severo que el guardado o grupo con mas miembros. Al olvidar por subir, se olvidan tambien sus alertas
   * cubiertas (`covers`). Solo escribe en la DB si olvida algo.
   */
  observe(seen: ReadonlyMap<string, SeenItem>, now: number, covers: (key: string) => readonly string[]): void {
    const forget: string[] = [];
    for (const [key, e] of this.entries) {
      const s = seen.get(key);
      if (!s) {
        if (now - e.lastSeen > DISMISS_FORGET_MS) forget.push(key);
        continue;
      }
      e.lastSeen = now;
      const grew = key.startsWith(GROUP_KEY_PREFIX) && s.size > e.size;
      if (RANK[s.level] < RANK[e.level] || grew) forget.push(key, ...covers(key));
    }
    this.forget(forget);
  }

  add(items: readonly DismissInput[], now: number): void {
    const rows = new Map<string, { level: Severity; size: number }>();
    for (const it of items) {
      for (const c of it.children) if (!rows.has(c.key)) rows.set(c.key, { level: c.level, size: 0 });
      rows.set(it.key, { level: it.level, size: it.size });
    }
    if (rows.size === 0) return;
    this.db.transaction(() => {
      for (const [key, r] of rows) this.put.run(key, r.level, r.size, now);
    })();
    for (const [key, r] of rows) this.entries.set(key, { ...r, lastSeen: now });
    for (const it of items) this.children.set(it.key, it.children.map((c) => c.key));
  }

  /** borra esos descartes, lo que se guardo con ellos y `extra` (hijos calculados de lo vivo) */
  restore(keys: readonly string[], extra: (key: string) => readonly string[]): void {
    const all = new Set<string>();
    for (const k of keys) {
      all.add(k);
      for (const c of this.children.get(k) ?? []) all.add(c);
      for (const c of extra(k)) all.add(c);
    }
    this.forget([...all]);
  }

  private forget(keys: readonly string[]): void {
    const present = [...new Set(keys)].filter((k) => this.entries.has(k));
    if (present.length === 0) return;
    this.db.transaction(() => {
      for (const k of present) this.del.run(k);
    })();
    for (const k of present) {
      this.entries.delete(k);
      this.children.delete(k);
    }
  }
}

// ---- Texto para pegar en Claude Code ----

const HEADER: Readonly<Record<InboxLevel, string>> = {
  critical:
    'Estas son las alertas críticas de consumo de tokens que detectó mi Oficina Virtual en mis sesiones de Claude Code. Corrígelas en este orden y aplica cada instrucción desde ahora:',
  warning:
    'Estos son los avisos de hábitos que gastan tokens de más en mis sesiones de Claude Code. Aplica estas correcciones desde ahora:',
};

const COMMANDS_HEADER = 'Para ejecutar yo (tú no puedes correr comandos de barra):';
const CLOSING = 'Cuando termines, dime en una línea qué cambiaste en cada punto.';

/** por sala, en el orden en que aparece cada una; dentro de la sala se conserva el orden */
export function byRoom<T extends { roomId: string }>(items: readonly T[]): T[][] {
  const rooms = new Map<string, T[]>();
  for (const it of items) {
    const list = rooms.get(it.roomId) ?? [];
    list.push(it);
    rooms.set(it.roomId, list);
  }
  return [...rooms.values()];
}

function roomLine(it: InboxItem): string {
  const project = it.projectName && it.projectName !== it.roomTitle ? ` (${it.projectName})` : '';
  return `Sala "${it.roomTitle}"${project}`;
}

/**
 * Texto ordenado por sala y numerado de corrido. Una instruccion repetida en la misma sala remite al primer
 * punto; un comando de barra (/compact) no lo puede correr Claude Code: va al final para ejecutarlo a mano.
 * Nunca lleva texto de prompts.
 */
export function composeInboxText(level: InboxLevel, items: readonly InboxItem[]): string {
  if (items.length === 0) return '';
  const blocks: string[] = [HEADER[level]];
  const commands: string[] = [];
  let n = 0;
  for (const room of byRoom(items)) {
    const first = room[0];
    if (!first) continue;
    const lines = [roomLine(first)];
    const pointOf = new Map<string, number>();
    for (const it of room) {
      n++;
      // el lead viene sin nombre: las instrucciones ya le hablan a el
      const who = it.agentName ? ` · ${it.agentName}` : '';
      lines.push(`${n}. ${it.title}${who}`);
      const instruction = it.instruction.trim();
      let what: string;
      if (instruction.startsWith('/')) {
        what = 'lo ejecuto yo con el comando del final.';
        const cmd = `- Sala "${first.roomTitle}": ${instruction}`;
        if (!commands.includes(cmd)) commands.push(cmd);
      } else {
        const prev = pointOf.get(instruction);
        what = prev !== undefined ? `lo mismo que el punto ${prev}.` : instruction;
        if (prev === undefined) pointOf.set(instruction, n);
      }
      lines.push(`   Qué hacer: ${what}`);
    }
    blocks.push(lines.join('\n'));
  }
  if (commands.length > 0) blocks.push([COMMANDS_HEADER, ...commands].join('\n'));
  blocks.push(CLOSING);
  return blocks.join('\n\n');
}

/** grupo de la bandeja: items ya en el orden de la lista, juntados por sala */
export function inboxGroup(level: InboxLevel, items: readonly InboxItem[]): InboxGroup {
  const ordered = byRoom(items.filter((i) => i.level === level)).flat();
  return { level, items: ordered, text: composeInboxText(level, ordered) };
}
