import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ArrowDown, X } from 'lucide-react';
import type { TaskOutcome, TaskRow } from '@shared/contract';
import { formatClock, formatTimeOfDay, formatTokens, formatUsd, formatUsdOrUnpriced, formatWeekdayDateLong } from '@/lib/format';
import { flattenTaskPages, groupTasksByDay, type TaskGroup } from '@/lib/history';
import { rowEnterDelay } from '@/lib/motion';
import { describeApiError, useBudget, useTasks, type TaskQuery } from '@/state/api';
import { currentMonth } from '@/lib/history';
import { useOfficeStore } from '@/state/store';
import { AgentSprite } from './PixelArt';
import { PanelState, SkeletonBlock, STROKE } from './primitives';
import { SpendToggle } from './RankingTab';
import './insights.css';
import './extras/extras.css';

export const OUTCOME_LABEL: Record<TaskOutcome, string> = {
  ok: 'Terminó',
  failed: 'Falló',
  killed: 'Detenido',
  stopped: 'Detenido',
  retry: 'Reintento',
  interrupted: 'Interrumpido',
};

const EMPTY_FILTERS: TaskQuery = { q: '', project: '', kind: '', outcome: '', minUsd: '', range: '' };

export function hasTaskFilters(f: TaskQuery): boolean {
  return Object.values(f).some((v) => typeof v === 'string' && v.trim() !== '');
}

/**
 * Buscador y filtros de las tareas: texto, proyecto, quien, como termino, costo minimo y periodo. `end` (el boton
 * de gasto) va en la misma tira, pegado a la derecha: asi todo cabe en dos filas y no queda un boton suelto abajo.
 */
function TaskFilters({ value, onChange, end }: { value: TaskQuery; onChange: (next: TaskQuery) => void; end?: ReactNode }) {
  // el texto se manda al dejar de escribir, no en cada tecla
  const [text, setText] = useState(value.q ?? '');
  useEffect(() => {
    const id = window.setTimeout(() => {
      if ((value.q ?? '') !== text) onChange({ ...value, q: text });
    }, 250);
    return () => window.clearTimeout(id);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const projects = useBudget(currentMonth(Date.now())).data?.projects ?? [];
  const set = (patch: Partial<TaskQuery>) => onChange({ ...value, ...patch });
  const dirty = hasTaskFilters(value) || text.trim() !== '';
  return (
    <div className="x-filters" role="search" aria-label="Filtrar tareas">
      <input
        type="search"
        className="ins-input"
        placeholder="Buscar tarea, agente, sala…"
        aria-label="Buscar tarea, agente, sala o proyecto"
        title="Buscar tarea, agente, sala o proyecto"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <select className="ins-input" aria-label="Proyecto" value={value.project ?? ''} onChange={(e) => set({ project: e.target.value })}>
        <option value="">Todos los proyectos</option>
        {projects.map((p) => (
          <option key={p.project} value={p.project}>
            {p.project}
          </option>
        ))}
      </select>
      <select className="ins-input" aria-label="Quién" value={value.kind ?? ''} onChange={(e) => set({ kind: e.target.value as TaskQuery['kind'] })}>
        <option value="">Líder y subagentes</option>
        <option value="lead">Solo el líder</option>
        <option value="subagent">Solo subagentes</option>
      </select>
      <select className="ins-input" aria-label="Cómo terminó" value={value.outcome ?? ''} onChange={(e) => set({ outcome: e.target.value })}>
        <option value="">Cualquier final</option>
        <option value="bad">Con problema</option>
        <option value="failed">Falló</option>
        <option value="killed">Detenido</option>
        <option value="retry">Reintento</option>
        <option value="interrupted">Interrumpido</option>
        <option value="ok">Terminó bien</option>
      </select>
      <select className="ins-input" aria-label="Costo mínimo" value={value.minUsd ?? ''} onChange={(e) => set({ minUsd: e.target.value })}>
        <option value="">Cualquier costo</option>
        <option value="1">Desde $1</option>
        <option value="5">Desde $5</option>
        <option value="20">Desde $20</option>
        <option value="50">Desde $50</option>
      </select>
      <select className="ins-input" aria-label="Periodo" value={value.range ?? ''} onChange={(e) => set({ range: e.target.value as TaskQuery['range'] })}>
        <option value="">Todo el historial</option>
        <option value="today">Hoy</option>
        <option value="week">Semana</option>
        <option value="month">Mes</option>
      </select>
      {dirty ? (
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            setText('');
            onChange(EMPTY_FILTERS);
          }}
        >
          <X size={12} strokeWidth={STROKE} aria-hidden /> Limpiar
        </button>
      ) : null}
      {end ? <div className="ml-auto flex">{end}</div> : null}
    </div>
  );
}

