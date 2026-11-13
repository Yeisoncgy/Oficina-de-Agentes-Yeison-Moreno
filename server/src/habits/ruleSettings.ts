import type { RuleId } from '@shared/contract';
import type { Db } from '../db/connection';

/** clave de la tabla settings: lo que el usuario ajusto en la pestana Reglas (no se reconstruye) */
const RULES_KEY = 'rules';

export const RULE_IDS: readonly RuleId[] = [
  'agent_cost',
  'session_day_cost',
  'workflow_cost',
  'turns_without_compact',
  'subagents_per_turn',
  'loop_repeats',
];

export function isRuleId(v: unknown): v is RuleId {
  return typeof v === 'string' && (RULE_IDS as readonly string[]).includes(v);
}

export interface RuleSettingsValue {
  /** umbral fijado a mano por regla */
  overrides: Partial<Record<RuleId, number>>;
  disabled: RuleId[];
  notifyBrowser: boolean;
}

/** lectura tolerante: una clave o un valor que no se entiende se ignora como si no existiera */
export function parseRuleSettings(raw: string | null | undefined): RuleSettingsValue {
  const empty: RuleSettingsValue = { overrides: {}, disabled: [], notifyBrowser: false };
  if (!raw) return empty;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return empty;
  }
  const o = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const overrides: Partial<Record<RuleId, number>> = {};
  if (o.overrides !== null && typeof o.overrides === 'object' && !Array.isArray(o.overrides)) {
    for (const [id, n] of Object.entries(o.overrides as Record<string, unknown>)) {
      if (isRuleId(id) && typeof n === 'number' && Number.isFinite(n) && n > 0) overrides[id] = n;
    }
  }
  const disabled = Array.isArray(o.disabled) ? [...new Set(o.disabled.filter(isRuleId))] : [];
  return { overrides, disabled, notifyBrowser: o.notifyBrowser === true };
}

/** ajustes de las reglas en la tabla settings (clave `rules`, sin migracion) */
export class RuleSettings {
  private readonly get;
  private readonly put;

  constructor(db: Db) {
    this.get = db.prepare<[string], { value: string }>(`SELECT value FROM settings WHERE key = ?`);
    this.put = db.prepare<[string, string]>(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
  }

  read(): RuleSettingsValue {
    return parseRuleSettings(this.get.get(RULES_KEY)?.value);
  }

  write(v: RuleSettingsValue): void {
    this.put.run(RULES_KEY, JSON.stringify(v));
  }
}
