import { useEffect } from 'react';
import { createMockSnapshot } from '@/scene/mock';
import {
  backoffDelay,
  connectionAfterFailure,
  isDemoMode,
  isSnapshot,
  parseSnapshot,
  STREAM_SILENCE_MS,
} from '@/lib/stream';
import { serverNow, useOfficeStore } from './store';

const DEMO_TICK_MS = 1_000;

/** Alimenta el store: SSE del server con reconexion, o snapshot simulado con ?demo=1 */
export function useOfficeStream(): void {
  useEffect(() => {
    if (isDemoMode(window.location.search)) return startDemo();
    return startLiveStream();
  }, []);
}

function startDemo(): () => void {
  const store = useOfficeStore.getState();
  store.setDemo(true);
  const tick = () => useOfficeStore.getState().setSnapshot(createMockSnapshot(serverNow()));
  tick();
  store.setConnection('live');
  const id = window.setInterval(tick, DEMO_TICK_MS);
  return () => window.clearInterval(id);
}

function startLiveStream(): () => void {
  const { setSnapshot, setConnection } = useOfficeStore.getState();
  let disposed = false;
  let source: EventSource | null = null;
  let failures = 0;
  let retryTimer: number | undefined;
  let silenceTimer: number | undefined;

  function armSilenceWatch(): void {
    window.clearTimeout(silenceTimer);
    silenceTimer = window.setTimeout(fail, STREAM_SILENCE_MS);
  }

  function markLive(): void {
    failures = 0;
    setConnection('live');
    armSilenceWatch();
  }

  function connect(): void {
    if (disposed) return;
    source?.close();
    const es = new EventSource('/api/stream');
    source = es;
    es.onopen = markLive;
    es.addEventListener('snapshot', (event) => {
      const snapshot = parseSnapshot((event as MessageEvent<unknown>).data);
      if (snapshot) setSnapshot(snapshot);
      markLive();
    });
    es.addEventListener('ping', armSilenceWatch);
    es.onerror = () => {
      if (source === es) fail();
    };
  }

  function fail(): void {
    if (disposed) return;
    source?.close();
    source = null;
    window.clearTimeout(silenceTimer);
    window.clearTimeout(retryTimer);
    failures += 1;
    setConnection(connectionAfterFailure(failures));
    retryTimer = window.setTimeout(connect, backoffDelay(failures));
  }

  function reconnectNow(): void {
    if (disposed) return;
    failures = 0;
    window.clearTimeout(retryTimer);
    setConnection('connecting');
    connect();
  }

  // Primer pintado rapido: la foto actual llega antes que el primer evento del stream.
  fetch('/api/office', { headers: { Accept: 'application/json' } })
    .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
    .then((data) => {
      if (!disposed && isSnapshot(data) && !useOfficeStore.getState().snapshot) setSnapshot(data);
    })
    .catch(() => undefined);

  connect();

  const unsubscribe = useOfficeStore.subscribe((state, prev) => {
    if (state.reconnectNonce !== prev.reconnectNonce) reconnectNow();
  });

  return () => {
    disposed = true;
    unsubscribe();
    source?.close();
    window.clearTimeout(retryTimer);
    window.clearTimeout(silenceTimer);
  };
}
