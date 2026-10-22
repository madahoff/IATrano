import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { errorDetails, logEvent } from "@/lib/logger";
import { getModels } from "@/lib/llm/discovery";
import { createProvider } from "@/lib/llm/registry";
import type { LlmProvider } from "@/lib/llm/types";
import { getAppSettings, providerConfigFrom } from "@/lib/settings/service";
import { analyzeMessage } from "./auto";
import { purgeExpiredMemoryData, scheduleConsolidation } from "./consolidate";
import { assessMemoryPotential, userAuthoredText } from "./extract";
import { getMemorySettings } from "./service";
import type { MemoryUpdate } from "./types";

// File d'attente persistante des analyses de mémoire.
//
// Après chaque réponse, le message de l'utilisateur est filtré (règles, sans modèle) ; s'il peut contenir une
// information durable, une tâche est ENREGISTRÉE en base avant tout traitement. Elle est ensuite exécutée tout de
// suite (après la fin de la réponse, sans la retarder) puis, en cas d'échec ou de redémarrage, reprise par la
// tâche de fond (startMemoryWorker) avec des délais croissants. Après MAX_ATTEMPTS échecs du modèle, les règles et
// les demandes explicites sont appliquées sans lui ; une erreur persistante laisse la tâche FAILED, visible et
// relançable depuis la page Mémoire : aucune opération n'est perdue silencieusement.

export const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000];
/** Une tâche RUNNING plus ancienne a été interrompue (redémarrage du serveur) : elle est remise en attente. */
const STALE_LOCK_MS = 5 * 60_000;

export async function enqueueMemoryJob(opts: { userId: string; conversationId: string; messageId: string; projectId: string | null; model: string; text: string }) {
  const settings = await getMemorySettings(opts.userId);
  if (!settings.enabled) return null;
  const signal = assessMemoryPotential(userAuthoredText(opts.text));
  if (!signal.potential) return null;
  if (!settings.autoSave && !signal.explicitRemember && !signal.explicitForget) return null;
  // Régénération d'une réponse : le message déjà analysé (et non modifié depuis) ne l'est pas une seconde fois.
  const message = await db.message.findUnique({ where: { id: opts.messageId }, select: { updatedAt: true } });
  if (!message) return null;
  if (await db.memoryJob.findFirst({ where: { messageId: opts.messageId, createdAt: { gte: message.updatedAt } }, select: { id: true } })) return null;
  const app = await getAppSettings();
  return db.memoryJob.create({
    data: { userId: opts.userId, conversationId: opts.conversationId, messageId: opts.messageId, projectId: opts.projectId, model: app.memoryModel?.trim() || opts.model },
    select: { id: true },
  });
}

async function defaultProvider(model: string): Promise<{ provider: LlmProvider; think: boolean | undefined }> {
  const app = await getAppSettings();
  const provider = createProvider(providerConfigFrom(app));
  const info = (await getModels().catch(() => null))?.models.find((m) => m.id === model);
  return { provider, think: info?.capabilities.thinking === "no" ? undefined : false };
}

export type JobOutcome = { status: "DONE" | "PENDING" | "FAILED"; update: MemoryUpdate | null; error?: string };

/**
 * Exécute une tâche si elle est en attente (la réclamation est atomique : deux processus ne la traitent jamais
 * en même temps). provider : fournisseur de la conversation (sinon celui de la configuration).
 */
