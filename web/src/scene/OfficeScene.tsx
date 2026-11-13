// Escena 3D de la oficina. Se monta detras del HUD ocupando todo su contenedor.
// El Canvas no dibuja solo: el ritmo lo lleva scene/pacer.tsx (60 cuadros/s en uso, 30 quieta, 20 sin foco).
// Parametros de URL utiles para revisar: ?fx=0 (sin revelado) · ?calidad=baja (sin oclusion) · ?hora=21 (fuerza la hora).

import { Component, type ErrorInfo, memo, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { DEFAULT_LEAD_NAME } from '@shared/agents';
import type { OfficeSnapshot } from '@shared/contract';
import { useOfficeStore } from '@/state/store';
import { PALETTE } from '@/theme';
import { annexOfPlacement, mapIds, ownerOf } from './annex';
import { CameraRig, cameraOffset } from './CameraRig';
import { LeadAvatar, Subagents } from './Cast';
import { useDayState } from './daylight';
import { NoWebGL, SCENE_CSS, SceneLoader } from './labels';
import { assignSlots, computeLayout } from './layout';
import { Lighting } from './Lighting';
import { OfficeBase } from './OfficeBase';
import { CameraActivity, usePacer } from './pacer';
import { CinePipeline, skyBackground, updateSky } from './CinePipeline';
import { LOBBY_ID, RoomView } from './Room';
import { RoomHighlight } from './RoomHighlight';
import { registerSceneRoot } from './sceneEvents';
import { paintLeadPlate } from './textures';

function detectWebGL2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('webgl2');
    if (!ctx) return false;
    ctx.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** 0 = con revelado cinematografico (CinePipeline); null = render directo, sin pases (?fx=0 y las pruebas) */
export const DEFAULT_PIXEL = 0;

function pixelMode(): number | null {
  if (typeof window === 'undefined') return DEFAULT_PIXEL;
  return new URLSearchParams(window.location.search).get('fx') === '0' ? null : DEFAULT_PIXEL;
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Error en la escena 3D', error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.failed ? <NoWebGL reason="error" /> : this.props.children;
  }
}

/** repinta la placa del escritorio del lider cuando el usuario cambia su nombre */
const LeadPlate = memo(function LeadPlate({ name }: { name: string }) {
  useEffect(() => paintLeadPlate(name), [name]);
  return null;
});

// Lo que no depende del snapshot (o solo de la distribucion, que cambia pocas veces) va con memo: el snapshot
// llega cada pocos segundos y no tiene por que volver a renderizar luces, exterior, camara ni revelado.
const LightingM = memo(Lighting);
const OfficeBaseM = memo(OfficeBase);
const RoomHighlightM = memo(RoomHighlight);
const CameraRigM = memo(CameraRig);
const CameraActivityM = memo(CameraActivity);
const CinePipelineM = memo(CinePipeline);

function FirstFrame({ onReady }: { onReady: () => void }) {
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    done.current = true;
    onReady();
  });
  return null;
}

interface OfficeProps {
  snapshot: OfficeSnapshot;
  /** 0 = con revelado (CinePipeline); null = render directo */
  pixel: number | null;
  /** etiquetas HTML y controles de camara (las pruebas los apagan) */
  labels?: boolean;
  controls?: boolean;
}

