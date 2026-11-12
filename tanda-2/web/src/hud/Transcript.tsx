import { useMemo, useRef, useState } from 'react';
import { ChevronRight, CircleAlert, CornerDownRight, History, MessageSquare, TextAlignStart, TriangleAlert } from 'lucide-react';
import { formatTimeOfDay } from '@/lib/format';
import {
  currentToolId,
  mergeTranscriptPages,
  resultSummary,
  toTranscriptItems,
  TRANSCRIPT_LABEL,
  type TranscriptItem,
} from '@/lib/transcript';
import { describeApiError, useTranscript } from '@/state/api';
import { useOfficeStore } from '@/state/store';
import { PanelState, SkeletonLines, STROKE, ToolIcon } from './primitives';

/**
 * Transcript del agente (D3), lo mas reciente arriba: al abrir el panel se ve lo ultimo que hizo, y
 * "Cargar anteriores" queda al pie. Si el usuario bajo a leer, el navegador ancla el scroll y las
 * entradas nuevas no lo mueven.
 */
export function TranscriptView({ agentId, live }: { agentId: string; live: boolean }) {
  const demo = useOfficeStore((s) => s.demo);
  const query = useTranscript(agentId, { enabled: !demo, live });
  const pages = query.data?.pages;
  const items = useMemo(() => toTranscriptItems(mergeTranscriptPages(pages ?? [])), [pages]);
  const newestFirst = useMemo(() => [...items].reverse(), [items]);
  const currentId = currentToolId(items, live);

  const initialIds = useRef<Set<string> | null>(null);
  if (initialIds.current === null && items.length > 0) initialIds.current = new Set(items.map((i) => i.id));

  const count =
    items.length === 0 ? null : query.hasNextPage ? `últimas ${items.length} entradas` : `${items.length} entradas`;

  let body;
  if (demo) {
    body = (
      <PanelState
        kind="empty"
        title="Sin transcript en modo demo"
        text="Los agentes de la demo son simulados; con el servidor corriendo verás aquí sus mensajes."
      />
    );
  } else if (query.isPending) {
    body = (
      <div className="flex flex-col gap-4 px-4 py-3" role="status" aria-label="Cargando transcript">
        <SkeletonLines widths={['40%', '92%', '70%']} />
        <SkeletonLines widths={['35%', '80%']} />
        <SkeletonLines widths={['45%', '88%', '60%']} />
      </div>
    );
  } else if (query.isError && items.length === 0) {
    body = (
      <PanelState
        kind="error"
        title="No se pudo cargar el transcript"
        text={`${describeApiError(query.error)} Los cronómetros y los tokens siguen al día.`}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (items.length === 0) {
    body = (
      <PanelState
        kind="empty"
        title="Sin entradas todavía"
        text="El transcript aparece en cuanto el agente recibe su prompt."
      />
    );
  } else {
    body = (
      <>
        {query.isError ? (
          <p className="inline-error" role="alert">
            <CircleAlert size={12} strokeWidth={STROKE} aria-hidden />
            {describeApiError(query.error)}
          </p>
        ) : null}
        <ol className="tx-list" role="log" aria-label="Transcript del agente, lo más reciente primero">
          {newestFirst.map((item) => (
            <TranscriptRow
              key={item.id}
              item={item}
              current={item.id === currentId}
              fresh={initialIds.current !== null && !initialIds.current.has(item.id)}
            />
          ))}
        </ol>
        <div className="tx-more">
          {query.hasNextPage ? (
            <button
              type="button"
              className="btn btn--block"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              <History size={14} strokeWidth={STROKE} aria-hidden />
              {query.isFetchingNextPage ? 'Cargando…' : 'Cargar anteriores'}
            </button>
          ) : (
            <span className="tx-edge">Inicio del transcript</span>
          )}
        </div>
      </>
    );
  }

  return (
    <section className="drawer-sec tx-sec" aria-label="Transcript">
      <div className="sec-head">
        <span className="label">Transcript</span>
        {count ? <span className="sec-aside">{count}</span> : null}
      </div>
      {body}
    </section>
  );
}

function RowIcon({ item }: { item: TranscriptItem }) {
  if (item.isError) return <TriangleAlert size={12} strokeWidth={STROKE} aria-hidden />;
  switch (item.kind) {
    case 'prompt':
      return <MessageSquare size={12} strokeWidth={STROKE} aria-hidden />;
    case 'text':
      return <TextAlignStart size={12} strokeWidth={STROKE} aria-hidden />;
    case 'tool_use':
      return <ToolIcon tool={item.toolName ?? ''} />;
    case 'tool_result':
      return <CornerDownRight size={12} strokeWidth={STROKE} aria-hidden />;
  }
}

const KIND_CLASS: Record<TranscriptItem['kind'], string> = {
  prompt: 'tx--prompt',
  text: 'tx--text',
  tool_use: 'tx--tool',
  tool_result: 'tx--result',
};

function TranscriptRow({ item, current, fresh }: { item: TranscriptItem; current: boolean; fresh: boolean }) {
  const cls = ['tx', KIND_CLASS[item.kind], item.isError ? 'tx--error' : '', current ? 'is-current' : '', fresh ? 'is-new' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <li className={cls}>
      <span className="tx-icon">
        <RowIcon item={item} />
      </span>
      <div className="tx-main">
        <div className="tx-meta">
          <span className="tx-kind">{item.isError && item.kind !== 'tool_result' ? 'Error' : TRANSCRIPT_LABEL[item.kind]}</span>
          <time dateTime={item.timestamp}>{formatTimeOfDay(item.timestamp, true)}</time>
        </div>
        <TranscriptBody item={item} current={current} />
      </div>
    </li>
  );
}

function TranscriptBody({ item, current }: { item: TranscriptItem; current: boolean }) {
  const [open, setOpen] = useState(false);

  if (item.kind === 'tool_use') {
    const more = item.lineCount > 1 || item.text.length > item.preview.length;
    return (
      <>
        <div className="tool-line">
          <span className="tool-chip" title={item.toolName ?? undefined}>
            <ToolIcon tool={item.toolName ?? ''} />
            {item.toolName ?? 'Herramienta'}
          </span>
          {item.preview ? (
            <span className="tool-arg" title={item.text}>
              {item.preview}
            </span>
          ) : null}
          {current ? <span className="tool-now">en curso</span> : null}
        </div>
        {more ? (
          <div className="tx-result">
            <button type="button" className="more-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? 'Ver menos' : 'Ver todo'}
            </button>
            {open ? <pre>{item.text}</pre> : null}
          </div>
        ) : null}
      </>
    );
  }

  if (item.kind === 'tool_result') {
    return (
      <div className={`tx-result ${item.isError ? 'is-error' : ''}`}>
        <button
          type="button"
          className="tx-result-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          disabled={item.text === ''}
        >
          <ChevronRight size={12} strokeWidth={STROKE} aria-hidden className="chev" />
          <span>{resultSummary(item)}</span>
        </button>
        {open && item.text !== '' ? <pre>{item.text}</pre> : null}
      </div>
    );
  }

  if (item.text === '') return null;
  const clamped = item.long && !open;
  return (
    <>
      <p className={`tx-text ${clamped ? 'is-clamped' : ''}`}>{item.text}</p>
      {item.long ? (
        <button type="button" className="more-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Ver menos' : 'Ver todo'}
        </button>
      ) : null}
    </>
  );
}
