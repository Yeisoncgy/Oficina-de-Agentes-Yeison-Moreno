import { useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import {
  Bot,
  Check,
  CircleAlert,
  CircleStop,
  FilePlus,
  FileText,
  Globe,
  Inbox,
  ListChecks,
  Pause,
  Pencil,
  RefreshCw,
  Search,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { AgentStatus, WorkflowStatus } from '@shared/contract';
import type { BudgetTone } from '@/lib/history';
import { modelFamily, modelLabel } from '@/lib/models';
import { STATUS_LABEL, toolKind, type ToolKind } from '@/lib/office';
import { phaseDelay } from '@/lib/motion';
import { RUN_STATUS_LABEL } from '@/lib/workflows';
import { DURATION, STATE, UI } from '@/theme';

/** Lucide siempre con trazo de 1,5 px */
export const STROKE = 1.5;

export const TONE_COLOR: Record<BudgetTone, string> = {
  ok: UI.accent,
  warn: STATE.warning,
  over: STATE.error,
};

const TOOL_ICON: Record<ToolKind, LucideIcon> = {
  read: FileText,
  edit: Pencil,
  write: FilePlus,
  shell: Terminal,
  search: Search,
  agent: Bot,
  web: Globe,
  todo: ListChecks,
  other: Wrench,
};

export function ToolIcon({ tool, size = 12 }: { tool: string; size?: number }) {
  const Icon = TOOL_ICON[toolKind(tool)];
  return <Icon size={size} strokeWidth={STROKE} aria-hidden />;
}

export function IconButton({
  label,
  children,
  className = '',
  ...rest
}: { label: string; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'>) {
  return (
    <button type="button" aria-label={label} title={label} className={`icon-btn ${className}`} {...rest}>
      {children}
    </button>
  );
}

/**
 * LED cuadrado de 8 px. 'blink' late en dos pasos y en fase con todos los demas; 'ring' es el pulso
 * de la barra superior.
 */
export function Led({
  color,
  mode = 'steady',
  hollow = false,
  className = '',
}: {
  color?: string;
  mode?: 'steady' | 'blink' | 'ring';
  hollow?: boolean;
  className?: string;
}) {
  // se fija al montar: el retardo negativo alinea el latido con el reloj del documento
  const [delay] = useState(() => phaseDelay(DURATION.liveDot, performance.now()));
  const style: CSSProperties = {};
  if (color) style.color = color;
  if (mode === 'blink') style.animationDelay = delay;
  const cls = ['led', mode === 'blink' ? 'led--blink' : '', mode === 'ring' ? 'led--ring' : '', hollow ? 'led--hollow' : ''];
  return <span aria-hidden className={`${cls.join(' ')} ${className}`} style={style} />;
}

/** Estado del agente: LED + icono + etiqueta; el color nunca va solo (D2) */
export function StatusChip({ status }: { status: AgentStatus }) {
  return (
    <span className={`status-chip is-${status}`}>
      {status === 'working' ? (
        <Led mode="blink" />
      ) : status === 'idle' ? (
        <Pause size={12} strokeWidth={STROKE} aria-hidden />
      ) : (
        <Check size={12} strokeWidth={STROKE} aria-hidden />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Chip de modelo: "Opus 5.5" con la marca de su familia; el id completo queda en el tooltip */
export function ModelChip({ model, className = '' }: { model: string | null; className?: string }) {
  return (
    <span
      className={`model-chip ${model ? '' : 'is-empty'} ${className}`}
      data-family={modelFamily(model)}
      title={model ? `Modelo: ${model}` : 'Modelo sin reportar'}
    >
      {modelLabel(model)}
    </span>
  );
}

/** Estado de una corrida del tool Workflow: LED + icono + etiqueta */
export function RunStatusChip({ status }: { status: WorkflowStatus }) {
  return (
    <span className={`status-chip is-run-${status}`}>
      {status === 'running' ? (
        <Led mode="blink" />
      ) : status === 'done' ? (
        <Check size={12} strokeWidth={STROKE} aria-hidden />
      ) : status === 'failed' ? (
        <X size={12} strokeWidth={STROKE} aria-hidden />
      ) : (
        <CircleStop size={12} strokeWidth={STROKE} aria-hidden />
      )}
      {RUN_STATUS_LABEL[status]}
    </span>
  );
}

export function ThinkingDots() {
  return (
    <span aria-hidden className="thinking-dots">
      <span />
      <span />
      <span />
    </span>
  );
}

export function RetryButton({ onClick, label = 'Reintentar' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="btn btn--sm" onClick={onClick}>
      <RefreshCw size={12} strokeWidth={STROKE} aria-hidden />
      {label}
    </button>
  );
}

/** Estado de un panel: vacio o error, con accion opcional (cada panel falla por separado) */
export function PanelState({
  kind,
  title,
  text,
  onRetry,
  extra,
}: {
  kind: 'empty' | 'error';
  title: string;
  text?: ReactNode;
  onRetry?: () => void;
  extra?: ReactNode;
}) {
  const Icon = kind === 'error' ? CircleAlert : Inbox;
  return (
    <div className={`panel-state ${kind === 'error' ? 'is-error' : ''}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="panel-state-icon">
        <Icon size={20} strokeWidth={STROKE} aria-hidden />
      </span>
      <p className="panel-state-title">{title}</p>
      {text ? <p className="panel-state-text">{text}</p> : null}
      {onRetry || extra ? (
        <div className="panel-state-actions">
          {onRetry ? <RetryButton onClick={onRetry} /> : null}
          {extra}
        </div>
      ) : null}
    </div>
  );
}

/** Lineas de carga; los anchos imitan el texto que va a llegar */
export function SkeletonLines({ widths, height = 10, gap = 8 }: { widths: string[]; height?: number; gap?: number }) {
  return (
    <span aria-hidden style={{ display: 'flex', flexDirection: 'column', gap }}>
      {widths.map((w, i) => (
        <span key={i} className="skel" style={{ width: w, height }} />
      ))}
    </span>
  );
}

export function SkeletonBlock({ rows, height = 40 }: { rows: number; height?: number }) {
  return (
    <div role="status" aria-label="Cargando" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skel" style={{ height, opacity: 1 - i * (0.6 / Math.max(1, rows)) }} />
      ))}
    </div>
  );
}
