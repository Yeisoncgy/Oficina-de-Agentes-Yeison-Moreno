import { useEffect, useRef } from 'react';
import { BOOT_WINDOW_MS } from '@/lib/motion';
import { useOfficeStore } from '@/state/store';
import { readTourSeen } from './seen';
import { Tour } from './Tour';
import { Welcome } from './Welcome';

/** el snapshot pide nombre: server con leadName null y fuera del demo (en el demo no hay donde guardarlo) */
export function useNeedsLeadName(): boolean {
  return useOfficeStore((s) => !s.demo && s.snapshot?.leadName === null);
}

/**
 * Primer arranque: pide el nombre del lead y, al guardarlo, arranca la guia si no se vio. En el demo la
 * guia arranca sola al cargar, si no se vio. Tambien monta el dialogo para cambiar el nombre.
 */
export function Onboarding() {
  const needsName = useNeedsLeadName();
  const editing = useOfficeStore((s) => s.nameEditOpen && !s.demo);
  const demo = useOfficeStore((s) => s.demo);
  const hasSnapshot = useOfficeStore((s) => s.snapshot !== null);

  // leadName paso de null a un nombre: lo acaba de elegir el usuario (en esta pestana o en otra). Sin
  // espera: entre el dialogo y la guia se asomaria la pista inicial
  const neededName = useRef(needsName);
  useEffect(() => {
    const was = neededName.current;
    neededName.current = needsName;
    if (was && !needsName && !readTourSeen()) useOfficeStore.getState().openTour();
  }, [needsName]);

  // demo: espera a que termine la entrada del HUD para no resaltar paneles que todavia se mueven
  useEffect(() => {
    if (!demo || !hasSnapshot || readTourSeen()) return;
    const id = window.setTimeout(() => {
      const s = useOfficeStore.getState();
      if (!s.tourOpen && !readTourSeen()) s.openTour();
    }, BOOT_WINDOW_MS);
    return () => window.clearTimeout(id);
  }, [demo, hasSnapshot]);

  return (
    <>
      {needsName ? <Welcome mode="first" /> : editing ? <Welcome mode="edit" /> : null}
      <Tour />
    </>
  );
}
