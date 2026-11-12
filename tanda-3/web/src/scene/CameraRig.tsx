// Camara ortografica isometrica sobre OrbitControls acotados, con el pulido de un visor profesional:
// - arrastrar = panear · boton derecho o Ctrl+clic = girar (azimut +-85 grados, inclinacion 46-64 grados)
//   · rueda = zoom suave hacia el puntero (propio, con inercia: la rueda no llega a OrbitControls)
//   · pellizco en tactil.
// - teclado, sin modificadores y con el foco en la escena: flechas panean, Q/E giran, + y - acercan,
//   0 o Inicio reencuadran todo. Con aceleracion y frenado, no a saltos.
// - iman suave al angulo isometrico base cuando el giro queda a menos de SNAP_AZIMUTH.
// - la vista se recuerda entre recargas (localStorage VIEW_KEY) hasta que se reencuadra todo.
// - encuadra todo al cargar, vuela a una sala con focusRoom (HUD) o doble clic, y reencuadra todo con
//   doble clic en el vacio. El cursor cuenta lo que hace (data-cam / data-turn en la raiz de la escena).

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { MOUSE, type OrthographicCamera, TOUCH, Vector2, Vector3 } from 'three';
import { type HudInsets, useOfficeStore } from '@/state/store';
import { PLATFORM_H, ROOM_FOOTPRINT, type OfficeLayout, type RoomPlacement } from './layout';
import { roomHandledDoubleClickRecently } from './sceneEvents';

export const BASE_AZIMUTH = Math.PI / 4;
export const BASE_POLAR = (57 * Math.PI) / 180;
/** giro libre a cada lado del angulo base (decision de diseno: se puede girar mucho mas) */
export const AZIMUTH_RANGE = (85 * Math.PI) / 180;
/** inclinacion: mas arriba para ver la planta entera, mas abajo para una vista casi de calle */
export const POLAR_MIN = (46 * Math.PI) / 180;
export const POLAR_MAX = (64 * Math.PI) / 180;
export const CAMERA_DISTANCE = 60;
const PAN_MARGIN = 4;
/** a menos de esto del angulo base, el giro se asienta solo en la isometrica clasica */
export const SNAP_AZIMUTH = (3.5 * Math.PI) / 180;
export const VIEW_KEY = 'oficina.camara';

export function cameraOffset(azimuth = BASE_AZIMUTH, polar = BASE_POLAR, distance = CAMERA_DISTANCE): Vector3 {
  return new Vector3(
    Math.sin(polar) * Math.sin(azimuth),
    Math.cos(polar),
    Math.sin(polar) * Math.cos(azimuth),
  ).multiplyScalar(distance);
}

interface View {
  target: Vector3;
  zoom: number;
}