/** Contenido de la oficina (dentro del Canvas) */
export function Office({ snapshot, pixel, labels = true, controls = true }: OfficeProps) {
  const slots = useRef<Map<string, number>>(new Map());
  const ids = snapshot.rooms.length > 0 ? mapIds(snapshot.rooms) : [LOBBY_ID];
  const annexIds = ids.filter((id) => annexOfPlacement(id) > 0);
  // el lugar fijo lo manda el server (room.slot); asi la sala no se mueve ni al recargar. La llave tambien
  // cambia cuando aparece o se quita un anexo
  const slotsKey =
    snapshot.rooms.length > 0
      ? [...snapshot.rooms.map((r) => `${r.id}@${r.slot ?? ''}`), ...annexIds].join('\n')
      : LOBBY_ID;
  const layout = useMemo(() => {
    const fixed = new Map<string, number>();
    for (const r of snapshot.rooms) if (r.slot !== undefined) fixed.set(r.id, r.slot);
    // primero las salas y despues los anexos, en el orden que ya tenian: un anexo nunca le quita el lugar a
    // una sala que llega (el server numera las salas sin contar anexos)
    const next = assignSlots(slots.current, ids.filter((id) => annexOfPlacement(id) === 0), fixed);
    const base = next.size;
    for (const [id, i] of assignSlots(slots.current, annexIds)) next.set(id, base + i);
    slots.current = next;
    return computeLayout(slots.current);
  }, [slotsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const roomById = useMemo(() => new Map(snapshot.rooms.map((r) => [r.id, r])), [snapshot.rooms]);
  const day = useDayState();
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    updateSky(day);
    scene.background = skyBackground;
  }, [scene, day]);

  return (
    <>
      <LightingM layout={layout} />
      <OfficeBaseM layout={layout} />
      <RoomHighlightM layout={layout} rooms={snapshot.rooms} />
      {layout.rooms.map((placement) => {
        const annex = annexOfPlacement(placement.id);
        return (
          <RoomView
            key={placement.id}
            placement={placement}
            room={roomById.get(ownerOf(placement.id)) ?? null}
            annex={annex}
            lampsOn={day.lampsOn}
            labels={labels}
            leadHere={annex === 0 && snapshot.leadRoomId === placement.id}
          />
        );
      })}
      <LeadPlate name={snapshot.leadName ?? DEFAULT_LEAD_NAME} />
      <Subagents rooms={snapshot.rooms} layout={layout} labels={labels} />
      <LeadAvatar layout={layout} snapshot={snapshot} labels={labels} />
      {controls ? <CameraRigM layout={layout} /> : null}
      <CameraActivityM />
      {pixel !== null ? <CinePipelineM /> : null}
    </>
  );
}

const ROOT_STYLE = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  isolation: 'isolate',
  background: PALETTE.ink,
} as const;

const INITIAL_CAMERA = cameraOffset().toArray();

/**
 * La oficina leyendo el snapshot del store desde dentro del Canvas: asi un snapshot nuevo no re-renderiza el
 * Canvas (que reconfigura el renderer en cada render), solo lo que esta debajo.
 */
function LiveOffice({ pixel }: { pixel: number | null }) {
  const snapshot = useOfficeStore((s) => s.snapshot);
  return snapshot ? <Office snapshot={snapshot} pixel={pixel} /> : null;
}

export function OfficeScene() {
  const hasSnapshot = useOfficeStore((s) => s.snapshot !== null);
  const [supported] = useState(detectWebGL2);
  const [pixel] = useState(pixelMode);
  const [ready, setReady] = useState(false);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const onReady = useCallback(() => setReady(true), []);
  const onRoot = useCallback((el: HTMLDivElement | null) => {
    registerSceneRoot(el);
    setRoot(el);
  }, []);
  // el reloj de la escena: avanza los cuadros al ritmo que toca (ver pacer.tsx)
  usePacer(root, supported && hasSnapshot);

  return (
    <div ref={onRoot} data-office-scene="" data-zoom="mid" style={ROOT_STYLE}>
      <style>{SCENE_CSS}</style>
      {!supported ? (
        <NoWebGL reason="unsupported" />
      ) : hasSnapshot ? (
        <SceneBoundary>
          <Canvas
            orthographic
            shadows="variance"
            dpr={[1, 1.75]}
            frameloop="never"
            gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}
            camera={{ position: INITIAL_CAMERA, zoom: 40, near: 0.1, far: 200 }}
            style={{ position: 'absolute', inset: 0 }}
          >
            <Suspense fallback={null}>
              <LiveOffice pixel={pixel} />
              <FirstFrame onReady={onReady} />
            </Suspense>
          </Canvas>
        </SceneBoundary>
      ) : null}
      {supported && !ready ? <SceneLoader /> : null}
    </div>
  );
}
