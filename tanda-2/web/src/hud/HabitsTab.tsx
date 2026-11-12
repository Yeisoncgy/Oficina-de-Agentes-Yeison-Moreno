import { useEffect, useId, useState } from 'react';
import { Check, ClipboardCopy } from 'lucide-react';
import type { HabitFinding, HabitKind, HabitsResponse } from '@shared/contract';
import { copyText } from '@/lib/copy';
import { formatUsd } from '@/lib/format';
import { rowEnterDelay } from '@/lib/motion';
import { describeApiError, useHabits, type HabitsRange } from '@/state/api';
import { useOfficeStore } from '@/state/store';
import {
  findingWhere,
  formatEvidence,
  formatSavings,
  HABIT_KIND_LABEL,
  SEVERITY_COLOR,
  SEVERITY_LABEL,
} from './insights/model';
import { AlertsInbox } from './insights/AlertsInbox';
import { PeriodPicker } from './insights/PeriodPicker';
import { Led, PanelState, SkeletonBlock, STROKE } from './primitives';
import './insights.css';

const RANGES: { value: HabitsRange; label: string }[] = [
  { value: 'live', label: 'En vivo' },
  { value: 'today', label: 'Hoy' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
];

const EMPTY_TEXT: Record<HabitsRange, string> = {
  live: 'Nada que corregir ahora.',
  today: 'Nada que corregir hoy.',
  week: 'Nada que corregir en los últimos 7 días.',
  month: 'Nada que corregir este mes.',
};

/** filas visibles antes de "Ver N más" */
const HABITS_PAGE = 12;

/** Evidencias visibles al desplegar un hallazgo; el resto va en un "+N" */
const EVIDENCE_MAX = 4;

/** Habitos: malos habitos de consumo de tokens, el ahorro estimado y que pedir distinto */
export function HabitsTab() {
  // otras vistas abren Habitos en un periodo dado (store.habitsRange); si no, En vivo
  const [range, setRange] = useState<HabitsRange>(() => useOfficeStore.getState().habitsRange ?? 'live');
  const [kind, setKind] = useState<HabitKind | null>(null);
  const demo = useOfficeStore((s) => s.demo);
  const query = useHabits(range);
  const data = query.data;
  // el filtro se suelta solo si el periodo nuevo no tiene hallazgos de ese tipo; se cuenta con byKind
  // (todos), no con la lista, que llega recortada a HABITS_LIST_MAX
  const activeKind = kind !== null && data?.byKind.some((k) => k.kind === kind && k.count > 0) ? kind : null;
  const shown = data ? data.findings.filter((f) => activeKind === null || f.kind === activeKind) : [];

  return (
    <>
      {/* el selector va siempre primero: asi no se vuelve a montar (ni pierde el foco) al entrar o salir de En vivo */}
      <div className="ins-top habit-top">
        <PeriodPicker options={RANGES} value={range} onChange={setRange} />
        {/* la bandeja descarta en el server: solo sobre lo vivo y nunca en demo (no hay server) */}
        {range === 'live' && !demo ? <AlertsInbox /> : null}
      </div>
      {query.isPending ? (
        <SkeletonBlock rows={4} height={48} />
      ) : query.isError && !data ? (
        <PanelState
          kind="error"
          title="No se pudieron cargar los hábitos"
          text={describeApiError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : data && data.findings.length === 0 ? (
        <PanelState kind="empty" title={EMPTY_TEXT[range]} />
      ) : data ? (
        <div
          key={range}
          className="habit-view transition-opacity duration-150"
          style={{ opacity: query.isPlaceholderData ? 0.5 : 1 }}
        >
          <Summary data={data} />
          <KindFilter data={data} kind={activeKind} onKind={setKind} />
          {shown.length > 0 ? (
            <FindingList key={activeKind ?? 'all'} findings={shown} showKind={activeKind === null} />
          ) : (
            <p className="ui-hint" role="status">
              Este tipo no está entre los {data.findings.length} hallazgos que se muestran.
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}

const countFmt = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

/** "12 hallazgos"; si el server recorto la lista (total > findings), "200 de 1.177 hallazgos" */
function findingsCount(data: HabitsResponse): string {
  const n = data.findings.length;
  const total = data.total ?? n;
  if (total > n) return `${countFmt.format(n)} de ${countFmt.format(total)} hallazgos`;
  return `${countFmt.format(n)} ${n === 1 ? 'hallazgo' : 'hallazgos'}`;
}

function Summary({ data }: { data: HabitsResponse }) {
  const total = formatSavings(data.totalSavingsUsd);
  return (
    <div className="ui-stats">
      <div className={`ui-stat ui-stat--hero habit-total ${total ? 'ui-stat--ok' : ''}`}>
        <span className="ui-stat-label">Ahorro posible</span>
        <span className="ui-stat-value">{total ?? formatUsd(0)}</span>
        <span className="ui-stat-sub">{findingsCount(data)}</span>
      </div>
    </div>
  );
}

/** Filtro por tipo: "Todos" + un chip por tipo con su conteo; otro clic en el activo lo suelta */
function KindFilter({
  data,
  kind,
  onKind,
}: {
  data: HabitsResponse;
  kind: HabitKind | null;
  onKind: (kind: HabitKind | null) => void;
}) {
  const kinds = data.byKind
    .filter((k) => k.count > 0)
    .sort((a, b) => b.savingsUsd - a.savingsUsd || b.count - a.count);
  return (
    <div className="habit-kinds" role="group" aria-label="Filtrar por tipo">
      <button type="button" className="ui-chip habit-kind" aria-pressed={kind === null} onClick={() => onKind(null)}>
        Todos
      </button>
      {kinds.map((k) => {
        const on = kind === k.kind;
        return (
          <button
            key={k.kind}
            type="button"
            className="ui-chip habit-kind"
            aria-pressed={on}
            onClick={() => onKind(on ? null : k.kind)}
          >
            {HABIT_KIND_LABEL[k.kind]}
            <span className="num habit-kind-count">{k.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Lista de hallazgos: una fila abierta a la vez y los primeros HABITS_PAGE hasta "Ver N más" */
function FindingList({ findings, showKind }: { findings: HabitFinding[]; showKind: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const visible = all ? findings : findings.slice(0, HABITS_PAGE);
  const rest = findings.length - visible.length;
  return (
    <div className="habit-block">
      <ul className="habit-list" aria-label="Hallazgos">
        {visible.map((f, i) => (
          <FindingItem
            key={f.id}
            finding={f}
            showKind={showKind}
            open={openId === f.id}
            onToggle={() => setOpenId((id) => (id === f.id ? null : f.id))}
            delay={i < HABITS_PAGE ? rowEnterDelay(i) : 0}
          />
        ))}
      </ul>
      {rest > 0 ? (
        <button type="button" className="btn btn--sm habit-more" onClick={() => setAll(true)}>
          Ver {rest} más
        </button>
      ) : null}
    </div>
  );
}

function FindingItem({
  finding,
  showKind,
  open,
  onToggle,
  delay,
}: {
  finding: HabitFinding;
  showKind: boolean;
  open: boolean;
  onToggle: () => void;
  delay: number;
}) {
  const bodyId = useId();
  const saving = formatSavings(finding.savingsUsd);
  const severity = SEVERITY_LABEL[finding.severity];
  return (
    <li className={`habit is-${finding.severity} row-in`} style={{ animationDelay: `${delay}ms` }}>
      <button type="button" className="habit-row" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="habit-sev" title={severity}>
          <Led
            color={SEVERITY_COLOR[finding.severity]}
            mode={finding.live && finding.severity === 'critical' ? 'blink' : 'steady'}
          />
          <span className="sr-only">{severity}: </span>
        </span>
        <span className="habit-main">
          <span className="habit-title">{finding.title}</span>
          <span className="habit-meta ui-muted">
            {findingWhere(finding)}
            {finding.live ? <span className="habit-live"> · en vivo</span> : null}
            {showKind ? ` · ${HABIT_KIND_LABEL[finding.kind]}` : null}
            {/* solo en rangos historicos: en vivo el server ya no manda lo descartado */}
            {finding.dismissed ? (
              <>
                {' · '}
                <span className="habit-sent" title="Ya se copió al chat de Claude Code desde la bandeja">
                  Enviada
                </span>
              </>
            ) : null}
          </span>
        </span>
        {saving ? <span className="habit-save num">{saving}</span> : null}
      </button>
      {open ? (
        <div id={bodyId} className="habit-body">
          <p className="habit-rec">{finding.recommendation}</p>
          <Evidence finding={finding} />
          <div className="habit-foot">
            <CopyInstruction text={finding.copyText} />
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Evidence({ finding }: { finding: HabitFinding }) {
  if (finding.evidence.length === 0) return null;
  const shown = finding.evidence.slice(0, EVIDENCE_MAX);
  const hidden = finding.evidence.slice(EVIDENCE_MAX);
  return (
    <ul className="habit-evidence" aria-label="Evidencia">
      {shown.map((e) => (
        <li key={e.label} className="ui-chip ui-chip--muted ev-chip" title={e.estimated ? 'Estimado por el tamaño del texto' : undefined}>
          {e.label}
          <b className="num">{formatEvidence(e)}</b>
        </li>
      ))}
      {hidden.length > 0 ? (
        <li
          className="ui-chip ui-chip--muted ev-chip"
          title={hidden.map((e) => `${e.label}: ${formatEvidence(e)}`).join(' · ')}
        >
          +{hidden.length}
        </li>
      ) : null}
    </ul>
  );
}

/** Copia la instruccion para pegarla en Claude Code; confirma 2,5 s o la muestra si el navegador no dejo */
export function CopyInstruction({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state !== 'copied') return;
    const t = window.setTimeout(() => setState('idle'), 2_500);
    return () => window.clearTimeout(t);
  }, [state]);

  const copy = async () => {
    setState((await copyText(text)) ? 'copied' : 'failed');
  };

  return (
    <>
      <button type="button" className={`btn btn--sm ${state === 'copied' ? 'is-copied' : ''}`} onClick={() => void copy()}>
        {state === 'copied' ? (
          <Check size={12} strokeWidth={STROKE} aria-hidden />
        ) : (
          <ClipboardCopy size={12} strokeWidth={STROKE} aria-hidden />
        )}
        {state === 'copied' ? 'Copiada' : 'Copiar instrucción'}
      </button>
      <span className="ui-hint" role="status">
        {state === 'copied' ? 'Pégala en el chat de Claude Code.' : ''}
      </span>
      {state === 'failed' ? (
        <p className="habit-copy-manual" role="alert">
          El navegador no dejó copiar. Cópiala a mano:
          <code>{text}</code>
        </p>
      ) : null}
    </>
  );
}
