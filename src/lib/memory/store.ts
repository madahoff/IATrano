import "server-only";
import type { Memory, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isAdditive, isExclusive } from "./evaluate";
import { countActiveMemories, forgetMemories, MAX_MEMORIES_PER_USER } from "./service";
import { coverage, findDuplicate, normalizeWords } from "./select";
import { fingerprint, fingerprintSimilarity, TOMBSTONE_SIMILARITY } from "./tombstone";
import { emptyMemoryUpdate, type MemoryCandidate, type MemoryUpdate } from "./types";

// Memory Storage + Memory Update : applique les décisions d'une analyse à la base, en une transaction
// sérialisée par utilisateur (verrou consultatif) pour que deux analyses simultanées ne créent pas de doublons.
//
// Pour chaque information acceptée :
// - déjà connue (formulation proche, même portée) → renforcement : compteur de mentions, date de confirmation,
//   fiabilité relevée (confirmée après 3 mentions ou sur demande explicite) ;
// - même sujet exclusif, ou correction désignée par le modèle → la nouvelle version remplace l'ancienne,
//   conservée comme SUPERSEDED (jamais injectée) ;
// - sinon → ajout, après éviction éventuelle du souvenir automatique le moins utile si le plafond est atteint.
// Les demandes d'oubli suppriment le souvenir et son historique (voir forgetMemories).

export type PlannedOperation =
  | { op: "upsert"; candidate: MemoryCandidate; replaces?: string | null }
  | { op: "forget"; query: string }
  | { op: "delete"; id: string };

export type ApplyContext = {
  userId: string;
  conversationId: string | null;
  /** Projet de la conversation, si sa mémoire est activée (sinon les informations de projet restent personnelles). */
  projectId: string | null;
  /** Date du message analysé : un oubli postérieur l'emporte sur lui. */
  sourceCreatedAt: Date;
  explicit: boolean;
};

const CONNECTORS = new Set(["prefere", "prefer", "plutot", "lieu", "place", "veut", "utilise", "aime", "mieux", "lon"]);
/** Mêmes termes significatifs, dans le même ordre. */
function sameTerms(a: string, b: string) {
  const key = (t: string) => normalizeWords(t).filter((w) => w !== "utilisateur" && !CONNECTORS.has(w)).join(" ");
  return key(a) === key(b);
}

export const lockKey = (userId: string) => `memory:${userId}`;

/** Souvenir automatique le moins utile, évincé quand le plafond est atteint (jamais un souvenir saisi ou confirmé). */
async function evictOne(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  const candidates = await tx.memory.findMany({ where: { userId, status: "ACTIVE", source: "AUTO", certainty: { not: "CONFIRMED" } } });
  if (candidates.length === 0) return false;
  const value = (m: Memory) => m.importance * 2 + Math.min(m.mentionCount, 5) + Math.min(m.useCount, 5) + (Date.now() - m.lastConfirmedAt.getTime() < 30 * 86_400_000 ? 2 : 0);
  const victim = candidates.sort((a, b) => value(a) - value(b) || a.lastConfirmedAt.getTime() - b.lastConfirmedAt.getTime())[0];
  await tx.memory.deleteMany({ where: { id: victim.id, userId } });
  return true;
}

