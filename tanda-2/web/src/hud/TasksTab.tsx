import { useMemo } from 'react';
import { ArrowDown } from 'lucide-react';
import type { TaskRow } from '@shared/contract';
import { formatClock, formatTimeOfDay, formatTokens, formatUsd, formatUsdOrUnpriced, formatWeekdayDateLong } from '@/lib/format';
import { flattenTaskPages, groupTasksByDay, type TaskGroup } from '@/lib/history';
import { rowEnterDelay } from '@/lib/motion';
import { describeApiError, useTasks } from '@/state/api';
import { useOfficeStore } from '@/state/store';
import { AgentSprite } from './PixelArt';
import { PanelState, SkeletonBlock, STROKE } from './primitives';
import { SpendToggle } from './RankingTab';
import './insights.css';

export function TasksTab() {
  const query = useTasks();
  // la misma preferencia recordada del ranking: tokens y USD ocultos por defecto (la pantalla se proyecta)
  const showSpend = useOfficeStore((s) => s.showSpend);
  const toggleSpend = useOfficeStore((s) => s.toggleSpend);
  const pages = query.data?.pages;
  const items = useMemo(() => flattenTaskPages(pages ?? []), [pages]);
  const groups = useMemo(() => groupTasksByDay(items, Date.now()), [items]);

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

  if (items.length === 0) {
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
      <div className="ins-top justify-end">
        <SpendToggle shown={showSpend} onToggle={toggleSpend} />
      </div>
      <div className="flex flex-col gap-6">
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
      {query.hasNextPage ? (
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
