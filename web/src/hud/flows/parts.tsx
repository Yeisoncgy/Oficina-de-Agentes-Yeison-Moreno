// Piezas de la sala de control de Flujos: colores de estado, iconos de rol y la guia "Como leer esta vista".
import {
  BookOpen,
  ClipboardList,
  Compass,
  FlaskConical,
  CircleQuestionMark,
  Hammer,
  Network,
  RotateCcw,
  SearchCheck,
  Shapes,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { AgentRole, WorkflowStatus } from '@shared/contract';
import type { ModelFamily } from '@/lib/models';
import { ROLE_LABEL, WORKFLOW_ROLES, type FlowTone } from '@/lib/workflows';
import { STATE } from '@/theme';
import { Led, STROKE } from '../primitives';

export const RUN_LED: Record<WorkflowStatus, string> = {
  running: STATE.working,
  done: STATE.done,
  failed: STATE.error,
  stopped: STATE.warning,
};

export const TONE_LED: Record<FlowTone, { color: string; blink: boolean }> = {
  working: { color: STATE.working, blink: true },
  thinking: { color: STATE.working, blink: true },
  idle: { color: STATE.idle, blink: false },
  done: { color: STATE.done, blink: false },
  failed: { color: STATE.error, blink: false },
  retried: { color: STATE.idle, blink: false },
};

/** el escudo es de Seguridad; Revision es la lupa con visto bueno */
export const ROLE_ICON: Record<AgentRole, LucideIcon> = {
  orchestrator: Network,
  explorer: Compass,
  builder: Hammer,
  reviewer: SearchCheck,
  tester: FlaskConical,
  security: ShieldCheck,
  planner: ClipboardList,
  docs: BookOpen,
  generalist: Shapes,
};

const FAMILIES: readonly { family: ModelFamily; label: string }[] = [
  { family: 'fable', label: 'Fable' },
  { family: 'opus', label: 'Opus' },
  { family: 'sonnet', label: 'Sonnet' },
  { family: 'haiku', label: 'Haiku' },
];

export function RoleTag({ role, className = '' }: { role: AgentRole; className?: string }) {
  const Icon = ROLE_ICON[role];
  return (
    <span className={`fx-role ${className}`}>
      <Icon size={14} strokeWidth={STROKE} aria-hidden />
      {ROLE_LABEL[role]}
    </span>
  );
}

const STATES: readonly { tone: FlowTone; label: string; text: string }[] = [
  { tone: 'working', label: 'Trabajando', text: 'usa una herramienta o está pensando' },
  { tone: 'idle', label: 'En espera', text: 'sigue abierto, sin hacer nada ahora' },
  { tone: 'done', label: 'Terminado', text: 'entregó su parte' },
  { tone: 'failed', label: 'Falló', text: 'terminó con error' },
];

/**
 * Guia plegable al pie de la vista: como se lee el recorrido, que significa cada estado, los roles, los
 * modelos y los atajos. Cerrada por defecto para no quitar espacio.
 */
export function HowToRead() {
  return (
    <details className="fx-guide">
      <summary className="fx-guide-sum">
        <CircleQuestionMark size={16} strokeWidth={STROKE} aria-hidden />
        Cómo leer esta vista
      </summary>
      <div className="fx-guide-body">
        <section className="fx-guide-sec">
          <h4 className="fx-guide-h">El recorrido</h4>
          <p className="fx-guide-p">
            Un flujo va de izquierda a derecha: tu solicitud, el orquestador que arma el trabajo, una etapa por
            cada fase del script, tu aprobación y el resultado. Clic en una fase para ir a ella.
          </p>
          <p className="fx-guide-p">
            Cada fase muestra sus agentes. Las que ya terminaron se pliegan mientras el flujo corre; la que
            sigue aparece marcada como <b>Sigue</b>.
          </p>
        </section>
        <section className="fx-guide-sec">
          <h4 className="fx-guide-h">Estados de un agente</h4>
          <ul className="fx-guide-list">
            {STATES.map(({ tone, label, text }) => (
              <li key={tone}>
                <Led color={TONE_LED[tone].color} hollow={tone === 'done'} className="fx-led" />
                <b>{label}</b> <span>{text}</span>
              </li>
            ))}
            <li>
              <RotateCcw size={14} strokeWidth={STROKE} aria-hidden />
              <b>Reintentado</b> <span>falló y el script lo volvió a lanzar</span>
            </li>
          </ul>
        </section>
        <section className="fx-guide-sec">
          <h4 className="fx-guide-h">Roles</h4>
          <ul className="fx-guide-chips">
            {WORKFLOW_ROLES.map((role) => (
              <li key={role}>
                <RoleTag role={role} />
              </li>
            ))}
          </ul>
          <h4 className="fx-guide-h">Modelos</h4>
          <ul className="fx-guide-chips">
            {FAMILIES.map(({ family, label }) => (
              <li key={family}>
                <span className="model-chip" data-family={family}>
                  {label}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="fx-guide-sec">
          <h4 className="fx-guide-h">Atajos</h4>
          <ul className="fx-guide-list">
            <li>
              <kbd className="kbd fx-kbd">F</kbd> <span>abre o cierra esta vista</span>
            </li>
            <li>
              <kbd className="kbd fx-kbd">Esc</kbd> <span>la cierra</span>
            </li>
            <li>
              <kbd className="kbd fx-kbd">←</kbd>
              <kbd className="kbd fx-kbd">→</kbd> <span>cambian de flujo en las pestañas</span>
            </li>
          </ul>
          <p className="fx-guide-p fx-guide-note">
            El dinero es el valor equivalente API: el plan es Enterprise, no es un cobro real.
          </p>
        </section>
      </div>
    </details>
  );
}