export async function processMemoryJob(jobId: string, deps: { provider?: LlmProvider; think?: boolean; signal?: AbortSignal } = {}): Promise<JobOutcome | null> {
  const claimed = await db.memoryJob.updateMany({ where: { id: jobId, status: "PENDING" }, data: { status: "RUNNING", lockedAt: new Date(), attempts: { increment: 1 } } });
  if (claimed.count === 0) return null;
  const job = await db.memoryJob.findUnique({ where: { id: jobId }, include: { message: { select: { content: true, createdAt: true } } } });
  if (!job) return null;
  const finalAttempt = job.attempts >= MAX_ATTEMPTS;
  try {
    const { provider, think } = deps.provider ? { provider: deps.provider, think: deps.think } : await defaultProvider(job.model);
    const update = await analyzeMessage({
      userId: job.userId,
      conversationId: job.conversationId,
      projectId: job.projectId,
      text: job.message.content,
      sourceCreatedAt: job.message.createdAt,
      provider,
      model: job.model,
      think,
      signal: deps.signal,
      finalAttempt,
    });
    await db.memoryJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: { status: "DONE", lockedAt: null, error: update.degraded ?? null, result: update as unknown as Prisma.InputJsonValue },
    });
    if (update.degraded) await logEvent("WARN", "memory:job", "Mémoire analysée sans le modèle (règles seulement)", { jobId: job.id, reason: update.degraded }, job.userId);
    scheduleConsolidation(job.userId);
    return { status: "DONE", update };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await db.memoryJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: finalAttempt
        ? { status: "FAILED", lockedAt: null, error }
        : { status: "PENDING", lockedAt: null, error, nextAttemptAt: new Date(Date.now() + BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)]) },
    });
    await logEvent(finalAttempt ? "WARN" : "INFO", "memory:job", finalAttempt ? "Analyse de la mémoire abandonnée" : "Analyse de la mémoire reportée", { jobId: job.id, attempts: job.attempts, ...errorDetails(err) }, job.userId);
    return { status: finalAttempt ? "FAILED" : "PENDING", update: null, error };
  }
}

/** Reprend les tâches dues (et celles interrompues par un redémarrage). Renvoie le nombre de tâches traitées. */
export async function runDueMemoryJobs(limit = 5): Promise<number> {
  await db.memoryJob.updateMany({ where: { status: "RUNNING", lockedAt: { lt: new Date(Date.now() - STALE_LOCK_MS) } }, data: { status: "PENDING", lockedAt: null, nextAttemptAt: new Date() } });
  const due = await db.memoryJob.findMany({ where: { status: "PENDING", nextAttemptAt: { lte: new Date() } }, orderBy: { createdAt: "asc" }, take: limit, select: { id: true } });
  let done = 0;
  for (const j of due) if (await processMemoryJob(j.id)) done++;
  return done;
}

export async function retryFailedMemoryJobs(userId: string) {
  const res = await db.memoryJob.updateMany({ where: { userId, status: "FAILED" }, data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), error: null } });
  return res.count;
}

export async function memoryJobSummary(userId: string) {
  const [pending, failed, lastFailed] = await Promise.all([
    db.memoryJob.count({ where: { userId, status: { in: ["PENDING", "RUNNING"] } } }),
    db.memoryJob.count({ where: { userId, status: "FAILED" } }),
    db.memoryJob.findFirst({ where: { userId, status: "FAILED" }, orderBy: { updatedAt: "desc" }, select: { error: true, updatedAt: true } }),
  ]);
  return { pending, failed, lastError: lastFailed?.error ?? null, lastFailedAt: lastFailed?.updatedAt.toISOString() ?? null };
}

const g = globalThis as unknown as { __iatranoMemoryWorker?: ReturnType<typeof setInterval> };

/** Tâche de fond (une par processus) : reprise des analyses en attente et purge périodique. */
export function startMemoryWorker(intervalMs = 30_000) {
  if (g.__iatranoMemoryWorker) return;
  let running = false;
  let lastPurge = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueMemoryJobs();
      if (Date.now() - lastPurge > 6 * 60 * 60 * 1000) {
        lastPurge = Date.now();
        await purgeExpiredMemoryData();
      }
    } catch (err) {
      console.error("[memory] tâche de fond", errorDetails(err));
    } finally {
      running = false;
    }
  };
  g.__iatranoMemoryWorker = setInterval(tick, intervalMs);
  g.__iatranoMemoryWorker.unref?.();
  setTimeout(tick, 5_000).unref?.();
}