export async function applyOperations(ctx: ApplyContext, ops: PlannedOperation[]): Promise<MemoryUpdate> {
  const result = emptyMemoryUpdate();
  if (ops.length === 0) return result;
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(ctx.userId)}))`;
      const scopeWhere = { userId: ctx.userId, status: "ACTIVE" as const, OR: [{ projectId: null }, ...(ctx.projectId ? [{ projectId: ctx.projectId }] : [])] };
      let pool = await tx.memory.findMany({ where: scopeWhere });
      const tombstones = await tx.memoryTombstone.findMany({ where: { userId: ctx.userId, createdAt: { gt: ctx.sourceCreatedAt } } });
      const now = new Date();

      for (const op of ops) {
        if (op.op === "delete" || op.op === "forget") {
          let ids: string[] = [];
          if (op.op === "delete") ids = pool.some((m) => m.id === op.id) ? [op.id] : [];
          else {
            // « Oublie que j'utilise MySQL » : souvenirs qui contiennent l'essentiel des mots de la demande.
            const ranked = pool.map((m) => ({ m, c: coverage(op.query, m.content) })).filter((x) => x.c >= 0.6);
            const best = Math.max(0, ...ranked.map((x) => x.c));
            ids = ranked.filter((x) => x.c >= best - 0.001).map((x) => x.m.id);
            if (ids.length === 0) result.rejected.push(`Aucun souvenir ne correspond à « ${op.query.slice(0, 80)} » : rien n'a été oublié.`);
          }
          if (ids.length) {
            result.removed += (await forgetMemories(tx, ctx.userId, ids)).active;
            pool = pool.filter((m) => !ids.includes(m.id));
          }
          continue;
        }

        const c = op.candidate;
        const projectId = c.scope === "project" && ctx.projectId ? ctx.projectId : null;
        // Information de projet hors espace projet : mémoire personnelle étiquetée par le nom du projet.
        const kind = projectId && c.kind === "PROJECT" ? "FACT" : c.kind;
        const project = !projectId && kind === "PROJECT" ? c.project : null;
        const sameScope = pool.filter((m) => m.projectId === projectId);

        // Un oubli demandé après le message analysé l'emporte.
        const fp = fingerprint(c.content);
        if (tombstones.some((t) => t.projectId === projectId && fingerprintSimilarity(fp, t.fingerprint) >= TOMBSTONE_SIMILARITY)) continue;

        let target = op.replaces ? (sameScope.find((m) => m.id === op.replaces) ?? null) : null;
        if (!target && isExclusive(kind, c.topic) && !isAdditive(c.evidence ?? c.content)) {
          target = sameScope.find((m) => m.topic === c.topic && isExclusive(m.kind, m.topic)) ?? null;
        }
        // Face à un souvenir du même sujet, l'ordre des termes compte : « pnpm plutôt que npm » contredit
        // « npm plutôt que pnpm » alors que les mots sont les mêmes.
        const dup = target ? (sameTerms(target.content, c.content) ? target : null) : findDuplicate(c.content, sameScope);

        if (dup && (!target || target.id === dup.id)) {
          const mentions = dup.mentionCount + 1;
          const certainty = c.certainty === "CONFIRMED" || mentions >= 3 ? "CONFIRMED" : dup.certainty === "UNCERTAIN" && c.certainty === "STATED" ? "STATED" : dup.certainty;
          const updated = await tx.memory.update({
            where: { id: dup.id },
            data: { mentionCount: mentions, lastConfirmedAt: now, certainty, importance: Math.max(dup.importance, c.importance), topic: dup.topic ?? c.topic },
          });
          pool = pool.map((m) => (m.id === dup.id ? updated : m));
          result.reinforced++;
          continue;
        }

        if (target) {
          const created = await tx.memory.create({
            data: {
              userId: ctx.userId,
              projectId,
              kind,
              project,
              content: c.content,
              topic: c.topic ?? target.topic,
              source: "AUTO",
              certainty: c.certainty,
              importance: Math.max(c.importance, target.importance),
              sourceConversationId: ctx.conversationId,
            },
          });
          await tx.memory.update({ where: { id: target.id }, data: { status: "SUPERSEDED", supersededById: created.id } });
          pool = [...pool.filter((m) => m.id !== target!.id), created];
          result.updated.push(c.content);
          continue;
        }

        if ((await countActiveMemories(tx, ctx.userId)) >= MAX_MEMORIES_PER_USER && !(await evictOne(tx, ctx.userId))) {
          result.rejected.push(`Mémoire pleine (${MAX_MEMORIES_PER_USER} souvenirs) : supprimez-en depuis la page Mémoire pour en ajouter.`);
          continue;
        }
        const created = await tx.memory.create({
          data: {
            userId: ctx.userId,
            projectId,
            kind,
            project,
            content: c.content,
            topic: c.topic,
            source: "AUTO",
            certainty: c.certainty,
            importance: c.importance,
            sourceConversationId: ctx.conversationId,
          },
        });
        pool.push(created);
        result.saved.push(c.content);
      }
      return result;
    },
    { timeout: 20_000 },
  );
}
