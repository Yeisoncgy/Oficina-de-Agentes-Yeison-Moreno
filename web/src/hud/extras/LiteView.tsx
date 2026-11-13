import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Box,
  CircleCheck,
  Eye,
  EyeOff,
  MessageCircleQuestionMark,
  OctagonAlert,
  Siren,
  TriangleAlert,
} from 'lucide-react';
import type { BudgetResponse, BudgetStatus, OfficeRoom, OfficeSnapshot } from '@shared/contract';
import { agentsNow, quietMs, type NowRow, type NowView } from '@/lib/agentsNow';
import { contextTone } from '@/lib/context';
import {
  elapsedMs,
  formatClock,
  formatDayMonth,
  formatDuration,
  formatMonthLabel,
  formatPercent,
  formatTimeOfDay,
  formatTokens,
  formatUsd,
  formatUsdOrUnpriced,
} from '@/lib/format';
import { currentMonth, daysInMonth, localDateKey } from '@/lib/history';
import { roomAlert, roomState, roomStats, roomStatusText, type RoomState } from '@/lib/office';
import { roomIdentity } from '@/lib/roomIdentity';
import { useBudget } from '@/state/api';
import { roomsBySlot } from '@/state/notesApi';
import { serverNow, useOfficeStore } from '@/state/store';
import { STATE } from '@/theme';
import { Portrait } from '../PixelArt';
import { IconButton, Led, PanelState, SkeletonBlock, STROKE } from '../primitives';
import { useReducedMotion, useViewportWidth } from '../usePresence';
import './lite.css';

/**
 * Vista ligera (?lite=1): los mismos datos en vivo sin la oficina 3D, pensada para dejarla abierta en una
 * ventana angosta al lado del editor o a pantalla completa. Responde dos preguntas de un vistazo: como va el
 * gasto del mes contra el tope y que esta haciendo cada agente. Debajo, las salas.
 *
 * Fluidez: el reloj vive en componentes chicos (Ticking) que comparten un solo intervalo; la vista grande solo
 * se vuelve a dibujar cuando llega un snapshot, y cada tarjeta de agente solo si cambio algo suyo.
 */
export function LiteView() {
  const rootRef = useRef<HTMLDivElement>(null);
  const snapshot = useOfficeStore((s) => s.snapshot);
  const showSpend = useOfficeStore((s) => s.showSpend);
  const top = useTopClearance(rootRef);
  const right = useDrawerReserve();
  const view = useMemo(() => agentsNow(snapshot), [snapshot]);
  const rooms = useMemo(() => (snapshot ? roomsBySlot(snapshot.rooms) : []), [snapshot]);
  const loading = snapshot === null;

  return (
    <div ref={rootRef} className="lite-view" style={{ '--lite-top': `${top}px`, '--lite-right': `${right}px` } as CSSProperties}>
      <div className="lite-scroll">
        <h1 className="sr-only">Vista ligera</h1>
        <div className="lite-grid">
          <BudgetPanel snapshot={snapshot} />
          <AgentsPanel view={view} showSpend={showSpend} loading={loading} />
          <RoomsPanel rooms={rooms} showSpend={showSpend} loading={loading} />
        </div>
        <p className="lite-foot">
          <a className="lite-foot-link" href="?">
            <Box size={13} strokeWidth={STROKE} aria-hidden />
            Abrir la oficina 3D
          </a>
          <span aria-hidden>·</span>
          <span>Valor equivalente API, no es un cobro real.</span>
        </p>
      </div>
      {/* lo que sube al desplazarse se apaga antes de pasar por debajo de las barras flotantes */}
      <div className="lite-fade" aria-hidden />
    </div>
  );
}

/* ------------------------------------------------------------------ reloj compartido */

// Un solo intervalo para todos los cronometros de la vista: cambian en el mismo cuadro y solo se vuelve a
// dibujar el texto que depende del reloj, no la vista entera.
const tickListeners = new Set<() => void>();
let tickNow = 0;
let tickTimer: number | undefined;

function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);
  if (tickTimer === undefined) {
    tickNow = serverNow();
    tickTimer = window.setInterval(() => {
      tickNow = serverNow();
      for (const l of tickListeners) l();
    }, 1_000);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickTimer !== undefined) {
      window.clearInterval(tickTimer);
      tickTimer = undefined;
    }
  };
}