interface Pads {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** respaldo mientras el HUD aun no midio sus paneles */
function fallbackPads(width: number): Pads {
  if (width >= 1100) return { left: 330, right: 48, top: 96, bottom: 56 };
  if (width >= 768) return { left: 32, right: 32, top: 110, bottom: 48 };
  return { left: 16, right: 16, top: 120, bottom: 40 };
}

/** aire entre la oficina y los paneles del HUD */
const HUD_GAP = 16;

/** espacio libre: lo que el HUD dice que tapa (store.hudInsets) + aire */
export function hudPads(insets: HudInsets, width: number): Pads {
  const measured = insets.top + insets.right + insets.bottom + insets.left > 0;
  if (!measured) return fallbackPads(width);
  return {
    left: insets.left + HUD_GAP,
    right: insets.right + HUD_GAP,
    top: insets.top + HUD_GAP,
    bottom: insets.bottom + HUD_GAP,
  };
}

/**
 * Detalle de las etiquetas segun el zoom (px CSS por unidad del mundo). Poco texto por defecto: con varias
 * salas en pantalla van en pastilla (far = solo el nombre, mid = nombre y cronometro); la tarjeta completa
 * sale solo de cerca (near), donde los puestos quedan a mas de 270 px y las tarjetas no se pisan.
 */
export const ZOOM_MID = 70;
export const ZOOM_NEAR = 165;

export function zoomLevel(zoom: number): 'far' | 'mid' | 'near' {
  if (zoom < ZOOM_MID) return 'far';
  if (zoom < ZOOM_NEAR) return 'mid';
  return 'near';
}

// ---- logica pura de la camara (probada en test/camera.test.ts) ----

/**
 * Factor multiplicativo de zoom para un evento de rueda. Un paso de rueda de raton (100 px, o 3 lineas en
 * Firefox) acerca un 25 %; el trackpad manda deltas chicos y queda continuo. Ctrl+rueda es el pellizco
 * del trackpad: mas fino y con tope, para que un paso de raton con Ctrl no de un salto.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const perUnit = deltaMode === 1 ? 33 : deltaMode === 2 ? 100 : 1;
  const cap = ctrlKey ? 50 : 120;
  const px = Math.max(-cap, Math.min(cap, deltaY * perUnit));
  return Math.exp(-px * (ctrlKey ? 0.006 : 0.0022));
}

/**
 * Corrimiento del objetivo, en las direcciones derecha y arriba de la camara, para que el punto del mundo
 * bajo el puntero no se mueva al cambiar el zoom. ax/ay = puntero respecto al centro de la pantalla, en px
 * CSS (derecha y arriba positivos). Camara ortografica: 1 px = 1/zoom unidades del mundo.
 */
export function anchoredZoomShift(zoomFrom: number, zoomTo: number, ax: number, ay: number): { right: number; up: number } {
  const k = 1 / zoomFrom - 1 / zoomTo;
  return { right: ax * k, up: ay * k };
}

/** angulo de giro asentado: dentro del iman va al base; nunca fuera del rango */
export function settleAzimuth(azimuth: number): number {
  const clamped = Math.min(BASE_AZIMUTH + AZIMUTH_RANGE, Math.max(BASE_AZIMUTH - AZIMUTH_RANGE, azimuth));
  return Math.abs(clamped - BASE_AZIMUTH) < SNAP_AZIMUTH ? BASE_AZIMUTH : clamped;
}

export interface SavedView {
  x: number;
  y: number;
  z: number;
  zoom: number;
  azimuth: number;
  polar: number;
}

const VIEW_FIELDS = ['x', 'y', 'z', 'zoom', 'azimuth', 'polar'] as const;

/** lectura tolerante de la vista guardada: cualquier campo raro la descarta entera */
export function parseSavedView(raw: string | null | undefined): SavedView | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: Partial<SavedView> = {};
  for (const k of VIEW_FIELDS) {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    out[k] = n;
  }
  const view = out as SavedView;
  return view.zoom > 0 ? view : null;
}

export type CameraKey =
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'turn'; dir: number }
  | { kind: 'zoom'; dir: number }
  | { kind: 'all' };

