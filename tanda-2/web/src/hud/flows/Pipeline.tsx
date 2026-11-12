// Recorrido del flujo (Solicitud -> Orquestador -> fases -> Aprobacion humana -> Completado) y chip de riesgo.
import { Check, Flag, Hand, Network, Send, X, type LucideIcon } from 'lucide-react';
import type { BudgetRisk } from '@shared/contract';
import { PIPE_STATUS_LABEL, pipelineText, RISK_LABEL, type PipeNode, type PipeNodeKind } from '@/lib/workflows';
import { STROKE } from '../primitives';

const NODE_ICON: Record<Exclude<PipeNodeKind, 'phase'>, LucideIcon> = {
  request: Send,
  orchestrator: Network,
  approval: Hand,
  result: Flag,
};

/** "phase:fase-1" -> "fase-1" (clave de la columna del tablero); null en nodos que no son fase */
function columnKeyOf(node: PipeNode): string | null {
  if (node.kind !== 'phase' || node.key === 'phase:none') return null;
  return node.key.slice('phase:'.length);
}

function Mark({ node, n }: { node: PipeNode; n: number }) {
  if (node.status === 'done' && node.kind !== 'request') return <Check size={16} strokeWidth={2} aria-hidden />;
  if (node.status === 'failed') return <X size={16} strokeWidth={2} aria-hidden />;
  if (node.kind === 'phase') return <span className="num">{n}</span>;
  const Icon = NODE_ICON[node.kind];
  return <Icon size={15} strokeWidth={STROKE} aria-hidden />;
}

/**
 * Una etapa por nodo, unidas por un conector que se llena al cumplirse. La etapa en curso late, la
 * aprobacion humana se enciende en ambar cuando el lead espera al usuario y las fases llevan su numero y
 * "terminados/arrancados". Clic en una fase: el tablero va a ella. Los lectores de pantalla reciben el
 * recorrido entero en una frase.
 */
export function FlowPipeline({ nodes, onPhase }: { nodes: readonly PipeNode[]; onPhase?: (columnKey: string) => void }) {
  let phase = 0;
  return (
    <nav className="fx-pipe-wrap" aria-label="Recorrido del flujo">
      <p className="sr-only">Recorrido: {pipelineText(nodes)}</p>
      <ol className="fx-pipe">
        {nodes.map((node) => {
          if (node.kind === 'phase') phase += 1;
          const key = columnKeyOf(node);
          const sub = node.status === 'waiting' ? 'Espera tu respuesta' : PIPE_STATUS_LABEL[node.status];
          const inner = (
            <>
              <span className="fx-pipe-mark">
                <Mark node={node} n={phase} />
              </span>
              <span className="fx-pipe-text">
                <span className="fx-pipe-label">{node.label}</span>
                <span className="fx-pipe-sub">
                  {sub}
                  {node.detail ? <span className="fx-pipe-detail num"> · {node.detail}</span> : null}
                </span>
              </span>
            </>
          );
          return (
            <li key={node.key} className={`fx-pipe-node is-${node.kind} is-${node.status}`} aria-hidden={key && onPhase ? undefined : true}>
              {key && onPhase ? (
                <button
                  type="button"
                  className="fx-pipe-btn"
                  onClick={() => onPhase(key)}
                  title={`Ir a la fase ${node.label}`}
                  aria-label={`Fase ${phase}: ${node.label}, ${sub}${node.detail ? `, ${node.detail} terminados` : ''}. Ir a la fase`}
                >
                  {inner}
                </button>
              ) : (
                <span className="fx-pipe-btn is-static">{inner}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Riesgo del pronostico contra el tope de la corrida (presupuesto por flujo): color + texto (nunca el color solo) */
export function RiskChip({ risk }: { risk: BudgetRisk }) {
  return <span className={`lv-risk is-${risk}`}>{RISK_LABEL[risk]}</span>;
}
