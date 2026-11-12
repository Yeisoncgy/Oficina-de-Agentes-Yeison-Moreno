import { useCallback, useEffect, useRef, useState } from 'react';
import type { LeadNameRequest, LeadNameResponse } from '@shared/contract';
import { ApiError, describeApiError } from './api';
import { useOfficeStore } from './store';

// Nombre del lead que elige el usuario. La web no lo guarda: lo que se ve llega en snapshot.leadName (SSE),
// que el server reenvia en cuanto cambia. Mismo patron de fetch que notesApi.
// Excepcion: la respuesta del PUT ya es lo que el server guardo y se copia al snapshot. Con el SSE caido o
// reconectando, la bienvenida se quedaria abierta sin decir que el nombre ya se guardo.

/** el 400 trae {error} en espanol ("Escribe un nombre"); sin ese texto queda uno propio */
async function rejectionMessage(response: Response): Promise<string> {
  try {
    const data: unknown = await response.json();
    if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error) {
      return data.error;
    }
  } catch {
    // sin cuerpo JSON
  }
  return 'Escribe un nombre válido.';
}

/** PUT /api/settings/lead-name; responde el nombre ya limpio (el server corta y junta espacios) */
export async function saveLeadName(name: string): Promise<LeadNameResponse> {
  const body: LeadNameRequest = { name };
  let response: Response;
  try {
    response = await fetch('/api/settings/lead-name', {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Sin conexión con el servidor');
  }
  if (response.status === 400) throw new ApiError(400, await rejectionMessage(response));
  if (!response.ok) throw new ApiError(response.status, `El servidor respondió ${response.status}`);
  return (await response.json()) as LeadNameResponse;
}

/** texto para el usuario: el 400 dice que falta el nombre; lo demas nombra el problema como el resto del HUD */
export function leadNameError(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) return error.message;
  return describeApiError(error);
}

/** si el SSE ya trajo el mismo nombre no toca el store: la escena entera se suscribe al snapshot */
function applyLeadName(name: string | null): void {
  if (name === null) return;
  useOfficeStore.setState((s) =>
    s.snapshot && s.snapshot.leadName !== name ? { snapshot: { ...s.snapshot, leadName: name } } : s,
  );
}

export interface SaveLeadName {
  /** true si el server lo guardo; el nombre guardado ya queda en el snapshot, sin esperar al SSE */
  save: (name: string) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  clearError: () => void;
}

export function useSaveLeadName(): SaveLeadName {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // el SSE puede traer el nombre antes que la respuesta del PUT y desmontar el dialogo que espera
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const save = useCallback(async (name: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const saved = await saveLeadName(name);
      applyLeadName(saved.name);
      return true;
    } catch (err) {
      if (mounted.current) setError(leadNameError(err));
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { save, busy, error, clearError };
}
