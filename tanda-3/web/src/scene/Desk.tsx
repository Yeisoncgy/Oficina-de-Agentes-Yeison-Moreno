// Escritorio: lo que cambia con el estado del agente. El mueble, la silla y la lampara estan fusionados
// en la geometria estatica de la sala (world/room.ts); aqui van las pantallas (con encendido en pasos
// de D5), el halo que asoma detras del monitor, el reflejo cian sobre la mesa, el clic y la tarjeta.
// En v2 el monitor mira al agente (y el agente a la camara): el estado se lee por el halo y el reflejo.
// Halo de aviso sobre el puesto: rojo si su agente tiene una alerta viva; ambar en el escritorio de
// lider cuando espera una respuesta y su avatar no esta en la sala. Late (fijo con movimiento reducido).

import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { type ThreeEvent, useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { AdditiveBlending, Color, type Mesh, MeshBasicMaterial, type Sprite, SpriteMaterial } from 'three';
import type { OfficeAgent } from '@shared/contract';
import { useOfficeStore } from '@/state/store';
import { STATE, UI } from '@/theme';
import { KitGeo } from './builder';
import type { DeskSpec } from './layout';
import { MAT, type ScreenMode, screenMaterial } from './materials';
import { arrowGeometry, screenGeometry, unitBox } from './models';
import { useAgentHover } from './useAgentHover';
import { glowTexture } from './textures';
import { AMBIENT } from './world/ambient';
import { DIM, flickerOff, flickerOn, PAL } from './world/kit';
import { monitorSpots, screenSpot } from './world/pieces';

export function screenModeOf(agent: OfficeAgent | undefined, closed: boolean): ScreenMode {
  if (closed || !agent) return 'off';
  if (agent.status === 'done') return 'done';
  if (agent.status === 'idle') return 'idle';
  return agent.action ? 'code' : 'think';
}

interface DeskProps {
  spec: DeskSpec;
  screen: ScreenMode;
  /** compatibilidad: las lamparas siguen al ambiente global (world/ambient) */
  lampsOn?: boolean;
  closed: boolean;
  /** agente a seleccionar con clic (ocupante del puesto o lider de la sala) */
  selectId: string | null;
  /** tarjeta flotante (solo el escritorio de lider la usa; los subagentes la llevan encima) */
  label?: ReactNode;
  /** halo de aviso sobre el puesto (ver DeskHalo) */
  halo?: DeskHalo;
}

/** alert: su agente tiene una alerta viva · waiting: el lider espera una respuesta del usuario */
export type DeskHalo = 'alert' | 'waiting' | null;

const CYAN = new Color(PAL.cyan);
const LEAF = new Color(PAL.leaf);
const HALO_COLOR: Readonly<Record<'alert' | 'waiting', Color>> = { alert: new Color(STATE.error), waiting: new Color(UI.accent) };
/** latidos por segundo del halo de aviso */
const HALO_HZ: Readonly<Record<'alert' | 'waiting', number>> = { alert: 1.1, waiting: 0.5 };

/** color del halo y del reflejo segun la pantalla (kit: glowColor) */
function glowOf(mode: ScreenMode): Color | null {
  if (mode === 'code' || mode === 'think') return CYAN;
  if (mode === 'done') return LEAF;
  return null;
}

const poolCache = new Map<string, ReturnType<KitGeo['build']>>();

/** reflejo de cada pantalla sobre la cubierta (entre el teclado y el monitor), en coordenadas del escritorio */
function poolGeometry(kind: 'lead' | 'worker') {
  const hit = poolCache.get(kind);
  if (hit) return hit;
  const g = new KitGeo(3);
  // por encima del tapete (h + 0.005) y de las hojas, por debajo del teclado
  const top = (kind === 'lead' ? DIM.LEAD_DESK.h : DIM.DESK.h) + 0.0065;
  for (const m of monitorSpots(kind)) {
    const fx = Math.sin(m.rotY);
    const fz = Math.cos(m.rotY);
    const cx = m.x + fx * 0.22;
    const cz = m.z + fz * 0.22;
    g.qy(cx - 0.31, cz - 0.21, cx + 0.31, cz + 0.21, top, '#ffffff');
  }
  const geo = g.build();
  poolCache.set(kind, geo);
  return geo;
}

export function Desk({ spec, screen, closed, selectId, label, halo = null }: DeskProps) {
  const monitors = monitorSpots(spec.kind);
  const seatZ = spec.seat.z - spec.z;
  const selected = useOfficeStore((s) => selectId !== null && s.selectedAgentId === selectId);
  const hover = useAgentHover(selectId);
  const arrow = useRef<Mesh>(null);
  const halos = useRef<(Sprite | null)[]>([]);
  const pool = useRef<Mesh>(null);
  const warn = useRef<Sprite>(null);
  const screens = useRef<(Mesh | null)[]>([]);
  const mode: ScreenMode = closed ? 'off' : screen;
  const warning = closed ? null : halo;

  // materiales propios: cada escritorio enciende y apaga su halo a su tiempo
  const mats = useMemo(
    () => ({
      halo: new SpriteMaterial({ map: glowTexture, color: CYAN, blending: AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }),
      pool: new MeshBasicMaterial({ map: glowTexture, color: CYAN, blending: AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }),
      warn: new SpriteMaterial({ map: glowTexture, color: HALO_COLOR.alert, blending: AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }),
    }),
    [],
  );
  useEffect(
    () => () => {
      mats.halo.dispose();
      mats.pool.dispose();
      mats.warn.dispose();
    },
    [mats],
  );
  useEffect(() => {
    if (warning) mats.warn.color.copy(HALO_COLOR[warning]);
  }, [warning, mats]);

  // encendido / apagado de la pantalla con los pasos de D5
  const power = useRef({ on: mode !== 'off', since: -99, glow: glowOf(mode) });
  useEffect(() => {
    const p = power.current;
    const on = mode !== 'off';
    const glow = glowOf(mode);
    if (on !== p.on) {
      p.on = on;
      p.since = AMBIENT.clock;
    }
    if (glow) {
      p.glow = glow;
      mats.halo.color.copy(glow);
      mats.pool.color.copy(glow);
    } else if (on) {
      p.glow = null;
    }
  }, [mode, mats]);

  useFrame(({ clock }) => {
    const p = power.current;
    const e = AMBIENT.clock - p.since;
    const level = AMBIENT.reduced ? (p.on ? 1 : 0) : p.on ? flickerOn(e) : flickerOff(e);
    const glowing = p.glow !== null && level > 0 && !closed;
    const t = AMBIENT.t;
    const k = glowing ? level * AMBIENT.glowNight : 0;
    mats.halo.opacity = k * (0.22 + 0.009 * Math.sin((t * Math.PI * 2) / 0.7 + spec.index));
    mats.pool.opacity = k * (0.3 + 0.021 * Math.sin((t * Math.PI * 2) / 2 + spec.index * 2));
    for (const h of halos.current) if (h) h.visible = glowing;
    if (pool.current) pool.current.visible = glowing;
    for (const s of screens.current) if (s) s.visible = level > 0.1;
    if (arrow.current) arrow.current.position.y = 1.52 + Math.abs(Math.sin(clock.elapsedTime * 4)) * 0.08;
    const w = warn.current;
    if (w) {
      w.visible = warning !== null;
      if (warning) {
        const beat = AMBIENT.reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * HALO_HZ[warning] + spec.index);
        mats.warn.opacity = (warning === 'alert' ? 0.34 : 0.26) + 0.24 * beat;
      }
    }
  });

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (!selectId || e.delta > 6) return;
    e.stopPropagation();
    useOfficeStore.getState().selectAgent(selectId);
  };

  // apagada no se dibuja: desde la camara solo se ve la carcasa oscura del monitor
  return (
    <group position={[spec.x, 0, spec.z]}>
      {mode !== 'off'
        ? monitors.map((m, i) => {
            const s = screenSpot(m);
            return (
              <mesh
                key={i}
                ref={(el) => {
                  screens.current[i] = el;
                }}
                geometry={screenGeometry()}
                material={screenMaterial(mode, spec.index + i, closed)}
                position={[s.x, s.y, s.z]}
                rotation={[0, s.rotY, 0]}
              />
            );
          })
        : null}
      {monitors.map((m, i) => {
        const fx = Math.sin(m.rotY);
        const fz = Math.cos(m.rotY);
        return (
          <sprite
            key={`halo-${i}`}
            ref={(el) => {
              halos.current[i] = el;
            }}
            material={mats.halo}
            position={[m.x + fx * 0.2, m.y + 0.25, m.z + fz * 0.2]}
            scale={[0.8, 0.6, 1]}
            visible={false}
          />
        );
      })}
      <mesh ref={pool} geometry={poolGeometry(spec.kind)} material={mats.pool} visible={false} />
      <sprite
        ref={warn}
        material={mats.warn}
        position={[0, 0.85, seatZ / 2]}
        scale={[spec.w + 1.1, 1.5, 1]}
        visible={false}
        renderOrder={2}
      />
      <mesh
        geometry={unitBox()}
        material={MAT.hitbox}
        position={[0, 0.55, seatZ / 2]}
        scale={[spec.w, 1.1, spec.d + Math.abs(seatZ) + 0.2]}
        onClick={onClick}
        onPointerOver={(e) => {
          if (!selectId) return;
          e.stopPropagation();
          hover.over();
        }}
        onPointerOut={hover.out}
      />
      {selected && spec.kind === 'lead' ? (
        <mesh ref={arrow} geometry={arrowGeometry()} material={MAT.arrow} position={[0, 1.52, seatZ]} rotation={[0, Math.PI / 4, 0]} />
      ) : null}
      {label ? (
        <Html position={[0, 1.8, seatZ]} zIndexRange={[30, 10]} pointerEvents="none" wrapperClass="ofc-anchor">
          {label}
        </Html>
      ) : null}
    </group>
  );
}
