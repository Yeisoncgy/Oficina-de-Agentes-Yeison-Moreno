const numberFmt = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });
const compactFmt2 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
const usdFmt = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdWholeFmt = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

/** 4 s · 2 m 05 s · 1 h 12 m */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} m`;
  if (m > 0) return `${m} m ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

/** Cronometro compacto para etiquetas: 0:04 · 12:05 · 1:12:05 */
export function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = String(totalSec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 950 · 12,3 k · 1,25 M */
export function formatTokens(n: number): string {
  if (n < 1000) return numberFmt.format(n);
  if (n < 1_000_000) return `${compactFmt.format(n / 1000)} k`;
  return `${compactFmt2.format(n / 1_000_000)} M`;
}

/** null = "—" (modelo sin precio conocido) · <$0,01 · $1,23 · $123 */
export function formatUsd(n: number | null): string {
  if (n === null) return '—';
  if (n > 0 && n < 0.01) return '<$0,01';
  if (n >= 100) return `$${usdWholeFmt.format(n)}`;
  return `$${usdFmt.format(n)}`;
}

export function elapsedMs(startIso: string, endIso: string | null, nowMs: number): number {
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : nowMs;
  return Math.max(0, end - start);
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const WEEKDAYS_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/** Hora local: 21:47 · 21:47:03 */
export function formatTimeOfDay(input: string | number, withSeconds = false): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '--:--';
  const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad2(d.getSeconds())}` : base;
}

/** '2026-09' -> 'Septiembre 2026' */
export function formatMonthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !name) return month;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${match[1]}`;
}

/** 27 sep · 27 sep 2025 (si no es el año de referencia) */
export function formatDayMonth(input: string | number, refMs: number = Date.now()): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const base = `${d.getDate()} ${MONTHS_SHORT[d.getMonth()] ?? ''}`;
  return d.getFullYear() === new Date(refMs).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** sáb 27 sep */
export function formatWeekdayDate(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAYS_SHORT[d.getDay()] ?? ''} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()] ?? ''}`;
}

/** 0.247 -> '24,7 %' · 1.3 -> '130 %' */
export function formatPercent(ratio: number): string {
  const pct = Number.isFinite(ratio) ? ratio * 100 : 0;
  return `${Math.abs(pct) >= 100 ? numberFmt.format(pct) : compactFmt.format(pct)} %`;
}

/** Monto o "sin precio" (modelo sin precio conocido): nunca se inventa un monto */
export function formatUsdOrUnpriced(n: number | null): string {
  return n === null ? 'sin precio' : formatUsd(n);
}

/** '2026-09' -> 'Sep' */
export function formatMonthShort(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTHS_SHORT[Number(match[2]) - 1] : undefined;
  if (!name) return month;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** lunes 28 sep */
export function formatWeekdayDateLong(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${WEEKDAYS[d.getDay()] ?? ''} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()] ?? ''}`;
}

/** 22 – 28 sep · 29 sep – 5 oct (dias locales, ambos incluidos) */
export function formatDayRange(fromMs: number, toMs: number): string {
  const a = new Date(fromMs);
  const b = new Date(toMs);
  const monthA = MONTHS_SHORT[a.getMonth()] ?? '';
  const monthB = MONTHS_SHORT[b.getMonth()] ?? '';
  return a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()
    ? `${a.getDate()} – ${b.getDate()} ${monthB}`
    : `${a.getDate()} ${monthA} – ${b.getDate()} ${monthB}`;
}

export function capitalize(text: string): string {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}
