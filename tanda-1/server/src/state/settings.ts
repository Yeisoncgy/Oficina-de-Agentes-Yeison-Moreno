import { cleanLeadName } from '@shared/agents';
import type { Db } from '../db/connection';

/** ajuste del presupuesto: el gasto real que dijo el usuario en un momento; desde ahi se suma lo nuevo */
export interface BudgetBaseline {
  /** 'YYYY-MM' (hora local) del mes ajustado */
  month: string;
  amountUsd: number;
  /** epoch ms del ajuste */
  since: number;
}

/** ajuste unico de antes (se lee como respaldo y pasa al mapa en la primera escritura) */
const BASELINE_KEY = 'budget_baseline';
/** ajustes por mes: { 'YYYY-MM': { amountUsd, since } }. Ajustar un mes no borra el de otro */
const BASELINES_KEY = 'budget_baselines';
/** monto mensual que fijo el usuario (numero); sin la clave rige BUDGET_DEFAULT_USD */
const BUDGET_KEY = 'budget_usd';
/** dias libres entre semana que marco el usuario: ['YYYY-MM-DD', ...] ordenados */
const DAYS_OFF_KEY = 'days_off';
/** lugar fijo de cada sala en el mapa: { sessionId: slot } */
const ROOM_SLOTS_KEY = 'room_slots';
/** nombre del lead que eligio el usuario (texto); sin la clave la web lo pide */
const LEAD_NAME_KEY = 'lead_name';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** un ajuste guardado: la clave vieja lo trae como JSON con su mes; el mapa, como objeto bajo el mes */
function parseBaseline(raw: unknown, month: string | null): BudgetBaseline | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<BudgetBaseline>;
  const m = month ?? o.month;
  if (typeof m !== 'string' || typeof o.amountUsd !== 'number' || typeof o.since !== 'number') return null;
  return { month: m, amountUsd: o.amountUsd, since: o.since };
}

export class Settings {
  private readonly get;
  private readonly put;
  private readonly del;

  constructor(db: Db) {
    this.get = db.prepare<[string], { value: string }>(`SELECT value FROM settings WHERE key = ?`);
    this.put = db.prepare<[string, string]>(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    this.del = db.prepare<[string]>(`DELETE FROM settings WHERE key = ?`);
  }

  /** ajuste del mes 'YYYY-MM'; null si ese mes no se ajusto */
  baseline(month: string): BudgetBaseline | null {
    return this.baselines().get(month) ?? null;
  }

  setBaseline(b: BudgetBaseline): void {
    const all = this.baselines();
    all.set(b.month, b);
    this.saveBaselines(all);
  }

  /** quita solo el ajuste de ese mes */
  clearBaseline(month: string): void {
    const all = this.baselines();
    all.delete(month);
    this.saveBaselines(all);
  }

  private baselines(): Map<string, BudgetBaseline> {
    const out = new Map<string, BudgetBaseline>();
    const legacy = this.get.get(BASELINE_KEY);
    if (legacy) {
      const b = parseBaseline(legacy.value, null);
      if (b) out.set(b.month, b);
    }
    const row = this.get.get(BASELINES_KEY);
    if (!row) return out;
    try {
      const v = JSON.parse(row.value) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [month, raw] of Object.entries(v)) {
          const b = parseBaseline(raw, month);
          if (b) out.set(month, b);
        }
      }
    } catch {
      // valor corrupto: se ignora como si no hubiera ajustes
    }
    return out;
  }

  private saveBaselines(all: ReadonlyMap<string, BudgetBaseline>): void {
    const value: Record<string, { amountUsd: number; since: number }> = {};
    for (const [month, b] of [...all].sort(([a], [z]) => a.localeCompare(z))) {
      value[month] = { amountUsd: b.amountUsd, since: b.since };
    }
    this.put.run(BASELINES_KEY, JSON.stringify(value));
    this.del.run(BASELINE_KEY);
  }

  /** monto del presupuesto mensual que fijo el usuario; null = el de por defecto */
  budgetUsd(): number | null {
    const row = this.get.get(BUDGET_KEY);
    if (!row) return null;
    const v = Number(row.value);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  setBudgetUsd(amountUsd: number): void {
    this.put.run(BUDGET_KEY, String(amountUsd));
  }

  clearBudgetUsd(): void {
    this.del.run(BUDGET_KEY);
  }

  daysOff(): string[] {
    const row = this.get.get(DAYS_OFF_KEY);
    if (!row) return [];
    try {
      const v = JSON.parse(row.value) as unknown;
      if (Array.isArray(v)) return v.filter((d): d is string => typeof d === 'string' && DATE_RE.test(d));
    } catch {
      // valor corrupto: sin dias libres
    }
    return [];
  }

  setDaysOff(days: readonly string[]): void {
    this.put.run(DAYS_OFF_KEY, JSON.stringify([...new Set(days)].sort()));
  }

  roomSlots(): Map<string, number> {
    const out = new Map<string, number>();
    const row = this.get.get(ROOM_SLOTS_KEY);
    if (!row) return out;
    try {
      const v = JSON.parse(row.value) as unknown;
      if (v && typeof v === 'object') {
        for (const [id, slot] of Object.entries(v)) {
          if (typeof slot === 'number' && Number.isInteger(slot) && slot >= 0) out.set(id, slot);
        }
      }
    } catch {
      // valor corrupto: las salas toman lugar de nuevo
    }
    return out;
  }

  setRoomSlots(slots: ReadonlyMap<string, number>): void {
    this.put.run(ROOM_SLOTS_KEY, JSON.stringify(Object.fromEntries(slots)));
  }

  /**
   * nombre del lead; null si el usuario no eligio uno o el guardado quedo vacio al limpiarlo. Sin cache:
   * lo escribe la ruta con otra instancia y el build lo lee en cada snapshot
   */
  leadName(): string | null {
    return cleanLeadName(this.get.get(LEAD_NAME_KEY)?.value);
  }

  /** guarda el nombre ya limpio (cleanLeadName) */
  setLeadName(name: string): void {
    this.put.run(LEAD_NAME_KEY, name);
  }
}
