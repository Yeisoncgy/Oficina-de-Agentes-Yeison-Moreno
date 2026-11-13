import type { ServerResponse } from 'node:http';
import type { OfficeSnapshot } from '@shared/contract';
import { TIMING } from '../config';

function sameKey(snapshot: OfficeSnapshot): string {
  return JSON.stringify({ ...snapshot, generatedAt: '' });
}

function write(res: ServerResponse, event: string, data: unknown): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** clientes SSE: manda el snapshot solo cuando cambia (ignorando generatedAt) */
export class SnapshotHub {
  private readonly clients = new Set<ServerResponse>();
  private lastKey: string | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private ping: NodeJS.Timeout | null = null;

  constructor(private readonly build: () => OfficeSnapshot) {}

  get size(): number {
    return this.clients.size;
  }

  add(res: ServerResponse): void {
    this.clients.add(res);
    const snap = this.build();
    const key = sameKey(snap);
    if (key !== this.lastKey) {
      // si cambio desde el ultimo envio, lo reciben todos (no solo el nuevo)
      this.lastKey = key;
      this.sendAll('snapshot', snap);
    } else {
      write(res, 'snapshot', snap);
    }
  }

  remove(res: ServerResponse): void {
    this.clients.delete(res);
  }

  /** tras ingerir: espera 250 ms para juntar rafagas */
  notifyChanged(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.broadcastIfChanged();
    }, TIMING.debounceMs);
  }

  broadcastIfChanged(): void {
    if (this.clients.size === 0) return;
    const snap = this.build();
    const key = sameKey(snap);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.sendAll('snapshot', snap);
  }

  startPing(): void {
    if (this.ping) return;
    this.ping = setInterval(() => this.sendAll('ping', {}), TIMING.pingMs);
    this.ping.unref();
  }

  close(): void {
    if (this.debounce) clearTimeout(this.debounce);
    if (this.ping) clearInterval(this.ping);
    this.debounce = null;
    this.ping = null;
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // la conexion ya estaba cerrada
      }
    }
    this.clients.clear();
  }

  private sendAll(event: string, data: unknown): void {
    for (const res of [...this.clients]) {
      if (!write(res, event, data)) this.clients.delete(res);
    }
  }
}
