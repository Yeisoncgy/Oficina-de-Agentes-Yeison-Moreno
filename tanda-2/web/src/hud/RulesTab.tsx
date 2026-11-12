import { useId, useState, type FormEvent } from 'react';
import { Bell, BellOff, Info, RotateCcw, TriangleAlert } from 'lucide-react';
import { RULE_MIN_SAMPLES, type RuleConfig } from '@shared/contract';
import { formatDayMonth, formatTimeOfDay, formatUsd } from '@/lib/format';
import { formatEsInput, parseEsNumber } from '@/lib/history';
import { rowEnterDelay } from '@/lib/motion';
import { describeApiError, useRules, useSetRulesNotify, useUpdateRule } from '@/state/api';
import { RULE_HINT, RULE_SOURCE_LABEL } from './insights/model';
import { PanelState, SkeletonBlock, STROKE } from './primitives';
import './insights.css';

/** mismos limites que valida el server (routes/habits.ts, habits/rules.ts) */
function ruleRange(rule: RuleConfig): { min: number; max: number } {
  if (rule.id === 'loop_repeats') return { min: 2, max: 50 };
  return rule.unit === 'usd' ? { min: 0.01, max: 100_000 } : { min: 1, max: 10_000 };
}

/** Reglas de aviso: umbral calibrado (p90) o propio, encendido y aviso del navegador. Solo avisan. */
export function RulesTab() {
  const query = useRules();
  const data = query.data;

  if (query.isPending) return <SkeletonBlock rows={6} height={64} />;
  if (query.isError && !data) {
    return (
      <PanelState
        kind="error"
        title="No se pudieron cargar las reglas"
        text={describeApiError(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!data) return null;

  return (
    <>
      <div className="ins-top">
        <p className="note">
          <Info size={14} strokeWidth={STROKE} aria-hidden />
          Umbral calibrado = p90 de los últimos {data.windowDays} días, nunca bajo el mínimo · calibrado el{' '}
          {formatDayMonth(data.calibratedAt)} a las {formatTimeOfDay(data.calibratedAt)}
        </p>
        <p className="note">Las reglas solo avisan: la app nunca actúa sobre una sesión.</p>
      </div>
      <NotifyToggle enabled={data.notifyBrowser} />
      <ul className="rule-list" aria-label="Reglas de aviso">
        {data.rules.map((rule, i) => (
          <RuleItem key={rule.id} rule={rule} delay={rowEnterDelay(i)} />
        ))}
      </ul>
    </>
  );
}

function ruleValueText(value: number, unit: RuleConfig['unit']): string {
  return unit === 'usd' ? formatUsd(value) : formatEsInput(value, 'count');
}

function RuleItem({ rule, delay }: { rule: RuleConfig; delay: number }) {
  const inputId = useId();
  const nameId = useId();
  const update = useUpdateRule();
  const saved = formatEsInput(rule.value, rule.unit);
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? saved;
  const dirty = draft !== null && draft.trim() !== saved;
  const raw = parseEsNumber(text);
  // el monto se valida ya redondeado a centavos, como en el server
  const parsed = raw !== null && rule.unit === 'usd' ? Math.round(raw * 100) / 100 : raw;
  const range = ruleRange(rule);
  const valid =
    parsed !== null &&
    parsed >= range.min &&
    parsed <= range.max &&
    (rule.unit === 'usd' || Number.isInteger(parsed));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || !valid || parsed === null) return;
    update.mutate({ id: rule.id, value: parsed }, { onSuccess: () => setDraft(null) });
  };

  const samples = `${rule.samples} ${rule.samples === 1 ? 'muestra' : 'muestras'}`;
  const sourceTitle =
    rule.source === 'floor'
      ? `Menos de ${RULE_MIN_SAMPLES} muestras: se usa el mínimo`
      : rule.source === 'custom'
        ? 'Umbral que fijaste tú'
        : 'Percentil 90 de los últimos días';

  return (
    <li className={`rule row-in ${rule.enabled ? '' : 'is-off'}`} style={{ animationDelay: `${delay}ms` }}>
      <Switch
        checked={rule.enabled}
        labelledBy={nameId}
        disabled={update.isPending}
        onChange={(enabled) => update.mutate({ id: rule.id, enabled })}
      />
      <div className="rule-main">
        <h4 id={nameId} className="rule-name">
          {rule.label}
        </h4>
        <p className="rule-hint">{RULE_HINT[rule.id]}</p>
        <p className="rule-meta">
          <span className={`rule-source is-${rule.source}`} title={sourceTitle}>
            {RULE_SOURCE_LABEL[rule.source]}
          </span>
          <span className="num">{samples}</span>
          {rule.source === 'custom' && rule.calibratedValue !== null ? (
            <span className="num">p90 {ruleValueText(rule.calibratedValue, rule.unit)}</span>
          ) : null}
          <span className="num">mínimo {ruleValueText(rule.floor, rule.unit)}</span>
        </p>
      </div>
      <form className="rule-edit" onSubmit={submit} aria-label={`Umbral de ${rule.label}`}>
        <label htmlFor={inputId} className="sr-only">
          Umbral de {rule.label} {rule.unit === 'usd' ? 'en dólares' : 'en veces'}
        </label>
        {rule.unit === 'usd' ? (
          <span className="num rule-unit" aria-hidden>
            $
          </span>
        ) : null}
        <input
          id={inputId}
          className="num ins-input rule-input"
          inputMode={rule.unit === 'usd' ? 'decimal' : 'numeric'}
          value={text}
          aria-invalid={dirty && !valid}
          onChange={(e) => setDraft(e.target.value)}
        />
        {dirty ? (
          <>
            <button type="submit" className="btn btn--sm btn--primary" disabled={!valid || update.isPending}>
              Guardar
            </button>
            <button type="button" className="btn btn--sm" onClick={() => setDraft(null)}>
              Cancelar
            </button>
          </>
        ) : rule.source === 'custom' ? (
          <button
            type="button"
            className="btn btn--sm"
            disabled={update.isPending}
            onClick={() => update.mutate({ id: rule.id, value: null }, { onSuccess: () => setDraft(null) })}
          >
            <RotateCcw size={12} strokeWidth={STROKE} aria-hidden /> Volver a calibrado
          </button>
        ) : null}
      </form>
      {dirty && !valid ? (
        <p className="rule-error" role="alert">
          {rule.unit === 'usd'
            ? 'Escribe un monto desde 0,01, por ejemplo 2,50.'
            : `Escribe un número entero entre ${range.min} y ${formatEsInput(range.max, 'count')}.`}
        </p>
      ) : update.isError ? (
        <p className="rule-error" role="alert">
          {describeApiError(update.error)}
        </p>
      ) : null}
    </li>
  );
}

/** Interruptor de encendido (role switch): LED y texto, el color nunca va solo */
function Switch({
  checked,
  labelledBy,
  label,
  disabled,
  states = ['Encendida', 'Apagada'],
  onChange,
}: {
  checked: boolean;
  labelledBy?: string;
  label?: string;
  disabled?: boolean;
  /** texto encendido / apagado (concuerda con lo que prende: la regla, el aviso) */
  states?: [string, string];
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={label}
      disabled={disabled}
      className="switch"
      onClick={() => onChange(!checked)}
    >
      <span className="switch-track" aria-hidden>
        <span className="switch-knob" />
      </span>
      <span className="switch-text">{checked ? states[0] : states[1]}</span>
    </button>
  );
}

type NotifyProblem = 'unsupported' | 'denied' | 'dismissed';

const NOTIFY_PROBLEM_TEXT: Record<NotifyProblem, string> = {
  unsupported: 'Este navegador no permite notificaciones.',
  denied:
    'El navegador bloqueó las notificaciones de esta página. Abre los permisos del sitio (el ícono a la izquierda de la dirección), permite las notificaciones y vuelve a encender el aviso.',
  dismissed: 'No se concedió el permiso. Vuelve a encender el aviso y elige Permitir cuando el navegador pregunte.',
};

function browserPermission(): NotificationPermission | null {
  return typeof Notification === 'undefined' ? null : Notification.permission;
}

/**
 * Aviso del navegador cuando salta una alerta roja con la pestana oculta. Al encender se pide el permiso;
 * si no lo dan, no se guarda encendido y se explica como darlo.
 */
function NotifyToggle({ enabled }: { enabled: boolean }) {
  const set = useSetRulesNotify();
  const [problem, setProblem] = useState<NotifyProblem | null>(null);
  const permission = browserPermission();

  const toggle = async () => {
    setProblem(null);
    if (enabled) {
      set.mutate(false);
      return;
    }
    if (typeof Notification === 'undefined') {
      setProblem('unsupported');
      return;
    }
    let result: NotificationPermission;
    try {
      result = await Notification.requestPermission();
    } catch {
      result = 'denied';
    }
    if (result === 'granted') set.mutate(true);
    else setProblem(result === 'denied' ? 'denied' : 'dismissed');
  };

  return (
    <section className="notify row-in" aria-label="Aviso del navegador">
      {enabled ? <Bell size={16} strokeWidth={STROKE} aria-hidden /> : <BellOff size={16} strokeWidth={STROKE} aria-hidden />}
      <div className="notify-text">
        <span className="notify-title">Aviso del navegador</span>
        <span className="note">Una notificación cuando salte una alerta roja y esta pestaña esté oculta.</span>
      </div>
      <Switch
        checked={enabled}
        label="Aviso del navegador"
        states={['Encendido', 'Apagado']}
        disabled={set.isPending}
        onChange={() => void toggle()}
      />
      {problem ? (
        <p className="warn notify-problem" role="alert">
          <TriangleAlert size={16} strokeWidth={STROKE} aria-hidden />
          <span>{NOTIFY_PROBLEM_TEXT[problem]}</span>
        </p>
      ) : enabled && permission !== null && permission !== 'granted' ? (
        <p className="warn notify-problem" role="note">
          <TriangleAlert size={16} strokeWidth={STROKE} aria-hidden />
          <span>Está encendido, pero el navegador no tiene permiso: apágalo y vuelve a encenderlo para pedirlo.</span>
        </p>
      ) : set.isError ? (
        <p className="rule-error notify-problem" role="alert">
          {describeApiError(set.error)}
        </p>
      ) : null}
    </section>
  );
}
