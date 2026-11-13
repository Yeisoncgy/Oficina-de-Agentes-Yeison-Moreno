// Pasos del mini tutorial del HUD (Tour.tsx). Puro: los textos dependen solo del contexto que recibe.
// Textos cortos: una o dos frases por paso, sin explicar de mas.
import type { OfficeSnapshot } from '@shared/contract';

export type TourStepId = 'welcome' | 'connection' | 'spend' | 'rooms' | 'scene' | 'agent' | 'flows' | 'habits' | 'done';

/**
 * Que resalta el paso. element: todo lo que coincide con el selector (la caja que los envuelve) ·
 * scene: el area libre de la escena (store.hudInsets) · none: tarjeta al centro, sin resaltar.
 */
export type TourTarget = { kind: 'none' } | { kind: 'element'; selector: string } | { kind: 'scene' };

export interface TourShortcut {
  key: string;
  label: string;
}

export interface TourStep {
  id: TourStepId;
  title: string;
  body: string[];
  target: TourTarget;
  /** atajos de teclado del paso */
  keys: string[];
  /** lista de atajos del cierre */
  shortcuts: TourShortcut[];
  /** agente cuyo panel abre el paso (selectAgent); null = no abre nada */
  openAgentId: string | null;
  /** oficina sin salas: boton "Ver con datos de ejemplo" (?demo=1) */
  offerDemo: boolean;
  /** boton "Cambiar mi nombre" (fuera del demo: sin server no hay donde guardarlo) */
  offerRename: boolean;
}

export interface TourContext {
  /** nombre que eligio el usuario; null = demo o todavia sin nombre */
  name: string | null;
  demo: boolean;
  /** salas en la oficina ahora */
  rooms: number;
  /** agente para el paso del panel (pickTourAgent); null = el paso lo explica sin abrir nada */
  agentId: string | null;
  /** false en pantallas angostas: solo tarjetas al centro, sin resaltar ni abrir paneles */
  spotlight: boolean;
}

/** pantallas mas angostas que esto: la guia va sin resaltar */
export const TOUR_SPOTLIGHT_MIN_WIDTH = 768;

const NONE: TourTarget = { kind: 'none' };

const el = (selector: string): TourTarget => ({ kind: 'element', selector });

export const TOUR_SHORTCUTS: TourShortcut[] = [
  { key: 'A', label: 'Hábitos' },
  { key: 'F', label: 'Flujos' },
  { key: 'Tab', label: 'Despliega o pliega las salas' },
  { key: 'Esc', label: 'Cierra lo que está arriba' },
];

/**
 * Agente para el paso del panel: uno que este trabajando (se ven su accion y los cronometros en marcha),
 * si no el lider de la sala donde esta el usuario, si no el de la primera sala.
 */
export function pickTourAgent(snapshot: Pick<OfficeSnapshot, 'rooms' | 'leadRoomId'> | null): string | null {
  if (!snapshot || snapshot.rooms.length === 0) return null;
  for (const room of snapshot.rooms) {
    const sub = room.subagents.find((a) => a.status === 'working');
    if (sub) return sub.id;
  }
  const working = snapshot.rooms.find((r) => r.lead.status === 'working');
  if (working) return working.lead.id;
  const home = snapshot.rooms.find((r) => r.id === snapshot.leadRoomId) ?? snapshot.rooms[0];
  return home ? home.lead.id : null;
}

export function tourSteps(ctx: TourContext): TourStep[] {
  const { name, demo, spotlight } = ctx;
  const hasRooms = ctx.rooms > 0;
  const agentId = hasRooms ? ctx.agentId : null;
  const opensAgent = spotlight && agentId !== null;

  const steps: TourStep[] = [
    {
      ...base('welcome', 'Tu oficina'),
      body: [
        `${name ? `${name}, esta` : 'Esta'} es tu oficina: una sala por sesión de Claude Code y un escritorio por agente.`,
        demo ? 'Modo demo: los datos son de ejemplo.' : 'Avanza con Siguiente o con las flechas.',
      ],
    },
    {
      ...base('connection', 'Conexión'),
      target: el('.hud-bar--view'),
      body: [
        demo
          ? 'El estado de la oficina. DEMO: datos de ejemplo.'
          : 'Si la oficina está conectada. Si dice «Sin conexión», revisa que Colmena siga abierta.',
      ],
    },
    {
      ...base('spend', 'Gasto'),
      target: el('[data-tour="today"], [data-tour="month"]'),
      body: [
        'Lo de hoy y lo del mes, en valor equivalente API. No es un cobro real.',
        demo ? 'El mes necesita el servidor.' : 'Clic en la barra del mes para ajustar el presupuesto.',
      ],
    },
    {
      ...base('rooms', 'Salas'),
      target: el('#room-list'),
      keys: ['Tab'],
      offerDemo: !hasRooms && !demo,
      body: hasRooms
        ? [
            'Una sala por sesión. LED que late: trabaja. Fijo: espera. Hueco: inactiva o cerrada.',
            'Clic en una sala para ir a ella y ver su panel. Arrástrala para cambiarla de lugar.',
          ]
        : ['Todavía no hay ninguna: aparecen cuando trabajas con Claude Code.', 'Mientras, mira la oficina con datos de ejemplo.'],
    },
    {
      ...base('scene', 'La oficina'),
      target: { kind: 'scene' },
      body: [
        'Izquierdo mueve, derecho gira, la rueda acerca. Doble clic en una sala la enfoca; en el vacío, muestra todo.',
        name ? `Tú eres ${name}: te sientas en la sala donde escribiste por última vez.` : 'Tú eres el líder: te sientas en la sala donde escribiste por última vez.',
      ],
    },
    {
      ...base('agent', 'Agentes'),
      target: opensAgent ? el('.hud-drawer') : NONE,
      keys: ['Esc'],
      openAgentId: opensAgent ? agentId : null,
      offerDemo: !hasRooms && !demo,
      body: [
        'Clic en un agente para ver su tarea, qué hace ahora, sus tokens y el transcript.',
        hasRooms ? 'Esc lo cierra.' : 'Pruébalo cuando tengas agentes. Esc lo cierra.',
      ],
    },
    {
      ...base('flows', 'Flujos'),
      target: el('[data-tour="flows"]'),
      keys: ['F'],
      body: ['Te lleva a la sala del flujo (Workflow): ahí ves en qué fase va y quién trabaja.'],
    },
    {
      ...base('habits', 'Hábitos'),
      target: el('[data-tour="habits"]'),
      keys: ['A'],
      body: [
        'Lo que gasta tokens de más y qué pedirle distinto a Claude. En rojo: hay una alerta.',
        demo ? 'Ahí están también el gasto, el ranking y las reglas (necesitan el servidor).' : 'Ahí están también el gasto, el ranking y las reglas.',
      ],
    },
    {
      ...base('done', 'Listo'),
      target: el('[data-tour="habits"]'),
      shortcuts: TOUR_SHORTCUTS,
      offerRename: !demo,
      body: [
        name ? `Listo, ${name}. Los atajos:` : 'Listo. Los atajos:',
        'Esta guía la repites desde Hábitos, con el botón Guía.',
      ],
    },
  ];

  return spotlight ? steps : steps.map((step) => ({ ...step, target: NONE }));
}

function base(id: TourStepId, title: string): TourStep {
  return { id, title, body: [], target: NONE, keys: [], shortcuts: [], openAgentId: null, offerDemo: false, offerRename: false };
}
