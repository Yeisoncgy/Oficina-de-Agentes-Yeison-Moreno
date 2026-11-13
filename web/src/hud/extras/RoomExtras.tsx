import { useMemo, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { OfficeRoom } from '@shared/contract';
import { nextCall } from '@/lib/context';
import { formatClock, formatTimeOfDay, formatTokens, formatUsd, formatUsdOrUnpriced } from '@/lib/format';
import { useRoomFiles, useTasks } from '@/state/api';
import { useOfficeStore } from '@/state/store';
import { STROKE } from '../primitives';
import { OUTCOME_LABEL } from '../TasksTab';
import { useNow } from '../useNow';
import './extras.css';

/** Cuanto cuesta el proximo turno del lider solo por el contexto que ya carga la sala */
export function NextTurn({ room }: { room: OfficeRoom }) {
  const now = useNow(5_000);
  const next = nextCall(room.lead.context, now);
  if (!next || next.usd === null) return null;
  return (
    <dl className="x-kv m-0" aria-label="Próximo turno">
      <dt>Contexto del líder</dt>
      <dd>{formatTokens(next.tokens)} tok</dd>
      <dt>{next.warm ? 'Cada llamada nueva, solo por releerlo' : 'Próxima llamada (caché vencida)'}</dt>
      <dd className={next.warm ? '' : 'x-warn'}>≥ {formatUsd(next.usd)}</dd>
    </dl>
  );
}

/** Turnos del lider en la sala: cada pedido tuyo con lo que tardo y lo que costo */
export function RoomTurns({ room }: { room: OfficeRoom }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="drawer-sec" aria-label="Turnos">
      <div className="sec-head">
        <span className="label">Turnos</span>
        <button type="button" className="btn btn--sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Ocultar' : 'Ver cada pedido'}
        </button>
      </div>
      {open ? <TurnsBody room={room} /> : null}
    </section>
  );
}

/** se monta solo con el plegable abierto: ahi empieza a pedir datos */
function TurnsBody({ room }: { room: OfficeRoom }) {
  const showSpend = useOfficeStore((s) => s.showSpend);
  const filters = useMemo(() => ({ room: room.id, kind: 'lead' as const }), [room.id]);
  const query = useTasks(true, filters);
  const pages = query.data?.pages;
  const items = useMemo(() => (pages ?? []).flatMap((p) => p.items), [pages]);
  const summary = pages?.[0]?.summary;
  return (
    <>
      {
        query.isPending ? (
          <p className="x-small m-0">Cargando…</p>
        ) : items.length === 0 ? (
          <p className="x-small m-0">Todavía no hay turnos terminados en esta sala.</p>
        ) : (
          <>
            {summary ? (
              <p className="x-small m-0">
                {summary.count} {summary.count === 1 ? 'turno' : 'turnos'} del líder
                {showSpend ? ` · ${formatUsd(summary.costUsd)} (sin subagentes)` : ''}
              </p>
            ) : null}
            <ol className="ui-rows x-scroll">
              {items.map((t) => (
                <li key={t.id} className="ui-row x-row-turn" title={t.title}>
                  <span className="x-mono x-muted">{formatTimeOfDay(t.endedAt)}</span>
                  <span className="x-ellipsis x-small">
                    {t.outcome && t.outcome !== 'ok' ? <span className="x-warn">{OUTCOME_LABEL[t.outcome]} · </span> : null}
                    {t.title}
                  </span>
                  <span className="cell-num">{formatClock(t.durationMs)}</span>
                  <span className="cell-num cell-num--usd">{showSpend ? formatUsdOrUnpriced(t.costUsd) : '···'}</span>
                </li>
              ))}
            </ol>
            {query.hasNextPage ? (
              <button type="button" className="btn btn--sm btn--block" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                {query.isFetchingNextPage ? 'Cargando…' : 'Turnos anteriores'}
              </button>
            ) : null}
          </>
        )
      }
    </>
  );
}

/** Archivos que tocaron los agentes de la sala; avisa cuando dos editaron el mismo */
export function RoomFiles({ room }: { room: OfficeRoom }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="drawer-sec" aria-label="Archivos">
      <div className="sec-head">
        <span className="label">Archivos</span>
        <button type="button" className="btn btn--sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Ocultar' : 'Ver quién tocó qué'}
        </button>
      </div>
      {open ? <FilesBody room={room} /> : null}
    </section>
  );
}

function FilesBody({ room }: { room: OfficeRoom }) {
  const [onlyEdited, setOnlyEdited] = useState(true);
  const query = useRoomFiles(room.id, { enabled: true, live: room.busy || room.subagents.some((a) => a.status === 'working') });
  const data = query.data;
  const files = (data?.files ?? []).filter((f) => !onlyEdited || f.edits > 0);
  return (
    <>
      {
        query.isPending ? (
          <p className="x-small m-0">Cargando…</p>
        ) : !data || data.files.length === 0 ? (
          <p className="x-small m-0">Nadie ha leído ni editado archivos en esta sala.</p>
        ) : (
          <>
            <div className="x-filters">
              <span className="x-small">
                {data.edited} {data.edited === 1 ? 'editado' : 'editados'}
                {data.conflicts > 0 ? (
                  <span className="x-warn">
                    {' '}
                    · {data.conflicts} {data.conflicts === 1 ? 'tocado por varios agentes' : 'tocados por varios agentes'}
                  </span>
                ) : null}
              </span>
              <button type="button" className="btn btn--sm" aria-pressed={!onlyEdited} onClick={() => setOnlyEdited((v) => !v)}>
                {onlyEdited ? 'Incluir los solo leídos' : 'Solo los editados'}
              </button>
            </div>
            {files.length === 0 ? (
              <p className="x-small m-0">Ningún archivo editado todavía.</p>
            ) : (
              <ol className="ui-rows x-scroll">
                {files.map((f) => {
                  const who = f.agents
                    .filter((a) => (onlyEdited ? a.edits > 0 : true))
                    .map((a) => `${a.name}${a.edits > 0 ? ` ×${a.edits}` : ''}`)
                    .join(', ');
                  return (
                    <li key={f.path} className="ui-row x-row-file" title={`${f.path}\n${f.edits} ediciones · ${f.reads} lecturas`}>
                      <span className="x-ellipsis x-small">
                        {f.conflict ? <TriangleAlert size={12} strokeWidth={STROKE} aria-label="Editado por varios agentes" className="x-warn inline" /> : null}{' '}
                        <span className="x-mono">{f.name}</span>
                      </span>
                      <span className={`x-small ${f.conflict ? 'x-warn' : 'x-muted'}`}>{who}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )
      }
    </>
  );
}