function readTick(): number {
  if (tickNow === 0) tickNow = serverNow();
  return tickNow;
}

function useTick(): number {
  return useSyncExternalStore(subscribeTick, readTick, readTick);
}

/** Texto que depende del reloj, aislado para que el segundero no redibuje lo demas */
function Ticking({ render }: { render: (now: number) => ReactNode }) {
  return <>{render(useTick())}</>;
}

/* ------------------------------------------------------------------ espacio para las barras de arriba */

/**
 * Las barras de arriba flotan sobre la vista (publican su borde en hudInsets) y el aviso de presupuesto
 * (.x-banner) se monta como hermano dentro del HUD: el contenido empieza debajo del que llegue mas abajo.
 */
function useTopClearance(ref: RefObject<HTMLDivElement | null>): number {
  const barsBottom = useOfficeStore((s) => s.hudInsets.top);
  const [bannerBottom, setBannerBottom] = useState(0);

  useEffect(() => {
    const hud = ref.current?.parentElement;
    if (!hud || typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return undefined;
    let banner: HTMLElement | null = null;
    const measure = () => setBannerBottom(banner?.isConnected ? banner.offsetTop + banner.offsetHeight : 0);
    const resize = new ResizeObserver(measure);
    const find = () => {
      const next = hud.querySelector<HTMLElement>(':scope > .x-banner');
      if (next !== banner) {
        if (banner) resize.unobserve(banner);
        banner = next;
        if (banner) resize.observe(banner);
      }
      measure();
    };
    // solo los hijos directos del HUD: abrir un panel o un modal no recorre el arbol entero
    const children = new MutationObserver(find);
    children.observe(hud, { childList: true });
    find();
    return () => {
      children.disconnect();
      resize.disconnect();
    };
  }, [ref]);

  return Math.max(barsBottom, bannerBottom, 52);
}

/**
 * Como la camara de la oficina, que se reencuadra alrededor de los paneles: con el panel de un agente o de una
 * sala abierto a la derecha, el contenido se corre para no quedar debajo. Solo si le quedan al menos 640 px; en
 * una ventana angosta el panel tapa la vista, como antes.
 */
function useDrawerReserve(): number {
  const right = useOfficeStore((s) => s.hudInsets.right);
  const width = useViewportWidth();
  return right > 0 && width - right >= 640 ? right : 0;
}

/* ------------------------------------------------------------------ entrada y salida de filas */

interface Shown<T> {
  item: T;
  leaving: boolean;
}

interface Gone<T> {
  item: T;
  index: number;
  until: number;
}

/**
 * Lista con salida animada sin librerias: la fila que desaparece se sigue mostrando (inerte) en su lugar
 * mientras se desvanece. Con movimiento reducido se va de una.
 */
function useExitingList<T>(items: readonly T[], keyOf: (item: T) => string, exitMs: number): Shown<T>[] {
  const reduced = useReducedMotion();
  const [prev, setPrev] = useState(items);
  const [gone, setGone] = useState<Gone<T>[]>([]);

  if (prev !== items) {
    // se ajusta en el mismo render: la fila no desaparece un cuadro antes de empezar a salir
    const live = new Set(items.map(keyOf));
    const kept = gone.filter((g) => !live.has(keyOf(g.item)));
    const known = new Set(kept.map((g) => keyOf(g.item)));
    const at = performance.now() + exitMs;
    const added: Gone<T>[] = reduced
      ? []
      : prev.flatMap((item, index) => {
          const key = keyOf(item);
          return live.has(key) || known.has(key) ? [] : [{ item, index, until: at }];
        });
    setPrev(items);
    if (added.length > 0 || kept.length !== gone.length) setGone([...kept, ...added]);
  }

  useEffect(() => {
    if (gone.length === 0) return undefined;
    const next = Math.min(...gone.map((g) => g.until));
    const id = window.setTimeout(
      () => setGone((cur) => cur.filter((g) => g.until > performance.now() + 4)),
      Math.max(0, next - performance.now()),
    );
    return () => window.clearTimeout(id);
  }, [gone]);

  const out: Shown<T>[] = items.map((item) => ({ item, leaving: false }));
  for (const g of [...gone].sort((a, b) => a.index - b.index)) {
    out.splice(Math.min(g.index, out.length), 0, { item: g.item, leaving: true });
  }
  return out;
}

/* ------------------------------------------------------------------ presupuesto */

type Tone = 'ok' | 'near' | 'ahead' | 'over';

const TONE_ICON = {
  ok: CircleCheck,
  near: TriangleAlert,
  ahead: TriangleAlert,
  over: OctagonAlert,
} as const;

const dayLabel = (date: string): string => formatDayMonth(`${date}T12:00:00`);

/** parte del mes que ya paso: por dias laborales si el historial los trae (como el recomendado por dia), si no por dias */
function elapsedRatio(month: string, data: BudgetResponse | undefined, nowMs: number): number {
  const work = data?.workdays;
  if (work && work.total > 0) return Math.min(1, Math.max(0, work.elapsed / work.total));
  const current = currentMonth(nowMs);
  if (month < current) return 1;
  if (month > current) return 0;
  return new Date(nowMs).getDate() / daysInMonth(month);
}

interface BudgetModel {
  tone: Tone;
  budget: number;
  spent: number;
  projected: number;
  ideal: number;
  /** posiciones en el medidor (0..100); la escala llega hasta lo mas lejano entre tope, gasto y proyeccion */
  at: { spent: number; budget: number; projected: number; ideal: number };
}

function budgetModel(b: BudgetStatus, data: BudgetResponse | undefined, nowMs: number): BudgetModel {
  const budget = Math.max(0, b.budgetUsd);
  const spent = Math.max(0, b.spentUsd);
  const projected = Math.max(spent, b.projectedUsd);
  const ideal = budget * elapsedRatio(b.month, data, nowMs);
  const scale = Math.max(budget, spent, projected) || 1;
  const pct = (usd: number) => Math.min(100, Math.max(0, (usd / scale) * 100));
  const tone: Tone =
    budget > 0 && spent >= budget ? 'over' : budget > 0 && projected > budget ? 'ahead' : b.threshold >= 75 ? 'near' : 'ok';
  return { tone, budget, spent, projected, ideal, at: { spent: pct(spent), budget: pct(budget), projected: pct(projected), ideal: pct(ideal) } };
}

function statusText(b: BudgetStatus, tone: Tone): { label: string; detail: string | null } {
  if (tone === 'over') return { label: 'Tope superado', detail: b.crossedDate ? `el ${dayLabel(b.crossedDate)}` : null };
  if (tone === 'ahead') return { label: 'Vas a pasarte', detail: b.runOutDate ? `se acaba el ${dayLabel(b.runOutDate)}` : null };
  if (tone === 'near') return { label: 'Cerca del tope', detail: null };
  return { label: 'Dentro del presupuesto', detail: 'alcanza para el mes' };
}

function BudgetPanel({ snapshot }: { snapshot: OfficeSnapshot | null }) {
  const openHistory = useOfficeStore((s) => s.openHistory);
  const demo = useOfficeStore((s) => s.demo);
  // el mismo historial que ya pide la barra de arriba (misma llave): no agrega pedidos al servidor
  const month = currentMonth(Date.now());
  const history = useBudget(month, !demo);
  const budget = snapshot?.budget;
  const data = budget && history.data?.month === budget.month ? history.data : undefined;

  const head = (
    <header className="lite-head">
      <h2 className="lite-title">
        Presupuesto del mes
        {budget ? <span className="lite-title-sub"> · {formatMonthLabel(budget.month).split(' ')[0]}</span> : null}
      </h2>
      <div className="lite-head-aside">
        <button type="button" className="btn btn--sm" onClick={() => openHistory('budget')}>
          Ver detalle
        </button>
      </div>
    </header>
  );

  if (!snapshot) {
    return (
      <section className="lite-panel lite-budget" aria-label="Presupuesto del mes" aria-busy="true">
        {head}
        <SkeletonBlock rows={3} height={44} />
      </section>
    );
  }

  if (!budget) {
    return (
      <section className="lite-panel lite-budget" aria-label="Presupuesto del mes">
        {head}
        <div className="lite-budget-empty">
          <span className="lite-stat-label">Hoy</span>
          <span className="lite-figure lite-figure--sm">{formatUsd(snapshot.today.costUsd)}</span>
          <p className="lite-muted">
            {demo
              ? 'El modo demo no trae el presupuesto del mes: llega con el servidor de la oficina.'
              : 'Todavía no llega el presupuesto del mes desde el servidor de la oficina.'}
          </p>
        </div>
      </section>
    );
  }

  return <BudgetBody budget={budget} data={data} head={head} />;
}

function BudgetBody({ budget: b, data, head }: { budget: BudgetStatus; data: BudgetResponse | undefined; head: ReactNode }) {
  // se recalcula con cada snapshot, no con el segundero: la marca del ritmo ideal se mueve una vez al dia
  const model = budgetModel(b, data, serverNow());
  const { tone, at } = model;
  const status = statusText(b, tone);
  const Icon = TONE_ICON[tone];
  const over = tone === 'over';
  const excess = model.spent - model.budget;
  const remaining = Math.max(0, model.budget - model.spent);
  const perDay = b.perDayUsd;
  const meterLabel = [
    `Gastado ${formatUsd(model.spent)} de ${formatUsd(model.budget)} (${formatPercent(b.usedRatio)})`,
    `ritmo ideal a hoy ${formatUsd(model.ideal)}`,
    `proyección a fin de mes ${formatUsd(model.projected)}`,
  ].join(', ');

  return (
    <section className="lite-panel lite-budget" data-tone={tone} aria-label="Presupuesto del mes">
      {head}
      <div className="lite-budget-body">
        <div className="lite-budget-main">
          <p className="lite-status" role="status">
            <Icon size={14} strokeWidth={2} aria-hidden />
            <b>{status.label}</b>
            {status.detail ? <span>{status.detail}</span> : null}
          </p>

          <div className="lite-figure-row">
            <span className="lite-figure">{formatUsd(model.spent)}</span>
            <span className="lite-figure-side">
              <span>
                de <b>{formatUsd(model.budget)}</b>
              </span>
              <span className="lite-figure-pct">{formatPercent(b.usedRatio)}</span>
            </span>
          </div>
          <p className="lite-delta">
            {over ? (
              <>
                <b>{formatUsd(excess)}</b> por encima del tope
              </>
            ) : (
              <>
                Quedan <b>{formatUsd(remaining)}</b>
                {model.spent > model.ideal ? (
                  <> · {formatUsd(model.spent - model.ideal)} sobre el ritmo ideal</>
                ) : (
                  <> · {formatUsd(model.ideal - model.spent)} por debajo del ritmo ideal</>
                )}
              </>
            )}
          </p>

          <div className="lite-meter" role="img" aria-label={meterLabel}>
            <div className="lite-meter-track">
              <div className="lite-meter-fill">
                {at.projected > at.spent ? (
                  <i className="lite-meter-proj" style={{ left: `${at.spent}%`, width: `${at.projected - at.spent}%` }} />
                ) : null}
                {over ? (
                  <>
                    <i className="lite-meter-base" style={{ width: `${at.budget}%` }} />
                    <i className="lite-meter-excess" style={{ left: `${at.budget}%`, width: `${at.spent - at.budget}%` }} />
                  </>
                ) : (
                  <i className="lite-meter-base is-end" style={{ width: `${at.spent}%` }} />
                )}
              </div>
            </div>
            <i className="lite-meter-cap" style={{ left: `${at.budget}%` }} />
            <i className="lite-meter-ideal" style={{ left: `${at.ideal}%` }} />
          </div>
          <ul className="lite-legend" aria-hidden>
            <li>
              <i className="lite-key-cap" />
              Tope <b>{formatUsd(model.budget)}</b>
            </li>
            <li>
              <i className="lite-key-ideal" />
              Ideal a hoy <b>{formatUsd(model.ideal)}</b>
            </li>
            <li>
              <i className="lite-key-proj" />
              Proyección
            </li>
          </ul>
        </div>

        <dl className="lite-stats">
          <Stat
            label="Hoy"
            value={formatUsd(b.todayUsd)}
            sub={perDay !== null && perDay > 0 ? `${b.dayOver ? 'más de' : 'de'} ${formatUsd(perDay)} por día` : 'en lo que va del día'}
            tone={b.dayOver ? 'warn' : undefined}
          />
          <Stat label="Última hora" value={formatUsd(b.burnPerHourUsd)} sub="últimos 60 min" />
          <Stat
            label="Proyectado"
            value={formatUsd(model.projected)}
            sub={model.budget > 0 && model.projected > model.budget ? `${formatPercent(model.projected / model.budget)} del tope` : 'al cierre del mes'}
            tone={model.projected > model.budget ? (over ? 'over' : 'warn') : undefined}
          />
          <Stat
            label="Por día"
            value={perDay === null ? '—' : formatUsd(perDay)}
            sub={over ? 'ya no queda margen' : perDay === null ? 'no quedan días laborales' : 'recomendado con lo que queda'}
            tone={over ? 'muted' : undefined}
          />
        </dl>
      </div>

      {data && data.daily.length > 0 ? <DailyChart data={data} budgetUsd={model.budget} month={b.month} /> : null}

      {b.estimatedUsd > 0 ? (
        <p className="lite-note">Incluye ~{formatUsd(b.estimatedUsd)} cotizado con precio estimado.</p>
      ) : null}
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'warn' | 'over' | 'muted' }) {
  return (
    <div className={`lite-stat ${tone ? `is-${tone}` : ''}`}>
      <dt className="lite-stat-label">{label}</dt>
      <dd className="lite-stat-value">{value}</dd>
      <dd className="lite-stat-sub">{sub}</dd>
    </div>
  );
}

/** Gasto por dia del mes (barras) contra la cuota pareja del tope; los dias que faltan quedan marcados */
const DailyChart = memo(function DailyChart({ data, budgetUsd, month }: { data: BudgetResponse; budgetUsd: number; month: string }) {
  const days = daysInMonth(month);
  const todayKey = localDateKey(Date.now());
  const work = data.workdays && data.workdays.total > 0 ? data.workdays.total : null;
  const quota = budgetUsd > 0 ? budgetUsd / (work ?? days) : 0;
  const byDate = new Map(data.daily.map((d) => [d.date, d.costUsd]));
  const bars = Array.from({ length: days }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    const cost = byDate.get(date);
    return { date, day: i + 1, cost: cost ?? 0, future: cost === undefined && date > todayKey, today: date === todayKey };
  });
  const peak = bars.reduce((best, d) => (d.cost > best.cost ? d : best), bars[0] ?? { cost: 0, date: '' });
  const max = Math.max(peak.cost, quota) * 1.08 || 1;
  const todayCost = byDate.get(todayKey);
  const label = [
    `Gasto por día de ${formatMonthLabel(month)}`,
    peak.cost > 0 ? `día más alto ${dayLabel(peak.date)} con ${formatUsd(peak.cost)}` : 'sin gasto todavía',
    todayCost !== undefined ? `hoy ${formatUsd(todayCost)}` : null,
    quota > 0 ? `cuota pareja ${formatUsd(quota)} por día${work ? ' laboral' : ''}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <figure className="lite-days-wrap">
      <figcaption className="lite-days-head">
        <span className="lite-stat-label">Gasto por día</span>
        {quota > 0 ? (
          <span className="lite-days-quota">
            <i aria-hidden /> cuota {formatUsd(quota)}/día{work ? ' laboral' : ''}
          </span>
        ) : null}
      </figcaption>
      <div className="lite-days" role="img" aria-label={label} style={{ '--quota': `${(quota / max) * 100}%` } as CSSProperties}>
        {quota > 0 ? <i className="lite-days-line" aria-hidden /> : null}
        {bars.map((d) => (
          <span
            key={d.date}
            className={`lite-day ${d.future ? 'is-future' : d.cost <= 0 ? 'is-zero' : ''} ${d.today ? 'is-today' : ''} ${
              quota > 0 && d.cost > quota ? 'is-over' : ''
            }`}
            style={d.future || d.cost <= 0 ? undefined : { height: `${Math.max(4, (d.cost / max) * 100)}%` }}
            title={d.future ? dayLabel(d.date) : `${dayLabel(d.date)} · ${formatUsd(d.cost)}`}
          />
        ))}
      </div>
      <div className="lite-days-axis" aria-hidden>
        <span>1</span>
        <span>{days}</span>
      </div>
    </figure>
  );
});

/* ------------------------------------------------------------------ agentes */

const EXIT_MS = 180;
const rowKey = (row: NowRow): string => row.agentId;
const needsYou = (row: NowRow): boolean => row.state === 'waiting' || row.alert !== null;

function AgentsPanel({ view, showSpend, loading }: { view: NowView; showSpend: boolean; loading: boolean }) {
  const toggleSpend = useOfficeStore((s) => s.toggleSpend);
  const selectedId = useOfficeStore((s) => s.selectedAgentId);
  const shown = useExitingList(view.rows, rowKey, EXIT_MS);
  const attention = shown.filter((s) => needsYou(s.item));
  const working = shown.filter((s) => !needsYou(s.item));
  const alerts = view.rows.filter((r) => r.alert !== null).length;
  const live = view.rows.length > 0;
  // cuando llegan las primeras tarjetas entran en cascada corta; despues, cada una entra sola
  const firstRowsAt = useRef<number | null>(null);
  if (firstRowsAt.current === null && live) firstRowsAt.current = performance.now();
  const boot = firstRowsAt.current !== null && performance.now() - firstRowsAt.current < 1_200;

  return (
    <section className="lite-panel lite-agents" aria-label="Agentes ahora" aria-busy={loading || undefined}>
      <header className="lite-head">
        <h2 className="lite-title">Agentes ahora</h2>
        {live ? (
          <ul className="lite-counts" aria-label="Resumen">
            <li className="is-working">
              <i aria-hidden />
              {view.working} trabajando
            </li>
            {view.waiting > 0 ? (
              <li className="is-waiting">
                <i aria-hidden />
                {view.waiting} {view.waiting === 1 ? 'espera' : 'esperan'} tu respuesta
              </li>
            ) : null}
            {alerts > 0 ? (
              <li className="is-alert">
                <Siren size={12} strokeWidth={2} aria-hidden />
                {alerts} {alerts === 1 ? 'alerta' : 'alertas'}
              </li>
            ) : null}
          </ul>
        ) : null}
        <div className="lite-head-aside">
          {live ? (
            <span className="lite-total" title="Suma de lo que llevan las tareas en curso (valor equivalente API)">
              <span className="lite-stat-label">En curso</span>
              <b>{showSpend ? formatUsd(view.costUsd) : '···'}</b>
            </span>
          ) : null}
          <IconButton label={showSpend ? 'Ocultar los montos de agentes y salas' : 'Mostrar los montos de agentes y salas'} onClick={toggleSpend}>
            {showSpend ? <Eye size={15} strokeWidth={STROKE} /> : <EyeOff size={15} strokeWidth={STROKE} />}
          </IconButton>
        </div>
      </header>

      {loading ? (
        <SkeletonBlock rows={3} height={72} />
      ) : shown.length === 0 ? (
        <div className="lite-empty">
          <PanelState kind="empty" title="Nadie trabajando ahora" text="Cuando un agente empiece una tarea, aparece aquí con lo que hace y cuánto lleva." />
        </div>
      ) : (
        <>
          {attention.length > 0 ? (
            <AgentGroup
              title={working.length > 0 ? 'Te necesitan' : null}
              items={attention}
              showSpend={showSpend}
              selectedId={selectedId}
              boot={boot}
            />
          ) : null}
          {working.length > 0 ? (
            <AgentGroup
              title={attention.length > 0 ? 'Trabajando' : null}
              items={working}
              showSpend={showSpend}
              selectedId={selectedId}
              boot={boot}
              offset={attention.length}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function AgentGroup({
  title,
  items,
  showSpend,
  selectedId,
  boot,
  offset = 0,
}: {
  title: string | null;
  items: Shown<NowRow>[];
  showSpend: boolean;
  selectedId: string | null;
  boot: boolean;
  offset?: number;
}) {
  return (
    <div className="lite-group">
      {title ? <h3 className="lite-group-title">{title}</h3> : null}
      <ul className="lite-agent-list">
        {items.map((s, i) => (
          <AgentCard
            key={s.item.agentId}
            row={s.item}
            leaving={s.leaving}
            showSpend={showSpend}
            selected={s.item.agentId === selectedId}
            delay={boot ? Math.min(240, (offset + i) * 40) : 0}
          />
        ))}
      </ul>
    </div>
  );
}

function openAgent(roomId: string, agentId: string): void {
  const store = useOfficeStore.getState();
  store.focusRoom(roomId);
  store.selectAgent(agentId);
}

const CONTEXT_FULL = 300_000;

function sameRow(a: NowRow, b: NowRow): boolean {
  for (const key of Object.keys(a) as Array<keyof NowRow>) {
    if (key === 'alert') continue;
    if (a[key] !== b[key]) return false;
  }
  return a.alert?.title === b.alert?.title && a.alert?.level === b.alert?.level;
}

const AgentCard = memo(
  function AgentCard({
    row,
    leaving,
    showSpend,
    selected,
    delay,
  }: {
    row: NowRow;
    leaving: boolean;
    showSpend: boolean;
    selected: boolean;
    delay: number;
  }) {
    const waiting = row.state === 'waiting';
    const kind = row.alert ? 'alert' : waiting ? 'waiting' : 'working';
    const role = row.lead ? (row.name === 'Líder' ? null : 'Líder') : row.role;
    const model = row.model !== '—' ? row.model : null;
    const tone = row.contextTokens !== null ? contextTone(row.contextTokens) : 'ok';
    const ctxPct = row.contextTokens !== null ? Math.min(100, (row.contextTokens / CONTEXT_FULL) * 100) : 0;
    const label = `${row.name}${row.lead ? ', líder' : ''}, sala ${row.roomNumber} ${row.roomTitle}: ${
      row.alert ? `alerta, ${row.alert.title}` : row.doing
    }. Abrir su panel`;

    return (
      <li
        className={`lite-agent-item ${leaving ? 'is-leaving' : ''}`}
        style={{ '--room': row.roomAccent, '--delay': `${delay}ms` } as CSSProperties}
        inert={leaving || undefined}
        aria-hidden={leaving || undefined}
      >
        <button
          type="button"
          className={`lite-agent is-${kind} ${row.contextTokens === null ? 'no-ctx' : ''} ${selected ? 'is-selected' : ''}`}
          onClick={() => openAgent(row.roomId, row.agentId)}
          aria-current={selected || undefined} aria-label={label} title={row.task}>
          <span className="lite-agent-face">
            <Portrait agentType={row.look} size={40} />
          </span>
          <span className="lite-agent-who">
            <span className="lite-agent-name">{row.name}</span>
            {role || model ? (
              <span className="lite-agent-meta">
                {role ? <span>{role}</span> : null}
                {model ? <span className="lite-agent-model">{model}</span> : null}
              </span>
            ) : null}
          </span>
          <span className="lite-agent-room">
            <span className="lite-room-tag">{String(row.roomNumber).padStart(2, '0')}</span>
            <span className="lite-ellipsis">{row.roomTitle}</span>
          </span>
          <span className="lite-agent-now">
            {row.alert ? (
              <Siren size={14} strokeWidth={2} aria-hidden className="lite-agent-glyph" />
            ) : waiting ? (
              <MessageCircleQuestionMark size={14} strokeWidth={2} aria-hidden className="lite-agent-glyph" />
            ) : (
              <Led mode="blink" color={STATE.working} />
            )}
            <span className="lite-ellipsis">
              {row.alert ? row.alert.title : row.doing}
              {row.alert ? <span className="lite-muted"> · {row.doing}</span> : null}
              {waiting && row.waitingSince ? (
                <Ticking render={(now) => <span className="lite-muted"> · hace {formatDuration(elapsedMs(row.waitingSince ?? '', null, now))}</span>} />
              ) : null}
              {row.state === 'working' && row.lastActivityAt ? (
                <Ticking
                  render={(now) => {
                    const quiet = quietMs(row, now);
                    return quiet !== null ? <span className="lite-quiet"> · sin actividad hace {formatDuration(quiet)}</span> : null;
                  }}
                />
              ) : null}
            </span>
          </span>
          <span className="lite-agent-task">{row.task}</span>
          <span className="lite-agent-time">
            {row.since ? <Ticking render={(now) => formatClock(elapsedMs(row.since ?? '', null, now))} /> : '—'}
          </span>
          <span className="lite-agent-cost">{showSpend ? formatUsdOrUnpriced(row.costUsd) : '···'}</span>
          {row.contextTokens !== null ? (
            <span
              className={`lite-ctx is-${tone}`}
              title={`Contexto de su última llamada: ${formatTokens(row.contextTokens)} tokens. Cada llamada nueva lo vuelve a pagar (pesa desde 150 k; mucho desde 300 k)`}
            >
              <span className="lite-ctx-bar" aria-hidden>
                <i style={{ transform: `translateX(${ctxPct - 100}%)` }} />
              </span>
              <span className="lite-ctx-val">{formatTokens(row.contextTokens)}</span>
            </span>
          ) : null}
        </button>
      </li>
    );
  },
  (a, b) =>
    a.leaving === b.leaving && a.showSpend === b.showSpend && a.selected === b.selected && a.delay === b.delay && sameRow(a.row, b.row),
);

/* ------------------------------------------------------------------ salas */

/** el mismo LED que la lista de salas de la oficina: trabajando late en cian, en espera fijo, apagada hueco */
function RoomLed({ state }: { state: RoomState }) {
  if (state === 'working') return <Led mode="blink" color={STATE.working} />;
  if (state === 'waiting') return <Led color={STATE.idle} />;
  return <Led color={STATE.offline} hollow />;
}

/** como la lista de salas de la oficina: abre el panel de la sala; otro clic en la misma lo cierra */
function toggleRoom(roomId: string): void {
  const store = useOfficeStore.getState();
  if (store.selectedRoomId === roomId) {
    store.selectRoom(null);
    return;
  }
  store.focusRoom(roomId);
  store.selectRoom(roomId);
}

function RoomsPanel({ rooms, showSpend, loading }: { rooms: OfficeRoom[]; showSpend: boolean; loading: boolean }) {
  const openHistory = useOfficeStore((s) => s.openHistory);
  const selectedId = useOfficeStore((s) => s.selectedRoomId);
  const maxCost = rooms.reduce((m, r) => Math.max(m, r.costUsd ?? 0), 0);

  return (
    <section className="lite-panel lite-rooms" aria-label="Salas">
      <header className="lite-head">
        <h2 className="lite-title">
          Salas{rooms.length > 0 ? <span className="lite-title-count">{rooms.length}</span> : null}
        </h2>
        <div className="lite-head-aside">
          <button type="button" className="btn btn--sm" onClick={() => openHistory('sessions')}>
            Todas las sesiones
          </button>
        </div>
      </header>
      {loading ? (
        <SkeletonBlock rows={2} height={44} />
      ) : rooms.length === 0 ? (
        <PanelState kind="empty" title="Todavía no hay salas" text="Se muestran las sesiones abiertas y las que tuvieron movimiento hoy." />
      ) : (
        <ul className="lite-room-list">
          {rooms.map((room, index) => (
            <RoomRow
              key={room.id}
              room={room}
              index={index}
              showSpend={showSpend}
              selected={room.id === selectedId}
              share={showSpend && rooms.length > 1 && maxCost > 0 && room.costUsd !== null ? room.costUsd / maxCost : 0}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RoomRow({
  room,
  index,
  showSpend,
  selected,
  share,
}: {
  room: OfficeRoom;
  index: number;
  showSpend: boolean;
  selected: boolean;
  share: number;
}) {
  const identity = roomIdentity(room, index);
  const alert = roomAlert(room);
  const where = room.title === room.projectName ? null : room.projectName;
  const { working } = roomStats(room);
  return (
    <li className="lite-room-item" style={{ '--room': identity.accent } as CSSProperties}>
      <Ticking
        render={(now) => {
          const state = roomState(room, now);
          return (
            <button
              type="button"
              className={`lite-room is-${state} ${selected ? 'is-selected' : ''}`}
              onClick={() => toggleRoom(room.id)}
              aria-pressed={selected}
              title={`${room.cwd}\n${room.lead.task?.title ?? ''}`.trim()}
              aria-label={`Sala ${identity.number}, ${room.title}: ${roomStatusText(room, now)}${alert ? `, alerta: ${alert.alert.title}` : ''}. ${
                selected ? 'Cerrar su panel' : 'Ver su panel'
              }`}
            >
              <span className="lite-room-num" aria-hidden>
                {identity.label}
              </span>
              <span className="lite-room-title">
                <span className="lite-ellipsis">
                  {room.title}
                  {where ? <span className="lite-muted"> · {where}</span> : null}
                </span>
                {alert ? <Siren size={13} strokeWidth={2} aria-hidden className="lite-room-alert" /> : null}
              </span>
              <span className="lite-room-status">
                <RoomLed state={state} />
                <span className="lite-ellipsis">
                  {state === 'working' && working > 0 ? `${working} trabajando` : roomStatusText(room, now)}
                </span>
              </span>
              <span className="lite-room-cost">{showSpend ? formatUsdOrUnpriced(room.costUsd) : '···'}</span>
              <span className="lite-room-time" title="Última actividad">
                {formatTimeOfDay(room.lastActivityAt)}
              </span>
              {share > 0 ? (
                <span className="lite-room-share" aria-hidden title="Costo de la sesión frente a la sala que más lleva">
                  <i style={{ transform: `translateX(${share * 100 - 100}%)` }} />
                </span>
              ) : null}
            </button>
          );
        }}
      />
    </li>
  );
}
