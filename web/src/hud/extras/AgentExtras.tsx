import { useMemo, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import type { AgentActionRow, OfficeAgent } from '@shared/contract';
import { contextTone, nextCall } from '@/lib/context';
import { formatClock, formatTimeOfDay, formatTokens, formatUsd } from '@/lib/format';
import { useAgentActions } from '@/state/api';
import { useOfficeStore } from '@/state/store';
import { STROKE, ToolIcon } from '../primitives';
import { useNow } from '../useNow';
import './extras.css';

const DENIED_LABEL: Record<string, string> = {
  'user-rejected': 'la rechazaste',
  'permission-rule': 'bloqueada por una regla de permisos',
  'automode-blocked': 'bloqueada por el modo automático',
  interrupted: 'interrumpida',
};

/** Contexto actual del agente y el piso de lo que cuesta su proxima llamada */
export function ContextSection({ agent }: { agent: OfficeAgent }) {
  const showSpend = useOfficeStore((s) => s.showSpend);
  const now = useNow(5_000);
  const next = nextCall(agent.context, now);
  if (!next) return null;
  const tone = contextTone(next.tokens);
  const left = next.warm ? `caché viva ${formatClock(next.leftMs)} más` : 'caché vencida';
  return (
    <section className="drawer-sec" aria-label="Contexto">
      <div className="sec-head">
        <span className="label">Contexto</span>
        <span className={`sec-aside ${next.warm ? '' : 'x-warn'}`}>{left}</span>
      </div>
      <dl className="x-kv m-0">
        <dt>Tamaño de la última llamada</dt>
        <dd className={tone === 'high' ? 'x-error' : tone === 'warn' ? 'x-warn' : ''}>{formatTokens(next.tokens)} tok</dd>
        {showSpend && next.usd !== null ? (
          <>
            <dt>{next.warm ? 'Próxima llamada, solo por releerlo' : 'Próxima llamada, con la caché vencida'}</dt>
            <dd className={next.warm ? '' : 'x-warn'}>≥ {formatUsd(next.usd)}</dd>
            {next.warm && next.coldUsd !== null ? (
              <>
                <dt>Si la caché se vence antes</dt>
                <dd>≥ {formatUsd(next.coldUsd)}</dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
      {tone !== 'ok' ? (
        <p className="x-small m-0">
          Contexto grande: cada llamada lo vuelve a pagar. {agent.kind === 'lead' ? 'Compactar (/compact) o empezar una sesión nueva lo baja.' : 'Encargos más cortos por agente lo bajan.'}
        </p>
      ) : null}
    </section>
  );
}

function actionState(a: AgentActionRow): { cls: string; text: string } {
  if (a.denied) return { cls: 'is-denied', text: DENIED_LABEL[a.denied] ?? a.denied };
  if (a.isError) return { cls: 'is-error', text: 'falló' };
  if (a.endedAt === null) return { cls: 'is-open', text: 'en curso' };
  return { cls: '', text: 'terminó' };
}

/** Linea de tiempo: cada accion del agente con su hora, su duracion y si fallo. Plegada por defecto */
export function ActionsTimeline({ agentId, live }: { agentId: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="drawer-sec" aria-label="Acciones">
      <div className="sec-head">
        <span className="label">Acciones</span>
        <button type="button" className="btn btn--sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Ocultar' : 'Ver línea de tiempo'}
        </button>
      </div>
      {open ? <TimelineBody agentId={agentId} live={live} /> : null}
    </section>
  );
}

/** se monta solo con el plegable abierto: ahi empieza a pedir datos */
function TimelineBody({ agentId, live }: { agentId: string; live: boolean }) {
  const query = useAgentActions(agentId, { enabled: true, live });
  const pages = query.data?.pages;
  const items = useMemo(() => (pages ?? []).flatMap((p) => p.items), [pages]);
  const summary = pages?.[0]?.summary;
  return (
    <>
      {
        query.isPending ? (
          <p className="x-small m-0">Cargando…</p>
        ) : items.length === 0 ? (
          <p className="x-small m-0">Todavía no usó ninguna herramienta.</p>
        ) : (
          <>
            {summary ? (
              <p className="x-small m-0">
                {summary.actions} acciones · {summary.filesEdited} {summary.filesEdited === 1 ? 'archivo editado' : 'archivos editados'}
                {summary.errors > 0 ? <span className="x-error"> · {summary.errors} con error</span> : null}
                {summary.denied > 0 ? <span className="x-warn"> · {summary.denied} bloqueadas</span> : null}
                {summary.resultChars > 0 ? ` · ≈ ${formatTokens(Math.ceil(summary.resultChars / 4))} tok de resultados` : ''}
              </p>
            ) : null}
            <ol className="ui-rows x-scroll">
              {items.map((a) => {
                const state = actionState(a);
                return (
                  <li key={a.id} className="ui-row x-row-action" title={`${a.tool} · ${state.text}`}>
                    <span className="x-mono x-muted">{formatTimeOfDay(a.startedAt)}</span>
                    <ToolIcon tool={a.tool} size={12} />
                    <span className={`x-ellipsis x-small ${a.isError ? 'x-error' : a.denied ? 'x-warn' : ''}`}>{a.label}</span>
                    <span className="cell-num">{a.durationMs === null ? '…' : formatClock(a.durationMs)}</span>
                  </li>
                );
              })}
            </ol>
            {query.hasNextPage ? (
              <button type="button" className="btn btn--sm btn--block" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                <ArrowDown size={12} strokeWidth={STROKE} aria-hidden />
                {query.isFetchingNextPage ? 'Cargando…' : 'Acciones anteriores'}
              </button>
            ) : null}
          </>
        )
      }
    </>
  );
}