const PAN_KEYS: Readonly<Record<string, [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

/** tecla -> accion de camara; las letras del HUD (H, A, F) no entran */
export function cameraKey(key: string): CameraKey | null {
  const pan = PAN_KEYS[key];
  if (pan) return { kind: 'pan', x: pan[0], y: pan[1] };
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (k === 'q') return { kind: 'turn', dir: 1 };
  if (k === 'e') return { kind: 'turn', dir: -1 };
  if (k === '+' || k === '=') return { kind: 'zoom', dir: 1 };
  if (k === '-' || k === '_') return { kind: 'zoom', dir: -1 };
  if (k === '0' || k === 'Home') return { kind: 'all' };
  return null;
}

// ---- encuadres ----

const tmpRight = new Vector3();
const tmpUp = new Vector3();
const tmpCorner = new Vector3();
const tmpMove = new Vector3();

/** Zoom y objetivo que encuadran una caja en el area libre de la pantalla */
function fitBox(min: Vector3, max: Vector3, camera: OrthographicCamera, width: number, height: number, pads: Pads): View {
  tmpRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  tmpUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  let rMin = Infinity;
  let rMax = -Infinity;
  let uMin = Infinity;
  let uMax = -Infinity;
  for (let i = 0; i < 8; i++) {
    tmpCorner.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
    const r = tmpCorner.dot(tmpRight);
    const u = tmpCorner.dot(tmpUp);
    rMin = Math.min(rMin, r);
    rMax = Math.max(rMax, r);
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
  }
  const availW = Math.max(120, width - pads.left - pads.right);
  const availH = Math.max(120, height - pads.top - pads.bottom);
  const zoom = Math.min(availW / Math.max(0.1, rMax - rMin), availH / Math.max(0.1, uMax - uMin));
  const target = min.clone().add(max).multiplyScalar(0.5);
  target.addScaledVector(tmpRight, -((pads.left - pads.right) / 2) / zoom);
  target.addScaledVector(tmpUp, ((pads.top - pads.bottom) / 2) / zoom);
  return { target, zoom };
}

function officeBox(layout: OfficeLayout): [Vector3, Vector3] {
  const b = layout.bounds;
  return [new Vector3(b.minX, -0.5, b.minZ), new Vector3(b.maxX, 1.9, b.maxZ)];
}

function roomBox(room: RoomPlacement): [Vector3, Vector3] {
  const f = ROOM_FOOTPRINT;
  return [
    new Vector3(room.center.x + f.minX - 0.4, 0, room.center.z + f.minZ),
    new Vector3(room.center.x + f.maxX, 2.1 + PLATFORM_H, room.center.z + f.maxZ + 0.4),
  ];
}

interface Flight {
  fromTarget: Vector3;
  toTarget: Vector3;
  fromZoom: number;
  toZoom: number;
  t: number;
  duration: number;
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** suavizado exponencial independiente del frame rate: fraccion del camino que se recorre en dt */
function smooth(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** velocidad de paneo con teclado (px CSS por segundo), giro (rad/s) y zoom (factor por segundo, en log) */
const KEY_PAN_SPEED = 1100;
const KEY_TURN_SPEED = 1.5;
const KEY_ZOOM_SPEED = 1.7;

export function CameraRig({ layout }: { layout: OfficeLayout }) {
  const controls = useRef<OrbitControlsImpl | null>(null);
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  const gl = useThree((s) => s.gl);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const flight = useRef<Flight | null>(null);
  const userMoved = useRef(false);
  const initialized = useRef(false);
  const level = useRef<string | null>(null);
  const dragging = useRef(false);
  /** zoom al que va la rueda (o las teclas), con el punto de pantalla que debe quedarse quieto */
  const zoomGoal = useRef<number | null>(null);
  const anchor = useRef({ x: 0, y: 0 });
  const keys = useRef(new Set<string>());
  const panVel = useRef(new Vector2());
  const turnVel = useRef(0);
  const saveTimer = useRef<number | null>(null);
  const focus = useOfficeStore((s) => s.focus);
  const insets = useOfficeStore((s) => s.hudInsets);
  const pads = useMemo(() => hudPads(insets, width), [insets, width]);
  const prevPads = useRef<Pads>(pads);

  const allView = useCallback(() => {
    const [min, max] = officeBox(layout);
    return fitBox(min, max, camera, width, height, pads);
  }, [layout, camera, width, height, pads]);

  const limits = useMemo(() => {
    const all = allView().zoom;
    const first = layout.rooms[0];
    const room = first ? fitBox(...roomBox(first), camera, width, height, pads).zoom : all;
    return { min: Math.min(all * 0.6, room * 0.5), max: Math.max(room * 2.6, all * 2) };
  }, [allView, layout, camera, width, height, pads]);

  // la vista elegida se guarda al terminar cada gesto; reencuadrar todo la olvida
  const saveView = useCallback(() => {
    const c = controls.current;
    if (!c) return;
    try {
      if (!userMoved.current) {
        localStorage.removeItem(VIEW_KEY);
        return;
      }
      const view: SavedView = {
        x: c.target.x,
        y: c.target.y,
        z: c.target.z,
        zoom: camera.zoom,
        azimuth: c.getAzimuthalAngle(),
        polar: c.getPolarAngle(),
      };
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      // sin almacenamiento (privado, bloqueado): la vista simplemente no se recuerda
    }
  }, [camera]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      saveView();
    }, 400);
  }, [saveView]);

  const flyTo = useCallback(
    (view: View, duration: number) => {
      const c = controls.current;
      if (!c) return;
      zoomGoal.current = null;
      if (duration <= 0) {
        const offset = camera.position.clone().sub(c.target);
        c.target.copy(view.target);
        camera.position.copy(view.target).add(offset);
        camera.zoom = view.zoom;
        camera.updateProjectionMatrix();
        c.update();
        flight.current = null;
        return;
      }
      flight.current = {
        fromTarget: c.target.clone(),
        toTarget: view.target,
        fromZoom: camera.zoom,
        toZoom: view.zoom,
        t: 0,
        duration,
      };
    },
    [camera],
  );

  /** gira la camara alrededor del objetivo (OrbitControls relee la posicion en su proximo update) */
  const turnBy = useCallback(
    (delta: number) => {
      const c = controls.current;
      if (!c || delta === 0) return;
      const offset = camera.position.clone().sub(c.target);
      const len = offset.length();
      const theta = clamp(Math.atan2(offset.x, offset.z) + delta, BASE_AZIMUTH - AZIMUTH_RANGE, BASE_AZIMUTH + AZIMUTH_RANGE);
      const phi = Math.acos(clamp(offset.y / len, -1, 1));
      camera.position.copy(c.target).add(cameraOffset(theta, phi, len));
      camera.lookAt(c.target);
    },
    [camera],
  );

  /** zoom con el punto 'anchor' de la pantalla quieto */
  const applyZoom = useCallback(
    (next: number) => {
      const c = controls.current;
      if (!c || next === camera.zoom) return;
      const shift = anchoredZoomShift(camera.zoom, next, anchor.current.x, anchor.current.y);
      tmpRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      tmpUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
      tmpMove.set(0, 0, 0).addScaledVector(tmpRight, shift.right).addScaledVector(tmpUp, shift.up);
      c.target.add(tmpMove);
      camera.position.add(tmpMove);
      camera.zoom = next;
      camera.updateProjectionMatrix();
    },
    [camera],
  );

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    c.minZoom = limits.min;
    c.maxZoom = limits.max;
  }, [limits]);

  // primer encuadre: la vista recordada si la hay, si no todo; luego reencuadra al cambiar la grilla o
  // la ventana (si el usuario no movio la camara por su cuenta)
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      let saved: SavedView | null = null;
      try {
        saved = parseSavedView(localStorage.getItem(VIEW_KEY));
      } catch {
        saved = null;
      }
      const c = controls.current;
      if (saved && c) {
        userMoved.current = true;
        c.target.set(saved.x, saved.y, saved.z);
        const azimuth = settleAzimuth(saved.azimuth);
        const polar = clamp(saved.polar, POLAR_MIN, POLAR_MAX);
        camera.position.copy(c.target).add(cameraOffset(azimuth, polar));
        camera.lookAt(c.target);
        camera.zoom = clamp(saved.zoom, limits.min, limits.max);
        camera.updateProjectionMatrix();
        c.update();
        return;
      }
      flyTo(allView(), 0);
      return;
    }
    if (!userMoved.current) flyTo(allView(), 0.9);
  }, [layout.key, width, height]); // eslint-disable-line react-hooks/exhaustive-deps

  // al abrirse/cerrarse un panel del HUD (D5: 320 ms, curva "cambiar"): sin mover la camara a mano
  // se reencuadra todo; si el usuario ya eligio su vista, se conserva el zoom y solo se corre el centro
  useEffect(() => {
    const old = prevPads.current;
    prevPads.current = pads;
    if (!initialized.current) return;
    const c = controls.current;
    if (!c) return;
    if (!userMoved.current) {
      flyTo(allView(), 0.32);
      return;
    }
    const dx = (pads.left - pads.right - (old.left - old.right)) / 2;
    const dy = (pads.top - pads.bottom - (old.top - old.bottom)) / 2;
    if (dx === 0 && dy === 0) return;
    tmpRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    tmpUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const target = c.target.clone().addScaledVector(tmpRight, -dx / camera.zoom).addScaledVector(tmpUp, dy / camera.zoom);
    flyTo({ target, zoom: camera.zoom }, 0.32);
  }, [pads]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!focus) return;
    const room = layout.byId.get(focus.roomId);
    if (!room) return;
    userMoved.current = true;
    const [min, max] = roomBox(room);
    flyTo(fitBox(min, max, camera, width, height, pads), 0.85);
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = gl.domElement;
    const onDouble = () => {
      window.setTimeout(() => {
        if (roomHandledDoubleClickRecently()) return;
        userMoved.current = false;
        flyTo(allView(), 0.8);
        saveView();
      }, 0);
    };
    el.addEventListener('dblclick', onDouble);
    return () => el.removeEventListener('dblclick', onDouble);
  }, [gl, flyTo, allView, saveView]);

  // rueda: zoom suave hacia el puntero. Se toma en captura sobre la raiz de la escena para que no llegue
  // al zoom a saltos de OrbitControls (el pellizco tactil sigue siendo de OrbitControls)
  useEffect(() => {
    const el = gl.domElement;
    const root = (el.closest('[data-office-scene]') as HTMLElement | null) ?? el.parentElement ?? el;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      anchor.current = { x: e.clientX - rect.left - rect.width / 2, y: rect.height / 2 - (e.clientY - rect.top) };
      const from = zoomGoal.current ?? camera.zoom;
      zoomGoal.current = clamp(from * wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey), limits.min, limits.max);
      userMoved.current = true;
      flight.current = null;
      scheduleSave();
    };
    root.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => root.removeEventListener('wheel', onWheel, { capture: true });
  }, [gl, camera, limits, scheduleSave]);

  // el cursor cuenta el gesto: grab en reposo, grabbing al panear, girar con el boton derecho o Ctrl
  useEffect(() => {
    const el = gl.domElement;
    const root = el.closest('[data-office-scene]') as HTMLElement | null;
    if (!root) return;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const turn = e.button === 2 || (e.button === 0 && (e.ctrlKey || e.metaKey || e.shiftKey));
      root.dataset.cam = turn ? 'turn' : e.button === 0 ? 'pan' : 'zoom';
    };
    const onUp = () => delete root.dataset.cam;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Control' && e.key !== 'Meta') return;
      if (e.type === 'keydown') root.dataset.turn = '';
      else delete root.dataset.turn;
    };
    const onBlur = () => {
      delete root.dataset.cam;
      delete root.dataset.turn;
    };
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
      onBlur();
    };
  }, [gl]);

  // teclado: solo con el foco en la escena (body o la raiz), sin modificadores y sin un modal abierto. Se
  // decide un tick despues para que el HUD tenga la ultima palabra (las flechas con la lista de salas)
  useEffect(() => {
    const root = gl.domElement.closest('[data-office-scene]');
    const inScene = (target: EventTarget | null) =>
      target === document.body || target === document.documentElement || (root !== null && target instanceof Node && root.contains(target));
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || isTypingTarget(e.target) || !inScene(e.target)) return;
      const action = cameraKey(e.key);
      if (!action) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      window.setTimeout(() => {
        if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
        if (action.kind === 'all') {
          userMoved.current = false;
          flyTo(allView(), 0.8);
          saveView();
          return;
        }
        keys.current.add(key);
        userMoved.current = true;
        flight.current = null;
      }, 0);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (keys.current.delete(key)) scheduleSave();
    };
    const onBlur = () => keys.current.clear();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      keys.current.clear();
    };
  }, [gl, flyTo, allView, saveView, scheduleSave]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  useFrame((_, rawDt) => {
    const c = controls.current;
    if (!c) return;
    const dt = Math.min(rawDt, 0.05);

    const f = flight.current;
    if (f) {
      f.t = Math.min(1, f.t + dt / f.duration);
      const e = easeInOutCubic(f.t);
      const next = f.fromTarget.clone().lerp(f.toTarget, e);
      const delta = next.sub(c.target);
      c.target.add(delta);
      camera.position.add(delta);
      camera.zoom = Math.exp(Math.log(f.fromZoom) + (Math.log(f.toZoom) - Math.log(f.fromZoom)) * e);
      camera.updateProjectionMatrix();
      if (f.t >= 1) {
        flight.current = null;
        scheduleSave();
      }
    }

    // teclas: paneo por el piso y giro con aceleracion y frenado; +/- empujan el zoom hacia el centro
    let wx = 0;
    let wy = 0;
    let wt = 0;
    let wz = 0;
    for (const k of keys.current) {
      const a = cameraKey(k);
      if (!a) continue;
      if (a.kind === 'pan') {
        wx += a.x;
        wy += a.y;
      } else if (a.kind === 'turn') wt += a.dir;
      else if (a.kind === 'zoom') wz += a.dir;
    }
    const wl = Math.hypot(wx, wy);
    if (wl > 0) {
      wx /= wl;
      wy /= wl;
    }
    const pv = panVel.current;
    const kPan = smooth(dt, 0.1);
    pv.x += (wx * KEY_PAN_SPEED - pv.x) * kPan;
    pv.y += (wy * KEY_PAN_SPEED - pv.y) * kPan;
    if (Math.abs(pv.x) + Math.abs(pv.y) > 1) {
      tmpRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      tmpRight.y = 0;
      tmpRight.normalize();
      tmpUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
      tmpUp.y = 0;
      tmpUp.normalize();
      const s = dt / camera.zoom;
      tmpMove.set(0, 0, 0).addScaledVector(tmpRight, pv.x * s).addScaledVector(tmpUp, pv.y * s);
      c.target.add(tmpMove);
      camera.position.add(tmpMove);
    }
    turnVel.current += (wt * KEY_TURN_SPEED - turnVel.current) * smooth(dt, 0.12);
    if (Math.abs(turnVel.current) > 1e-3) turnBy(turnVel.current * dt);
    if (wz !== 0) {
      anchor.current = { x: 0, y: 0 };
      zoomGoal.current = clamp((zoomGoal.current ?? camera.zoom) * Math.exp(wz * KEY_ZOOM_SPEED * dt), limits.min, limits.max);
    }

    // zoom con inercia hacia la meta de la rueda o las teclas
    const goal = zoomGoal.current;
    if (goal !== null) {
      const lg = Math.log(goal / camera.zoom);
      if (Math.abs(lg) < 0.0015) {
        applyZoom(goal);
        zoomGoal.current = null;
      } else {
        applyZoom(camera.zoom * Math.exp(lg * smooth(dt, 0.09)));
      }
    }

    // iman al angulo isometrico base: solo cuando nadie esta girando
    if (!dragging.current && wt === 0 && Math.abs(turnVel.current) <= 1e-3 && !flight.current) {
      const d = BASE_AZIMUTH - c.getAzimuthalAngle();
      if (d !== 0 && Math.abs(d) < SNAP_AZIMUTH) turnBy(Math.abs(d) < 1e-4 ? d : d * smooth(dt, 0.12));
    }

    const b = layout.bounds;
    const tx = Math.min(b.maxX + PAN_MARGIN, Math.max(b.minX - PAN_MARGIN, c.target.x));
    const tz = Math.min(b.maxZ + PAN_MARGIN, Math.max(b.minZ - PAN_MARGIN, c.target.z));
    if (tx !== c.target.x || tz !== c.target.z) {
      camera.position.x += tx - c.target.x;
      camera.position.z += tz - c.target.z;
      c.target.x = tx;
      c.target.z = tz;
    }
    const next = zoomLevel(camera.zoom);
    if (next !== level.current) {
      level.current = next;
      gl.domElement.closest('[data-office-scene]')?.setAttribute('data-zoom', next);
    }
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.09}
      rotateSpeed={0.45}
      panSpeed={0.9}
      zoomSpeed={0.9}
      zoomToCursor
      screenSpacePanning={false}
      minPolarAngle={POLAR_MIN}
      maxPolarAngle={POLAR_MAX}
      minAzimuthAngle={BASE_AZIMUTH - AZIMUTH_RANGE}
      maxAzimuthAngle={BASE_AZIMUTH + AZIMUTH_RANGE}
      mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }}
      touches={{ ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE }}
      onStart={() => {
        dragging.current = true;
        userMoved.current = true;
        flight.current = null;
        zoomGoal.current = null;
      }}
      onEnd={() => {
        dragging.current = false;
        scheduleSave();
      }}
    />
  );
}
