import { useEffect } from 'react';
import type { LiveAlert, OfficeSnapshot } from '@shared/contract';
import { roomAgents } from '@/lib/office';
import { findAgent, useOfficeStore } from '@/state/store';

/** Alerta roja viva de un agente o de una sala, lista para avisar */
export interface AlertNotice {
  key: string;
  /** lo que abre el clic en la notificacion */
  target: { kind: 'agent' | 'room'; id: string };
  /** "Bruno" o "Sala office-site" */
  who: string;
  /** "Bruno · Sala office-site" */
  title: string;
  /** titulo de la alerta ("Fallo 2 veces seguidas"): nunca texto de prompts */
  body: string;
  level: LiveAlert['level'];
}

/**
 * Identidad de una alerta: agente o sala + titulo. Las cifras del titulo cambian de un snapshot a otro
 * ("Costo $3,40 > $2,00", "Fallo 3 veces seguidas") y no la vuelven una alerta nueva.
 */
export function alertKey(kind: 'agent' | 'room', id: string, alert: LiveAlert): string {
  return `${kind}:${id}:${alert.title.replace(/\d+(?:[.,]\d+)*/g, '#')}`;
}

/** Alertas vivas del snapshot: la de cada sala y la de cada agente presente (los que ya salen no cuentan) */
export function liveAlerts(snapshot: OfficeSnapshot): AlertNotice[] {
  const out: AlertNotice[] = [];
  for (const room of snapshot.rooms) {
    if (room.alert) {
      out.push({
        key: alertKey('room', room.id, room.alert),
        target: { kind: 'room', id: room.id },
        who: `Sala ${room.title}`,
        title: `Sala ${room.title}`,
        body: room.alert.title,
        level: room.alert.level,
      });
    }
    for (const agent of roomAgents(room)) {
      if (agent.status === 'done' || !agent.alert) continue;
      out.push({
        key: alertKey('agent', agent.id, agent.alert),
        target: { kind: 'agent', id: agent.id },
        who: agent.displayName,
        title: `${agent.displayName} · Sala ${room.title}`,
        body: agent.alert.title,
        level: agent.alert.level,
      });
    }
  }
  return out;
}

export interface NotifyEnv {
  /** Notification.permission, o 'unsupported' si el navegador no tiene la API */
  permission(): NotificationPermission | 'unsupported';
  /** la pestana esta oculta (document.hidden) */
  hidden(): boolean;
  show(notice: AlertNotice): void;
}

/** Con mas alertas nuevas que esto en un mismo snapshot sale un solo aviso que las resume */
export const MAX_NOTICES_AT_ONCE = 3;

function groupNotice(fresh: readonly AlertNotice[]): AlertNotice {
  const ordered = [...fresh].sort((a, b) => (a.level === b.level ? 0 : a.level === 'critical' ? -1 : 1));
  const first = ordered[0] as AlertNotice;
  return {
    key: `grupo:${ordered.map((n) => n.key).join('|')}`,
    target: first.target,
    who: first.who,
    title: `${fresh.length} alertas nuevas en la oficina`,
    body: [
      ...ordered.slice(0, MAX_NOTICES_AT_ONCE).map((n) => `${n.who}: ${n.body}`),
      `y ${fresh.length - MAX_NOTICES_AT_ONCE} más`,
    ].join('\n'),
    level: first.level,
  };
}

/**
 * Una alerta que se apago al menos este tiempo y vuelve es un episodio nuevo (otro dia, otro turno, otra
 * racha de fallos) y avisa otra vez. Si vuelve antes, es la misma que parpadeo y no repite el aviso.
 */
export const ALERT_FORGET_AFTER_MS = 30 * 60_000;

/**
 * Avisador con memoria: cada episodio de una alerta avisa una sola vez. Las del primer snapshot ya estaban
 * (recargar no repite avisos) y las que aparecen con la pestana a la vista cuentan como vistas. El reloj es
 * snapshot.generatedAt (hora del server). Solo avisa con la opcion de Reglas encendida
 * (snapshot.habits.notifyBrowser), el permiso concedido y la pestana oculta. Devuelve los avisos que mostro.
 */
export function createAlertNotifier(env: NotifyEnv): (snapshot: OfficeSnapshot) => AlertNotice[] {
  // llave -> ultima vez que vino en un snapshot (ms)
  let lastPresent: Map<string, number> | null = null;
  let previousAt = 0;
  return (snapshot) => {
    const alerts = liveAlerts(snapshot);
    const parsed = Date.parse(snapshot.generatedAt);
    const now = Number.isNaN(parsed) ? previousAt : parsed;
    if (!lastPresent) {
      lastPresent = new Map(alerts.map((a) => [a.key, now]));
      previousAt = now;
      return [];
    }
    const known = lastPresent;
    const present = new Set(alerts.map((a) => a.key));
    for (const [key, at] of known) {
      if (!present.has(key) && now - at >= ALERT_FORGET_AFTER_MS) known.delete(key);
    }
    // vuelve tras faltar en el snapshot anterior y lleva el tiempo de olvido sin verse (sin snapshots entre medio)
    const fresh = alerts.filter((a) => {
      const at = known.get(a.key);
      return at === undefined || (at !== previousAt && now - at >= ALERT_FORGET_AFTER_MS);
    });
    for (const alert of alerts) known.set(alert.key, now);
    previousAt = now;
    if (fresh.length === 0 || !snapshot.habits?.notifyBrowser) return [];
    if (env.permission() !== 'granted' || !env.hidden()) return [];
    const notices = fresh.length > MAX_NOTICES_AT_ONCE ? [groupNotice(fresh)] : fresh;
    for (const notice of notices) env.show(notice);
    return notices;
  };
}

/** Clic en la notificacion: vuelve a la pestana y abre al agente (si sigue) o lleva la camara a la sala */
function openTarget(target: AlertNotice['target']): void {
  const state = useOfficeStore.getState();
  if (target.kind === 'agent') {
    if (findAgent(state.snapshot, target.id)) state.selectAgent(target.id);
    return;
  }
  state.focusRoom(target.id);
}

const browserEnv: NotifyEnv = {
  permission: () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission),
  hidden: () => typeof document !== 'undefined' && document.hidden,
  show: (notice) => {
    try {
      const notification = new Notification(notice.title, { body: notice.body, tag: notice.key, lang: 'es-CO' });
      notification.onclick = () => {
        window.focus();
        openTarget(notice.target);
        notification.close();
      };
    } catch {
      // algunos navegadores solo notifican desde un service worker: la alerta sigue en la oficina
    }
  },
};

/**
 * Notificaciones del navegador para las alertas rojas nuevas (montado una vez en Hud). Escucha el store por
 * fuera de React: suscribir el componente al snapshot volveria a pintar todo el HUD con cada snapshot.
 */
export function useAlertNotifications(): void {
  useEffect(() => {
    const notify = createAlertNotifier(browserEnv);
    const onState = (state: ReturnType<typeof useOfficeStore.getState>) => {
      // la demo trae alertas ficticias: no se avisan
      if (state.snapshot && !state.demo) notify(state.snapshot);
    };
    onState(useOfficeStore.getState());
    return useOfficeStore.subscribe((state, previous) => {
      if (state.snapshot !== previous.snapshot || state.demo !== previous.demo) onState(state);
    });
  }, []);
}
