import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { FSWatcher } from 'chokidar';
import { TIMING } from './config';
import type { Db } from './db/connection';
import { RulesService } from './habits/rules';
import { HabitsService } from './habits/service';
import { Ingestor } from './ingest/parser';
import { PriceBook } from './ingest/priceBook';
import { IngestQueue } from './ingest/queue';
import { Reconciler } from './ingest/reconcile';
import { RoleStore } from './ingest/roleStore';
import { discoverTargets, findProjectDir, sessionTargets } from './ingest/scanner';
import { startWatcher } from './ingest/watcher';
import { registerExtrasRoutes } from './routes/extras';
import { registerHabitsRoutes } from './routes/habits';
import { HistoryService, registerHistoryRoutes } from './routes/history';
import { registerInsightsRoutes } from './routes/insights';
import { registerNotesRoutes } from './routes/notes';
import { registerOfficeRoutes, type HealthStatus } from './routes/office';
import { registerSettingsRoutes } from './routes/settings';
import { registerTranscriptRoutes, TranscriptService } from './routes/transcript';
import { BudgetWatch } from './state/budgetWatch';
import { Extras } from './state/extras';
import { WorkflowForecaster } from './state/forecast';
import { NO_NOTIFIER, type Notifier } from './state/notifier';
import { Watchdog } from './state/watchdog';
import { SnapshotHub } from './state/hub';
import { OfficeBuilder } from './state/office';
import { RoomNotes } from './state/roomNotes';
import { SessionRegistry } from './state/sessions';
import { Settings } from './state/settings';
import { CostBaselines } from './state/simulator';

export interface AppContext {
  db: Db;
  claudeHome: string;
  now: () => number;
  log: (msg: string) => void;
  registry: SessionRegistry;
  ingestor: Ingestor;
  queue: IngestQueue;
  reconciler: Reconciler;
  office: OfficeBuilder;
  hub: SnapshotHub;
  history: HistoryService;
  transcripts: TranscriptService;
  roomNotes: RoomNotes;
  rules: RulesService;
  /** motor de habitos: alertas vivas del snapshot y hallazgos del panel */
  habits: HabitsService;
  /** percentiles de costo por rol y modelo (simulador y pronostico de flujos) */
  baselines: CostBaselines;
  status: HealthStatus;
  /** precios vigentes: del usuario, de la tabla, aprendidos y por familia */
  priceBook: PriceBook;
  /** estado vivo del presupuesto del mes */
  budgetWatch: BudgetWatch;
  extras: Extras;
  watchdog: Watchdog;
  settings: Settings;
  startedAt: number;
  /** apaga el proceso; lo pone index.ts (en pruebas queda en null) */
  shutdown: (() => void) | null;
  /** reconcilia fines de subagentes/turnos y avisa a los clientes SSE */
  settle: () => void;
  /** algo que cambia costos o umbrales cambio: recalcula presupuesto y alertas y avisa a las pestanas */
  recompute: () => void;
}

export interface ContextOptions {
  db: Db;
  claudeHome: string;
  now?: () => number;
  log?: (msg: string) => void;
  /** avisos del sistema operativo; sin el (pruebas) no sale ninguno */
  notifier?: Notifier;
}

