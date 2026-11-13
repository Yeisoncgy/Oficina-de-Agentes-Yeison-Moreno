import { useState } from 'react';
import { Power, TriangleAlert } from 'lucide-react';
import { formatDayMonth, formatDuration, formatTimeOfDay, formatTokens } from '@/lib/format';
import { describeApiError, useIngestHealth, useRules, useSetSystem, useShutdown } from '@/state/api';
import { PanelState, SkeletonBlock, STROKE } from './primitives';
import { Switch } from './RulesTab';
import './extras/extras.css';

const BACKFILL: Record<string, string> = {
  pendiente: 'Por empezar',
  'en curso': 'Leyendo el historial',
  listo: 'Al día',
  error: 'Con error',
};

const when = (iso: string | null): string => (iso ? `${formatDayMonth(iso)} ${formatTimeOfDay(iso, true)}` : '—');

function megabytes(bytes: number | null): string {
  return bytes === null ? '—' : `${(bytes / 1_048_576).toFixed(1).replace('.', ',')} MB`;
}

/** Avisos del sistema, servidor en segundo plano, salud de la lectura y apagado */
export function SystemTab() {
  const rules = useRules();
  const health = useIngestHealth();
  const system = useSetSystem();
  const shutdown = useShutdown();
  const [confirm, setConfirm] = useState(false);
  const h = health.data;

  if (rules.isPending || health.isPending) return <SkeletonBlock rows={5} height={56} />;
  if (health.isError && !h) {
    return (
      <PanelState
        kind="error"
        title="No se pudo leer el estado del servidor"
        text={describeApiError(health.error)}
        onRetry={() => void health.refetch()}
      />
    );
  }

  const notifyDesktop = rules.data?.notifyDesktop ?? true;
  const keepAlive = rules.data?.keepAlive ?? false;
  const unknown = h?.unknownTypes ?? [];

  return (
    <div className="flex flex-col gap-7">
      <section className="ui-section row-in" aria-label="Avisos y segundo plano">
        <h4 className="ui-section-title">Avisos sin tener la pestaña abierta</h4>
        <div>
          <div className="x-switch">
            <span className="x-switch-name">Avisos del sistema</span>
            <span className="x-switch-hint">
              Notificación de escritorio al cruzar el 50, 75, 90 y 100 % del presupuesto, cuando la proyección lo pasa y
              cuando un proyecto pasa su tope. Sin pestañas abiertas, también las alertas rojas y los agentes que esperan
              tu respuesta.
            </span>
            <Switch
              checked={notifyDesktop}
              label="Avisos del sistema"
              states={['Encendidos', 'Apagados']}
              disabled={system.isPending}
              onChange={(v) => system.mutate({ notifyDesktop: v })}
            />
          </div>
          <div className="x-switch">
            <span className="x-switch-name">Seguir vigilando sin pestañas</span>
            <span className="x-switch-hint">
              El servidor no se apaga solo al cerrar la última pestaña: sigue leyendo y avisando. Para apagarlo usa el
              botón de abajo.
            </span>
            <Switch
              checked={keepAlive}
              label="Seguir vigilando sin pestañas"
              states={['Encendido', 'Apagado']}
              disabled={system.isPending}
              onChange={(v) => system.mutate({ keepAlive: v })}
            />
          </div>
        </div>
        {system.isError ? (
          <span className="inline-error" role="alert">
            {describeApiError(system.error)}
          </span>
        ) : null}
      </section>

      {h ? (
        <section className="ui-section row-in" aria-label="Salud de la lectura">
          <div className="ui-section-head">
            <h4 className="ui-section-title">Salud de la lectura</h4>
            <span className={`ui-chip ${h.backfill === 'listo' ? 'ui-chip--ok' : h.backfill === 'error' ? 'ui-chip--error' : 'ui-chip--info'}`}>
              {BACKFILL[h.backfill] ?? h.backfill}
            </span>
          </div>
          <div className="ui-stats">
            <div className="ui-stat">
              <span className="ui-stat-label">Última línea leída</span>
              <span className="ui-stat-value">{when(h.lastLineAt ?? h.lastUsageAt)}</span>
              <span className="ui-stat-sub">
                {h.pending > 0 ? `${h.pending} archivos en cola` : 'sin archivos en cola'}
              </span>
            </div>
            <div className="ui-stat">
              <span className="ui-stat-label">Archivos seguidos</span>
              <span className="ui-stat-value">{formatTokens(h.filesTracked)}</span>
              <span className="ui-stat-sub">
                {h.backfill === 'en curso' ? `${h.filesDone} de ${h.filesTotal} revisados` : `${formatTokens(h.linesRead)} líneas desde el arranque`}
              </span>
            </div>
            <div className="ui-stat">
              <span className="ui-stat-label">Historial guardado</span>
              <span className="ui-stat-value">{formatTokens(h.usageRows)}</span>
              <span className="ui-stat-sub">
                llamadas desde el {h.firstUsageAt ? formatDayMonth(h.firstUsageAt) : '—'} · {megabytes(h.dbBytes)}
              </span>
            </div>
            <div className={`ui-stat ${h.badLines > 0 || unknown.length > 0 ? 'ui-stat--warn' : ''}`}>
              <span className="ui-stat-label">Sin entender</span>
              <span className="ui-stat-value">{h.badLines + unknown.reduce((n, u) => n + u.count, 0)}</span>
              <span className="ui-stat-sub">líneas desde el arranque</span>
            </div>
          </div>
          {unknown.length > 0 ? (
            <p className="warn" role="note">
              <TriangleAlert size={16} strokeWidth={STROKE} aria-hidden />
              <span>
                Claude Code está escribiendo tipos de línea que Colmena no conoce: {unknown.map((u) => `${u.type} (${u.count})`).join(', ')}.
                No rompe nada, pero puede haber datos nuevos que no se están leyendo.
              </span>
            </p>
          ) : (
            <p className="ui-hint">Todo lo que escribe Claude Code se está entendiendo. Servidor encendido hace {formatDuration(h.uptimeMs)}.</p>
          )}
        </section>
      ) : null}

      {h?.canShutdown ? (
        <section className="ui-section row-in" aria-label="Apagar">
          <h4 className="ui-section-title">Apagar Colmena</h4>
          {shutdown.isSuccess ? (
            <p className="ui-hint">Servidor apagado. Para volver, abre Colmena de nuevo.</p>
          ) : confirm ? (
            <div className="x-filters">
              <span className="x-small">Se detiene la lectura y los avisos hasta que la abras otra vez.</span>
              <button type="button" className="btn btn--sm btn--primary" onClick={() => shutdown.mutate()} disabled={shutdown.isPending}>
                <Power size={12} strokeWidth={STROKE} aria-hidden /> Apagar ahora
              </button>
              <button type="button" className="btn btn--sm" onClick={() => setConfirm(false)}>
                Cancelar
              </button>
            </div>
          ) : (
            <div className="x-filters">
              <button type="button" className="btn btn--sm" onClick={() => setConfirm(true)}>
                <Power size={12} strokeWidth={STROKE} aria-hidden /> Apagar el servidor
              </button>
              <span className="ui-hint">No borra nada: el historial queda guardado.</span>
            </div>
          )}
          {shutdown.isError ? (
            <span className="inline-error" role="alert">
              {describeApiError(shutdown.error)}
            </span>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
