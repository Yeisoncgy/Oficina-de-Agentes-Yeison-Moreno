import type { Ingestor } from './parser';
import { pathKey, type FileTarget } from './paths';

export interface QueueHooks {
  /** despues de un lote con cambios (y cada `batchEvery` archivos durante un backfill largo) */
  onBatch: () => void;
  onFileDone?: () => void;
  onError?: (err: unknown) => void;
}

/**
 * Cola unica de ingesta: los archivos se procesan de a uno (nunca dos lectores sobre el mismo
 * offset). Si un archivo ya esta pendiente no se duplica.
 */
export class IngestQueue {
  private readonly pending = new Map<string, FileTarget>();
  private running = false;
  private closed = false;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly ingestor: Ingestor,
    private readonly hooks: QueueHooks,
    private readonly batchEvery = 50,
  ) {}

  /** true mientras hay un archivo a medio leer (sus filas aun no estan completas) */
  /** archivos en cola por leer */
  get size(): number {
    return this.pending.size;
  }

  get busy(): boolean {
    return this.running;
  }

  enqueue(target: FileTarget): void {
    if (this.closed) return;
    const key = pathKey(target.path);
    if (!this.pending.has(key)) this.pending.set(key, target);
    if (!this.running) void this.run();
  }

  enqueueAll(targets: FileTarget[]): void {
    for (const t of targets) this.enqueue(t);
  }

  /** resuelve cuando la cola queda vacia */
  idle(): Promise<void> {
    if (!this.running && this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
  }

  private async run(): Promise<void> {
    this.running = true;
    let changed = false;
    let sinceBatch = 0;
    try {
      while (!this.closed && this.pending.size > 0) {
        const next = this.pending.entries().next().value;
        if (!next) break;
        const [key, target] = next;
        this.pending.delete(key);
        try {
          const n = await this.ingestor.ingest(target);
          if (n > 0) changed = true;
        } catch (err) {
          this.hooks.onError?.(err);
        }
        this.hooks.onFileDone?.();
        sinceBatch++;
        if (changed && sinceBatch >= this.batchEvery) {
          this.safeBatch();
          changed = false;
          sinceBatch = 0;
        }
      }
      if (changed && !this.closed) this.safeBatch();
    } finally {
      this.running = false;
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    }
  }

  private safeBatch(): void {
    try {
      this.hooks.onBatch();
    } catch (err) {
      this.hooks.onError?.(err);
    }
  }
}