export function createContext(opts: ContextOptions): AppContext {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const registry = new SessionRegistry(opts.claudeHome, opts.db);
  // antes de leer nada: los precios del usuario y los aprendidos quedan activos, y si la tabla cambio desde la
  // ultima vez el historial se recotiza desde la base
  const priceBook = new PriceBook(opts.db);
  const repriced = priceBook.start();
  if (repriced > 0) log(`[precios] ${repriced} llamadas recotizadas`);
  const ingestor = new Ingestor(opts.db);
  const reconciler = new Reconciler(opts.db, ingestor.tasks);
  const office = new OfficeBuilder(opts.db, registry, now);
  const settings = new Settings(opts.db);
  const history = new HistoryService(opts.db);
  const budgetWatch = new BudgetWatch(history, now);
  const rules = new RulesService(opts.db, now, () => budgetWatch.caps());
  rules.setSystemSource(() => settings.system());
  const habits = new HabitsService({
    db: opts.db,
    clock: now,
    rules,
    openIds: () => registry.openIds(now()),
    busyIds: () => registry.busyIds(now()),
    personaName: (agentId) => office.personaNameOf(agentId),
  });
  const baselines = new CostBaselines(opts.db, now);
  office.setAlertsProvider(habits);
  office.setForecaster(
    new WorkflowForecaster({ db: opts.db, clock: now, rules, baselines, available: () => budgetWatch.caps().remainingUsd }),
  );
  office.setBudgetSource(() => budgetWatch.status());
  const hub = new SnapshotHub(() => office.build());
  const status: HealthStatus = { backfill: 'pendiente', filesTotal: 0, filesDone: 0 };
  const extras = new Extras({
    db: opts.db,
    clock: now,
    budget: (month, t) => history.budget(month, t),
    isOpen: (sessionId, t) => registry.isOpen(sessionId, t),
    personaName: (agentId) => office.personaNameOf(agentId),
    habits: (range) => habits.findings(range),
  });
  const watchdog = new Watchdog({
    settings,
    budget: () => budgetWatch.status(),
    snapshot: () => office.build(),
    clients: () => hub.size,
    notifier: opts.notifier ?? NO_NOTIFIER,
    clock: now,
  });

  const recompute = (): void => {
    rules.recalibrate();
    budgetWatch.refresh();
    habits.refresh();
    watchdog.check();
    hub.broadcastIfChanged();
  };

  const settle = (): void => {
    const t = now();
    // la fila de una sesion nueva puede crearse despues de leer el registro
    registry.syncNames();
    reconciler.run(t, registry.openIds(t));
    // cost-state recien leido: precio aprendido y gasto oculto; si un precio cambio se recotiza el historial
    const withCostState = ingestor.takeCostStateSessions();
    if (withCostState.length > 0 && priceBook.onCostStates(withCostState) > 0) rules.recalibrate();
    budgetWatch.refresh();
    // antes de difundir: build() solo lee el indice de alertas ya calculado
    habits.refresh();
    watchdog.check();
    hub.notifyChanged();
  };

  const queue = new IngestQueue(ingestor, {
    onBatch: settle,
    onFileDone: () => {
      if (status.backfill === 'en curso' && status.filesDone < status.filesTotal) status.filesDone++;
    },
    onError: (err) => log(`[ingesta] error: ${err instanceof Error ? err.message : String(err)}`),
  });

  return {
    db: opts.db,
    claudeHome: opts.claudeHome,
    now,
    log,
    registry,
    ingestor,
    queue,
    reconciler,
    office,
    hub,
    history,
    transcripts: new TranscriptService(opts.db, opts.claudeHome),
    roomNotes: new RoomNotes(opts.db),
    rules,
    habits,
    baselines,
    status,
    priceBook,
    budgetWatch,
    extras,
    watchdog,
    settings,
    startedAt: now(),
    shutdown: null,
    settle,
    recompute,
  };
}

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });
  registerOfficeRoutes(app, { build: () => ctx.office.build(), hub: ctx.hub, status: ctx.status });
  registerHistoryRoutes(app, ctx.history, ctx.now, ctx.recompute);
  registerTranscriptRoutes(app, ctx.transcripts);
  // sin el debounce de la ingesta: quien escribio la nota la ve en su lista enseguida
  registerNotesRoutes(app, {
    notes: ctx.roomNotes,
    office: ctx.office,
    now: ctx.now,
    changed: () => ctx.hub.broadcastIfChanged(),
  });
  registerSettingsRoutes(app, { settings: ctx.settings, changed: () => ctx.hub.broadcastIfChanged() });
  // las rutas de reglas recalculan las alertas antes de llamar changed()
  registerHabitsRoutes(app, { habits: ctx.habits, rules: ctx.rules, changed: () => ctx.hub.broadcastIfChanged() });
  registerInsightsRoutes(app, {
    db: ctx.db,
    clock: ctx.now,
    rules: ctx.rules,
    habits: ctx.habits,
    budget: ctx.history,
    baselines: ctx.baselines,
    extras: ctx.extras,
  });
  registerExtrasRoutes(app, {
    extras: ctx.extras,
    priceBook: ctx.priceBook,
    settings: ctx.settings,
    rules: ctx.rules,
    clock: ctx.now,
    live: () => ({
      backfill: ctx.status.backfill,
      filesTotal: ctx.status.filesTotal,
      filesDone: ctx.status.filesDone,
      pending: ctx.queue.size,
      stats: ctx.ingestor.stats,
      startedAt: ctx.startedAt,
      canShutdown: ctx.shutdown !== null,
    }),
    changed: ctx.recompute,
    shutdown: () => ctx.shutdown,
  });
  return app;
}

