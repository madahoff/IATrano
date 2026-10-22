import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, type DocumentJob } from "@prisma/client";
import { db } from "@/lib/db";
import { errorDetails, logEvent } from "@/lib/logger";
import { JobCancelled, runDocumentJob } from "./pipeline";
import { getDocumentSettings } from "./settings";

// File de traitement persistante (table DocumentJob) consommée en arrière-plan par le serveur Next.js :
//  - réservation par bail (FOR UPDATE SKIP LOCKED + lockedAt) : plusieurs processus peuvent coexister ;
//  - bail prolongé à chaque étape ; un traitement dont le processus a disparu est repris après 2 minutes ;
//  - nouvelles tentatives avec délai croissant (3 au maximum), puis échec visible et relançable ;
//  - concurrence bornée (réglage « documents traités simultanément »).
// Désactivable par DOCUMENT_WORKER=off (ex. processus dédié aux tests).

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;
const POLL_MS = 3000;

type WorkerState = { id: string; running: Map<string, AbortController>; timer: NodeJS.Timeout | null; started: boolean };
const g = globalThis as unknown as { __iatranoDocWorker?: WorkerState };
const state: WorkerState = (g.__iatranoDocWorker ??= { id: `${process.pid}-${randomUUID().slice(0, 8)}`, running: new Map(), timer: null, started: false });

export function workerEnabled() {
  return process.env.DOCUMENT_WORKER !== "off";
}

async function claim(): Promise<DocumentJob | null> {
  const rows = await db.$queryRaw<DocumentJob[]>`
    UPDATE "DocumentJob" SET "status" = 'RUNNING', "lockedAt" = now(), "lockedBy" = ${state.id}, "attempts" = "attempts" + 1,
      "startedAt" = COALESCE("startedAt", now()), "updatedAt" = now()
    WHERE id = (
      SELECT id FROM "DocumentJob"
      WHERE ("status" = 'PENDING' AND "nextAttemptAt" <= now())
         OR ("status" = 'RUNNING' AND "lockedAt" < now() - make_interval(secs => ${LEASE_MS / 1000}))
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *`;
  return rows[0] ?? null;
}

async function execute(job: DocumentJob) {
  const controller = new AbortController();
  state.running.set(job.id, controller);
  const metrics: Record<string, number> = { ...((job.metrics as Record<string, number>) ?? {}) };
  const started = Date.now();
  try {
    await runDocumentJob({
      job,
      signal: controller.signal,
      metrics,
      heartbeat: async (patch) => {
        if (controller.signal.aborted) throw new JobCancelled();
        const r = await db.documentJob.updateMany({
          where: { id: job.id, status: "RUNNING", lockedBy: state.id },
          data: { lockedAt: new Date(), ...(patch?.cursor ? { cursor: patch.cursor as Prisma.InputJsonValue } : {}) },
        });
        if (r.count === 0) {
          controller.abort();
          throw new JobCancelled();
        }
      },
    });
    metrics.totalMs = (metrics.totalMs ?? 0) + (Date.now() - started);
    await db.documentJob.updateMany({ where: { id: job.id, lockedBy: state.id }, data: { status: "DONE", stage: "DONE", finishedAt: new Date(), lockedAt: null, error: null, metrics: metrics as Prisma.InputJsonValue } });
  } catch (err) {
    metrics.totalMs = (metrics.totalMs ?? 0) + (Date.now() - started);
    if (err instanceof JobCancelled || controller.signal.aborted) {
      await db.documentJob.updateMany({ where: { id: job.id, status: "RUNNING", lockedBy: state.id }, data: { status: "CANCELLED", finishedAt: new Date(), lockedAt: null } }).catch(() => {});
      return;
    }
    const message = err instanceof Error ? err.message.slice(0, 500) : "Erreur inattendue.";
    const retry = job.attempts < MAX_ATTEMPTS;
    await db.documentJob.updateMany({
      where: { id: job.id, lockedBy: state.id },
      data: retry
        ? { status: "PENDING", lockedAt: null, error: message, nextAttemptAt: new Date(Date.now() + 15_000 * job.attempts ** 2), metrics: metrics as Prisma.InputJsonValue }
        : { status: "FAILED", lockedAt: null, error: message, finishedAt: new Date(), metrics: metrics as Prisma.InputJsonValue },
    });
    const doc = await db.projectDocument.findUnique({ where: { id: job.documentId }, select: { indexedAt: true, warnings: true } });
    if (doc) {
      await db.projectDocument.update({
        where: { id: job.documentId },
        data: doc.indexedAt
          ? // Déjà interrogeable : l'échec d'une étape tardive (analyse) ne rend pas le document inutilisable.
            { warnings: [...new Set([...doc.warnings, `Traitement interrompu (${retry ? "nouvelle tentative programmée" : "échec définitif"}) : ${message}`])].slice(0, 60) }
          : { status: retry ? "PROCESSING" : "ERROR", error: retry ? `Nouvelle tentative programmée : ${message}` : message },
      });
    }
    await logEvent(retry ? "WARN" : "ERROR", "documents", `Traitement du document ${job.documentId} : ${message}`, { jobId: job.id, attempt: job.attempts, ...errorDetails(err) });
  } finally {
    state.running.delete(job.id);
  }
}

async function tick() {
  try {
    const settings = await getDocumentSettings();
    while (state.running.size < settings.concurrency) {
      const job = await claim();
      if (!job) break;
      void execute(job);
    }
  } catch (err) {
    await logEvent("WARN", "documents", "File de traitement indisponible", errorDetails(err)).catch(() => {});
  } finally {
    state.timer = setTimeout(() => void tick(), POLL_MS);
    state.timer.unref?.();
  }
}

export function startDocumentWorker() {
  if (state.started || !workerEnabled()) return;
  state.started = true;
  state.timer = setTimeout(() => void tick(), 1000);
  state.timer.unref?.();
}

/** Réveille la file immédiatement (après un import). */
export function nudgeWorker() {
  if (!state.started) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => void tick(), 50);
}

/** Interrompt le traitement en cours d'un document dans ce processus (suppression, retraitement). */
export function abortDocumentJobs(jobIds: string[]) {
  for (const id of jobIds) state.running.get(id)?.abort();
}

/** Exécute immédiatement les traitements en attente dans ce processus (tests, scripts). */
export async function drainDocumentJobs(opts: { maxJobs?: number } = {}) {
  let n = 0;
  for (;;) {
    if (opts.maxJobs && n >= opts.maxJobs) return n;
    const job = await claim();
    if (!job) return n;
    await execute(job);
    n++;
  }
}
