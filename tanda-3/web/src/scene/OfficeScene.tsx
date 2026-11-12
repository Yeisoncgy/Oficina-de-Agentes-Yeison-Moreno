// Escena 3D de la oficina. Se monta detras del HUD ocupando todo su contenedor.
// Parametros de URL utiles para revisar: ?pixel=0 (sin pixelado ni contornos) · ?hora=21 (fuerza la hora).

import { Component, type ErrorInfo, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { PixelPipeline } from './PixelPipeline';
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

/**
 * Tamano del pixel de arte en px CSS. Por defecto 0 = resolucion completa con contorno tinta, cielo y
 * toon (se ve mejor que el pixel grueso, sobre todo proyectado). ?pixel=2|3|4 = pixel art;
 * ?pixel=0 = sin pase (sin contorno), solo para depurar.
 */
export const DEFAULT_PIXEL = 0;

function pixelMode(): number | null {
  if (typeof window === 'undefined') return DEFAULT_PIXEL;
  const raw = new URLSearchParams(window.location.search).get('pixel');
  if (raw === '0') return null;
  const n = Number(raw);
  return raw !== null && Number.isInteger(n) && n >= 2 && n <= 8 ? n : DEFAULT_PIXEL;
}

function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return hidden;
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
function LeadPlate({ name }: { name: string }) {
  useEffect(() => paintLeadPlate(name), [name]);
  return null;
}

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
  /** tamano del pixel de arte (0 = resolucion completa); null = sin pase */
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
    scene.background = pixel !== null ? null : day.sky.clone();
  }, [scene, pixel, day]);

  return (
    <>
      <Lighting layout={layout} />
      <OfficeBase layout={layout} />
      <RoomHighlight layout={layout} rooms={snapshot.rooms} />
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
      {controls ? <CameraRig layout={layout} /> : null}
      {pixel !== null ? <PixelPipeline size={pixel} /> : null}
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

export function OfficeScene() {
  const snapshot = useOfficeStore((s) => s.snapshot);
  const [supported] = useState(detectWebGL2);
  const [pixel] = useState(pixelMode);
  const [ready, setReady] = useState(false);
  const hidden = usePageHidden();
  const onReady = useCallback(() => setReady(true), []);

  return (
    <div ref={registerSceneRoot} data-office-scene="" data-zoom="mid" style={ROOT_STYLE}>
      <style>{SCENE_CSS}</style>
      {!supported ? (
        <NoWebGL reason="unsupported" />
      ) : snapshot ? (
        <SceneBoundary>
          <Canvas
            orthographic
            flat
            shadows="basic"
            dpr={[1, 2]}
            frameloop={hidden ? 'never' : 'always'}
            gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}
            camera={{ position: INITIAL_CAMERA, zoom: 40, near: 0.1, far: 200 }}
            style={{ position: 'absolute', inset: 0 }}
          >
            <Suspense fallback={null}>
              <Office snapshot={snapshot} pixel={pixel} />
              <FirstFrame onReady={onReady} />
            </Suspense>
          </Canvas>
        </SceneBoundary>
      ) : null}
      {supported && !ready ? <SceneLoader /> : null}
    </div>
  );
}