/** ingesta inicial de todo CLAUDE_HOME/projects (incremental gracias a file_offsets) */
export async function runBackfill(ctx: AppContext): Promise<void> {
  ctx.status.backfill = 'en curso';
  ctx.status.filesDone = 0;
  try {
    await ctx.registry.refresh();
    const targets = await discoverTargets(ctx.claudeHome);
    ctx.status.filesTotal = targets.length;
    ctx.log(`[backfill] ${targets.length} archivos por revisar`);
    const progress = setInterval(() => {
      ctx.log(`[backfill] ${ctx.status.filesDone}/${ctx.status.filesTotal} archivos`);
    }, 5_000);
    progress.unref();
    ctx.queue.enqueueAll(targets);
    await ctx.queue.idle();
    clearInterval(progress);
    // despues de releer: la v13 deja roles en NULL y la relectura llena cmd_class (ascenso a tester)
    new RoleStore(ctx.db).refreshMissing();
    // las alertas se recalcularon a mitad de la relectura: la calibracion de 30 dias se rehace con todo
    ctx.rules.recalibrate();
    ctx.settle();
    ctx.status.backfill = 'listo';
    ctx.log(`[backfill] listo: ${ctx.status.filesDone} archivos revisados`);
  } catch (err) {
    ctx.status.backfill = 'error';
    throw err;
  }
}

/**
 * Red de seguridad del watcher: en cada sweep revisa los archivos de las sesiones abiertas
 * (stat barato; la cola descarta los que no cambiaron).
 */
async function pollOpenSessions(ctx: AppContext): Promise<void> {
  const known = ctx.db.prepare<[string], { transcript_path: string | null }>(
    `SELECT transcript_path FROM sessions WHERE session_id = ?`,
  );
  for (const sessionId of ctx.registry.openIds(ctx.now())) {
    const entry = ctx.registry.entries.get(sessionId);
    let projectDirPath: string | null = null;
    const row = known.get(sessionId);
    if (row?.transcript_path) projectDirPath = path.dirname(row.transcript_path);
    else if (entry?.cwd) projectDirPath = await findProjectDir(ctx.claudeHome, entry.cwd);
    if (!projectDirPath || !fs.existsSync(projectDirPath)) continue;
    const targets = await sessionTargets(ctx.claudeHome, projectDirPath, sessionId, { skipFinishedWorkflows: true });
    for (const t of targets) ctx.queue.enqueue(t);
  }
}

export interface Runtime {
  stop: () => Promise<void>;
}

/** watcher + sweep cada 5 s + ping SSE cada 15 s */
export function startRuntime(ctx: AppContext): Runtime {
  let watcher: FSWatcher | null = null;
  try {
    watcher = startWatcher(ctx.claudeHome, {
      onFile: (t) => ctx.queue.enqueue(t),
      onRegistry: () => {
        void ctx.registry.refresh().then((changed) => {
          if (changed) ctx.hub.notifyChanged();
        });
      },
      onError: (err) => ctx.log(`[watcher] ${err instanceof Error ? err.message : String(err)}`),
    });
  } catch (err) {
    ctx.log(`[watcher] no se pudo iniciar: ${err instanceof Error ? err.message : String(err)}`);
  }

  let sweeping = false;
  const sweep = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      await ctx.registry.refresh();
      await pollOpenSessions(ctx);
      // con un archivo a medio leer se reconcilia al terminar el lote (onBatch), no aqui
      if (!ctx.queue.busy) {
        const t = ctx.now();
        ctx.reconciler.run(t, ctx.registry.openIds(t));
      }
      ctx.budgetWatch.refresh();
      ctx.habits.refresh();
      ctx.watchdog.check();
      ctx.hub.broadcastIfChanged();
    } catch (err) {
      ctx.log(`[sweep] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(() => void sweep(), TIMING.sweepMs);
  ctx.hub.startPing();

  return {
    stop: async () => {
      clearInterval(timer);
      ctx.queue.close();
      ctx.hub.close();
      if (watcher) await watcher.close();
    },
  };
}