export function TasksTab() {
  const [filters, setFilters] = useState<TaskQuery>(EMPTY_FILTERS);
  const filtered = hasTaskFilters(filters);
  const query = useTasks(true, filters);
  // la misma preferencia recordada del ranking: tokens y USD ocultos por defecto (la pantalla se proyecta)
  const showSpend = useOfficeStore((s) => s.showSpend);
  const toggleSpend = useOfficeStore((s) => s.toggleSpend);
  const pages = query.data?.pages;
  const items = useMemo(() => flattenTaskPages(pages ?? []), [pages]);
  const groups = useMemo(() => groupTasksByDay(items, Date.now()), [items]);

  const summary = query.data?.pages[0]?.summary;

  if (query.isPending) return <SkeletonBlock rows={7} height={40} />;

  if (query.isError && items.length === 0) {
    return (
      <PanelState
        kind="error"
        title="No se pudieron cargar las tareas"
        text={describeApiError(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }

  if (items.length === 0 && !filtered) {
    return (
      <PanelState
        kind="empty"
        title="Todavía no hay tareas terminadas"
        text="Aparecen aquí al terminar, agrupadas por día."
      />
    );
  }

  const rowClass = `ui-row task-row ${showSpend ? '' : 'task-row--private'}`;
  let row = 0;
  return (
    <>
      <TaskFilters value={filters} onChange={setFilters} end={<SpendToggle shown={showSpend} onToggle={toggleSpend} />} />
      {filtered && summary ? (
        <p className="ui-hint" role="status">
          {summary.count} {summary.count === 1 ? 'tarea cumple' : 'tareas cumplen'} los filtros
          {showSpend ? ` · ${formatUsd(summary.costUsd)}` : ''}
        </p>
      ) : null}
      {items.length === 0 ? (
        <PanelState kind="empty" title="Ninguna tarea cumple los filtros" text="Quita alguno o amplía el periodo." />
      ) : null}
      <div className="flex flex-col gap-6" style={{ opacity: query.isPlaceholderData ? 0.5 : 1 }}>
        {groups.map((group, g) => (
          <section key={group.key} className="ui-rows" aria-label={`Tareas de ${group.label}`}>
            <DayHead group={group} showSpend={showSpend} />
            {g === 0 ? (
              <div className={`${rowClass} ui-row--head`} aria-hidden>
                <span>Agente</span>
                <span>Tarea</span>
                <span>Sala · proyecto</span>
                <span className="text-right">Duración</span>
                {showSpend && (
                  <>
                    <span className="text-right">Tokens</span>
                    <span className="text-right">USD</span>
                  </>
                )}
              </div>
            ) : null}
            <ul className="m-0 list-none p-0">
              {group.items.map((task) => (
                <TaskItem key={task.id} task={task} rowClass={rowClass} showSpend={showSpend} delay={rowEnterDelay(row++)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {items.length === 0 ? null : query.hasNextPage ? (
        <button
          type="button"
          className="btn btn--block"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          <ArrowDown size={14} strokeWidth={STROKE} aria-hidden />
          {query.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
        </button>
      ) : (
        <span className="ui-hint self-center">No hay más tareas</span>
      )}
    </>
  );
}

function DayHead({ group, showSpend }: { group: TaskGroup; showSpend: boolean }) {
  const first = group.items[0];
  const endedMs = first ? Date.parse(first.endedAt) : Number.NaN;
  const date = Number.isNaN(endedMs) ? '' : formatWeekdayDateLong(endedMs);
  const count = group.items.length;
  return (
    <div className="day-head">
      <span className="ui-section-title">
        {group.label}
        {date && date !== group.label ? <span className="day-date">{date}</span> : null}
      </span>
      <span className="day-total">
        {count} {count === 1 ? 'tarea' : 'tareas'}
        {showSpend ? ` · ${formatUsd(group.costUsd)}` : ''}
      </span>
    </div>
  );
}

function TaskItem({
  task,
  rowClass,
  showSpend,
  delay,
}: {
  task: TaskRow;
  rowClass: string;
  showSpend: boolean;
  delay: number;
}) {
  const where = task.roomTitle === task.projectName ? task.roomTitle : `${task.roomTitle} · ${task.projectName}`;
  return (
    <li className={`${rowClass} row-in`} style={{ animationDelay: `${delay}ms` }}>
      <span className="task-agent">
        <AgentSprite agentType={task.agentType} size={24} />
        <span title={task.kind === 'lead' ? 'lead' : task.agentType}>{task.displayName}</span>
      </span>
      <span className="task-name" title={task.title}>
        {task.outcome && task.outcome !== 'ok' ? (
          <span className={`ui-chip ${task.outcome === 'retry' || task.outcome === 'interrupted' ? 'ui-chip--warn' : 'ui-chip--error'}`} style={{ marginRight: 6 }}>
            {OUTCOME_LABEL[task.outcome]}
          </span>
        ) : null}
        {task.title}
      </span>
      <span className="task-where" title={`${where} · terminó ${formatTimeOfDay(task.endedAt)}`}>
        {where}
      </span>
      <span className="cell-num">
        <span className="sr-only">Duración </span>
        {formatClock(task.durationMs)}
      </span>
      {showSpend && (
        <>
          <span className="cell-num">
            <span className="sr-only">Tokens </span>
            {formatTokens(task.tokens.total)}
          </span>
          <span className={`cell-num cell-num--usd ${task.costUsd === null ? 'cell-num--unpriced' : ''}`}>
            <span className="sr-only">Costo </span>
            {formatUsdOrUnpriced(task.costUsd)}
          </span>
        </>
      )}
    </li>
  );
}
