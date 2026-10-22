import "server-only";
import type { Memory } from "@prisma/client";
import { db } from "@/lib/db";
import { errorDetails, logEvent } from "@/lib/logger";
import { isExclusive } from "./evaluate";
import { similarity } from "./select";
import { lockKey } from "./store";

// Memory Consolidation : maintenance de la mémoire, sans appel au modèle.
// - fusion des doublons apparus malgré tout (saisies manuelles, analyses concurrentes) : mentions et usages cumulés ;
// - un seul souvenir actif par sujet exclusif (le plus récemment confirmé), les autres deviennent l'historique ;
// - purge : historique de plus de 180 jours, empreintes d'oubli de plus de 30 jours, analyses terminées anciennes.

export const MERGE_SIMILARITY = 0.8;
const DAY = 86_400_000;
const CONSOLIDATE_EVERY_MS = 60 * 60 * 1000;

const rank = (m: Memory) => ({ CONFIRMED: 3, STATED: 2, UNCERTAIN: 1 })[m.certainty] * 1000 + Math.min(m.mentionCount, 99) * 10 + (m.source === "MANUAL" ? 5 : 0);

export async function consolidateMemories(userId: string): Promise<{ merged: number; superseded: number }> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(userId)}))`;
      const active = await tx.memory.findMany({ where: { userId, status: "ACTIVE" }, orderBy: { lastConfirmedAt: "desc" } });
      const gone = new Set<string>();
      let merged = 0;
      let superseded = 0;
      for (const keeper of [...active].sort((a, b) => rank(b) - rank(a) || b.lastConfirmedAt.getTime() - a.lastConfirmedAt.getTime())) {
        if (gone.has(keeper.id)) continue;
        const dups = active.filter(
          (m) => m.id !== keeper.id && !gone.has(m.id) && m.projectId === keeper.projectId && m.project === keeper.project && similarity(m.content, keeper.content) >= MERGE_SIMILARITY,
        );
        if (dups.length) {
          await tx.memory.update({
            where: { id: keeper.id },
            data: {
              mentionCount: keeper.mentionCount + dups.reduce((n, d) => n + d.mentionCount, 0),
              useCount: keeper.useCount + dups.reduce((n, d) => n + d.useCount, 0),
              importance: Math.max(keeper.importance, ...dups.map((d) => d.importance)),
              topic: keeper.topic ?? dups.find((d) => d.topic)?.topic ?? null,
            },
          });
          const ids = dups.map((d) => d.id);
          // L'historique des doublons est rattaché au souvenir conservé.
          await tx.memory.updateMany({ where: { userId, supersededById: { in: ids } }, data: { supersededById: keeper.id } });
          await tx.memory.deleteMany({ where: { userId, id: { in: ids } } });
          ids.forEach((id) => gone.add(id));
          merged += ids.length;
        }
      }
      const remaining = active.filter((m) => !gone.has(m.id));
      const byTopic = new Map<string, Memory[]>();
      for (const m of remaining) {
        if (!isExclusive(m.kind, m.topic)) continue;
        const key = `${m.projectId ?? ""}|${m.topic}`;
        byTopic.set(key, [...(byTopic.get(key) ?? []), m]);
      }
      for (const group of byTopic.values()) {
        if (group.length < 2) continue;
        const [latest, ...older] = group.sort((a, b) => b.lastConfirmedAt.getTime() - a.lastConfirmedAt.getTime());
        await tx.memory.updateMany({ where: { userId, id: { in: older.map((o) => o.id) } }, data: { status: "SUPERSEDED", supersededById: latest.id } });
        superseded += older.length;
      }
      return { merged, superseded };
    },
    { timeout: 20_000 },
  );
}

/** Purge globale (tâche de fond) des données de mémoire devenues inutiles. */
export async function purgeExpiredMemoryData(now = new Date()) {
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const [history, tombstones, jobs] = await Promise.all([
    db.memory.deleteMany({ where: { status: "SUPERSEDED", updatedAt: { lt: ago(180) } } }),
    db.memoryTombstone.deleteMany({ where: { createdAt: { lt: ago(30) } } }),
    db.memoryJob.deleteMany({
      where: { OR: [{ status: { in: ["DONE", "SKIPPED"] }, updatedAt: { lt: ago(7) } }, { status: "FAILED", updatedAt: { lt: ago(30) } }] },
    }),
  ]);
  return { history: history.count, tombstones: tombstones.count, jobs: jobs.count };
}

const lastRun = new Map<string, number>();

/** Consolidation d'un compte au plus une fois par heure (après des analyses), sans bloquer l'appelant. */
export function scheduleConsolidation(userId: string) {
  if (Date.now() - (lastRun.get(userId) ?? 0) < CONSOLIDATE_EVERY_MS) return;
  lastRun.set(userId, Date.now());
  void consolidateMemories(userId).catch((err) => logEvent("WARN", "memory:consolidate", "Consolidation de la mémoire impossible", errorDetails(err), userId));
}
