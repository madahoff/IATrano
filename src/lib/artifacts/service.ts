import "server-only";
import type { Artifact } from "@prisma/client";
import { db } from "@/lib/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { errorDetails, logEvent } from "@/lib/logger";
import { getModels } from "@/lib/llm/discovery";
import { createProvider } from "@/lib/llm/registry";
import { withContextWindow } from "@/lib/llm/with-window";
import { ProviderError } from "@/lib/llm/types";
import { getWindowFor } from "@/lib/context/service";
import { getAppSettings, providerConfigFrom } from "@/lib/settings/service";
import { cleanCode, extractArtifacts, validateArtifact } from "./extract";
import { buildRepairPrompt } from "./prompt";
import { toArtifactRef, type ArtifactDTO } from "./types";


async function toDTO(a: Artifact): Promise<ArtifactDTO> {
  const versions = await db.artifact.findMany({
    where: { conversationId: a.conversationId, key: a.key },
    orderBy: { version: "asc" },
    select: { id: true, version: true, origin: true, valid: true, createdAt: true },
  });
  return {
    ...toArtifactRef(a),
    code: a.code,
    conversationId: a.conversationId,
    messageId: a.messageId,
    runtimeError: a.runtimeError,
    autoRepairUsed: a.autoRepairUsed,
    createdAt: a.createdAt.toISOString(),
    versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
  };
}

/** Enregistre une nouvelle version (v1 d'un nouvel artifact, ou version suivante d'un artifact existant). */
export async function saveArtifactVersion(opts: {
  conversationId: string;
  messageId: string;
  title: string;
  code: string;
  complete: boolean;
  /** Clé de l'artifact modifié ou réparé ; absente pour un nouvel artifact. */
  key?: string | null;
  origin: Artifact["origin"];
}): Promise<Artifact> {
  const code = cleanCode(opts.code);
  const check = validateArtifact(code, opts.complete);
  // Deux tentatives au plus en cas de création simultanée de la même version.
  for (let attempt = 0; ; attempt++) {
    const last = opts.key ? await db.artifact.findFirst({ where: { conversationId: opts.conversationId, key: opts.key }, orderBy: { version: "desc" }, select: { version: true } }) : null;
    try {
      return await db.artifact.create({
        data: {
          conversationId: opts.conversationId,
          messageId: opts.messageId,
          key: opts.key ?? crypto.randomUUID(),
          version: (last?.version ?? 0) + 1,
          title: opts.title,
          code,
          origin: opts.origin,
          valid: check.valid,
          issues: check.issues,
        },
      });
    } catch (err) {
      if (attempt >= 1 || !(err instanceof Error && "code" in err && (err as { code?: string }).code === "P2002")) throw err;
    }
  }
}

export async function getOwnedArtifact(userId: string, id: string): Promise<Artifact> {
  const a = await db.artifact.findFirst({ where: { id, conversation: { userId } } });
  if (!a) throw notFound("Page interactive introuvable.");
  return a;
}

export async function getArtifactDTO(userId: string, id: string): Promise<ArtifactDTO> {
  return toDTO(await getOwnedArtifact(userId, id));
}

/** Dernière version d'un artifact d'une conversation (contexte d'une demande de modification). */
export async function latestVersion(userId: string, conversationId: string, key: string): Promise<Artifact | null> {
  return db.artifact.findFirst({ where: { conversationId, key, conversation: { userId } }, orderBy: { version: "desc" } });
}

/** Le texte renvoyé par la réparation : bloc <artifact>, sinon page HTML brute. */
function codeFromRepair(raw: string): { title: string | null; code: string; complete: boolean } | null {
  const { artifacts } = extractArtifacts(raw);
  if (artifacts.length) return { title: artifacts[0].title, code: artifacts[0].code, complete: artifacts[0].complete };
  const html = cleanCode(raw);
  return /<(?:!doctype|html|body)\b/i.test(html) ? { title: null, code: html, complete: true } : null;
}

/**
 * Renvoie le code et le problème (erreur JS, page incomplète…) à Qwen et enregistre la version corrigée.
 * Une seule tentative AUTOMATIQUE par version ; l'utilisateur peut ensuite relancer manuellement.
 */
export async function repairArtifact(opts: { userId: string; id: string; problem: string; auto: boolean; signal?: AbortSignal }): Promise<ArtifactDTO> {
  const source = await getOwnedArtifact(opts.userId, opts.id);
  const latest = await db.artifact.findFirst({ where: { conversationId: source.conversationId, key: source.key }, orderBy: { version: "desc" }, select: { version: true } });
  if (latest && latest.version !== source.version) throw new AppError(409, "artifact_outdated", "Une version plus récente existe déjà : ouvrez-la avant de demander une correction.");
  if (opts.auto) {
    // Verrou : une seule tentative automatique, même si deux onglets la déclenchent en même temps.
    const { count } = await db.artifact.updateMany({ where: { id: source.id, autoRepairUsed: false }, data: { autoRepairUsed: true, runtimeError: opts.problem.slice(0, 2000) } });
    if (count === 0) throw new AppError(409, "artifact_auto_repair_used", "La correction automatique a déjà été tentée pour cette version.");
  } else {
    await db.artifact.update({ where: { id: source.id }, data: { runtimeError: opts.problem.slice(0, 2000) } });
  }

  const [app, conv, snapshot] = await Promise.all([
    getAppSettings(),
    db.conversation.findUniqueOrThrow({ where: { id: source.conversationId }, select: { model: true } }),
    getModels(),
  ]);
  const modelId = conv.model ?? app.defaultModel ?? snapshot.models[0]?.id;
  if (!modelId) throw badRequest("Aucun modèle disponible pour corriger la page.");
  const info = snapshot.models.find((m) => m.id === modelId) ?? null;
  const window = await getWindowFor(modelId, app, info);
  const provider = withContextWindow(createProvider(providerConfigFrom(app)), window.numCtx);
  let raw: string;
  try {
    raw = await provider.complete({
      model: modelId,
      messages: buildRepairPrompt(source, opts.problem),
      think: info?.capabilities.thinking === "no" ? undefined : false,
      temperature: 0.2,
      signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(app.requestTimeoutMs)]) : AbortSignal.timeout(app.requestTimeoutMs),
    });
  } catch (err) {
    await logEvent("WARN", "artifact:repair", "Correction de la page impossible", errorDetails(err), opts.userId);
    const e = err instanceof ProviderError ? err : null;
    throw new AppError(502, "artifact_repair_failed", e ? `Correction impossible : ${e.message}` : "Correction impossible : le serveur IA n'a pas répondu.");
  }
  const repaired = codeFromRepair(raw);
  if (!repaired) throw new AppError(502, "artifact_repair_failed", "Qwen n'a pas renvoyé de page corrigée. Réessayez.");
  const saved = await saveArtifactVersion({
    conversationId: source.conversationId,
    messageId: source.messageId,
    title: repaired.title ?? source.title,
    code: repaired.code,
    complete: repaired.complete,
    key: source.key,
    origin: "REPAIRED",
  });
  return toDTO(saved);
}
