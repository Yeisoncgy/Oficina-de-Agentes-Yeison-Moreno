// Luz del Kit 3D (createEnvironment): un sol/luna direccional con sombras duras y una hemisferica que
// tine las sombras de indigo (nunca negras). El sol siempre entra por detras de la pared del fondo:
// de dia recorre un arco y proyecta el ventanal sobre el piso; de noche la luna queda fija.
// Ademas de la luz, este componente avanza el ambiente (lamparas, pantallas, cielo) una vez por frame.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { DirectionalLight } from 'three';
import { useDayState } from './daylight';
import type { OfficeLayout } from './layout';
import { animateWorld, applyDay } from './materials';
import { updateAmbient } from './world/ambient';

const SUN_DISTANCE = 40;

export function Lighting({ layout }: { layout: OfficeLayout }) {
  const day = useDayState();
  const sun = useRef<DirectionalLight>(null);

  useEffect(() => applyDay(day), [day]);

  // prioridad negativa: corre antes que cualquier otro useFrame que lea el ambiente
  useFrame(({ clock }) => {
    updateAmbient(clock.elapsedTime, day);
    animateWorld();
  }, -1);

  useLayoutEffect(() => {
    const light = sun.current;
    if (!light) return;
    const { bounds } = layout;
    const radius = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2 + 2;
    const cam = light.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 1;
    cam.far = SUN_DISTANCE + radius * 2;
    cam.updateProjectionMatrix();
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.bias = -0.0008;
    light.shadow.normalBias = 0.02;
    light.shadow.needsUpdate = true;
  }, [layout]);

  const d = day.sunDirection;
  return (
    <>
      <hemisphereLight color={day.hemiSky} groundColor={day.hemiGround} intensity={day.hemiIntensity} />
      <directionalLight
        ref={sun}
        castShadow
        position={[d.x * SUN_DISTANCE, d.y * SUN_DISTANCE, d.z * SUN_DISTANCE]}
        color={day.sunColor}
        intensity={day.sunIntensity}
      />
    </>
  );
}
