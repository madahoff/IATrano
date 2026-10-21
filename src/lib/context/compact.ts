import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import { errorDetails, logEvent } from "@/lib/logger";
import { createProvider } from "@/lib/llm/registry";
import { countTextTokens } from "@/lib/llm/tokens";
import { ProviderError } from "@/lib/llm/types";
import { getAppSettings, providerConfigFrom } from "@/lib/settings/service";
import { splitForCompaction } from "./policy";
import { buildActiveContext, citedSources, getModelInfo } from "./service";
import {
  buildSummaryPrompt,
  chunkTranscript,
  EMPTY_SECTIONS,
  extractReferences,
  mergeReferences,
  mergeRequests,
  userRequests,
  renderSummary,
  SUMMARY_JSON_SCHEMA,
  transcriptLines,
  validateSummary,
  type LlmSections,
} from "./summary";
import type { SummarySections } from "./types";

// Compaction du contexte d'une conversation.
// - Les messages d'origine ne sont JAMAIS modifiés ni supprimés : seule la représentation utilisée pour
//   construire les prochains prompts change (nouvelle version ACTIVE de ContextSummary).
// - Un verrou (compactionStatus = RUNNING, expirant après LEASE_MS) empêche deux compactions simultanées.
// - En cas d'échec (panne du fournisseur, sortie invalide, interruption), le résumé actif précédent reste
//   en place et l'erreur est enregistrée sur la conversation.

const LEASE_MS = 5 * 60_000;
const SUMMARY_OUTPUT_TOKENS = 900;
const CALL_TIMEOUT_MS = 180_000;
// Un petit modèle (3B) résume fidèlement ~2 000 tokens ; au-delà, il ne retient que la fin des échanges.
const CHUNK_MAX_TOKENS = 1800;

export type CompactionResult =
  | { status: "compacted"; version: number; coveredCount: number; tokensBefore: number; tokensAfter: number }
  | { status: "nothing"; reason: string };

export class CompactionError extends AppError {
  constructor(message: string, code = "compaction_failed", status = 502) {
    super(status, code, message);
  }
}

export async function compactConversation(opts: {
  userId: string;
  conversationId: string;
  modelId: string;
  trigger: "manual" | "auto";
  signal?: AbortSignal;
}): Promise<CompactionResult> {
  const conversation = await db.conversation.findFirst({ where: { id: opts.conversationId, userId: opts.userId } });
  if (!conversation) throw notFound("Conversation introuvable.");

  const lease = await db.conversation.updateMany({
    where: {
      id: conversation.id,
      userId: opts.userId,
      OR: [{ compactionStatus: null }, { compactionStatus: { not: "RUNNING" } }, { compactionStartedAt: { lt: new Date(Date.now() - LEASE_MS) } }],
    },
    data: { compactionStatus: "RUNNING", compactionStartedAt: new Date(), compactionError: null },
  });
  if (lease.count === 0) throw new CompactionError("Une compaction est déjà en cours pour cette conversation.", "compaction_running", 409);

  try {
    const result = await runCompaction({ ...opts, conversationId: conversation.id });
    await db.conversation.update({
      where: { id: conversation.id },
      data: { compactionStatus: "SUCCEEDED", compactionError: null, ...(result.status === "compacted" ? { compactedAt: new Date() } : {}) },
    });
    return result;
  } catch (err) {
    const aborted = opts.signal?.aborted || (err instanceof ProviderError && err.code === "aborted");
    const message = aborted
      ? "Compaction interrompue avant la fin : le contexte précédent est conservé."
      : err instanceof AppError
        ? err.message
        : err instanceof ProviderError
          ? `Le serveur IA n'a pas pu produire le résumé : ${err.message}`
          : "Erreur inattendue pendant la compaction : le contexte précédent est conservé.";
    await db.conversation.update({ where: { id: conversation.id }, data: { compactionStatus: "FAILED", compactionError: message } }).catch(() => {});
    await logEvent(aborted ? "INFO" : "WARN", "context:compact", message, { conversationId: conversation.id, model: opts.modelId, ...errorDetails(err) }, opts.userId);
    if (err instanceof AppError) throw err;
    throw new CompactionError(message, aborted ? "compaction_aborted" : "compaction_failed", aborted ? 499 : 502);
  }
}

async function runCompaction(opts: { userId: string; conversationId: string; modelId: string; trigger: "manual" | "auto"; signal?: AbortSignal }): Promise<CompactionResult> {
  const history = await db.message.findMany({ where: { conversationId: opts.conversationId }, orderBy: { createdAt: "asc" } });
  if (history.some((m) => m.status === "STREAMING" && Date.now() - m.updatedAt.getTime() < 10 * 60_000)) {
    throw new CompactionError("Une réponse est en cours de génération : réessayez quand elle sera terminée.", "generation_running", 409);
  }
  const modelInfo = await getModelInfo(opts.modelId);
  if (!modelInfo) throw new CompactionError(`Le modèle « ${opts.modelId} » n'est pas disponible pour produire le résumé.`, "model_not_found", 400);
  const lastUser = [...history].reverse().find((m) => m.role === "USER");
  const before = await buildActiveContext({ userId: opts.userId, conversation: { id: opts.conversationId }, history, modelId: opts.modelId, modelInfo, query: lastUser?.content ?? "" });
  const previous = before.summary;
  const after = previous ? history.filter((m) => m.createdAt > previous.coveredUntil) : history;
  const { toSummarize } = splitForCompaction(after, before.window.capacity);
  if (toSummarize.length === 0) {
    return { status: "nothing", reason: "Les échanges récents sont déjà conservés intégralement : il n'y a rien de plus à compacter." };
  }

  const prevSections = previous ? (previous.content as unknown as SummarySections) : null;
  let sections: LlmSections | null = prevSections
    ? { objective: prevSections.objective, constraints: prevSections.constraints, decisions: prevSections.decisions, facts: prevSections.facts, state: prevSections.state, nextSteps: prevSections.nextSteps }
    : null;

  // Résumé glissant : chaque morceau de la transcription est fusionné avec le résumé courant,
  // ce qui permet de compacter des échanges plus longs que la fenêtre du modèle.
  const app = await getAppSettings();
  const provider = createProvider(providerConfigFrom(app));
  const { window } = before;
  const promptOverhead = 450;
  const prevTokens = sections ? countTextTokens(JSON.stringify(sections)) : 0;
  const chunkTokens = Math.min(CHUNK_MAX_TOKENS, Math.max(600, window.window - SUMMARY_OUTPUT_TOKENS - promptOverhead - prevTokens - 200));
  const chunks = chunkTranscript(transcriptLines(toSummarize, Math.floor(chunkTokens * 0.8)), chunkTokens);

  const firstRequest = history.find((m) => m.role === "USER" && m.content.trim())?.content;
  for (const chunk of chunks) {
    const sourceTokens = countTextTokens(chunk);
    let attempt: ReturnType<typeof validateSummary> = { ok: false, reason: "" };
    for (const strict of [false, true]) {
      const raw = await provider.completeJson(
        {
          model: opts.modelId,
          messages: buildSummaryPrompt(sections, chunk, strict, firstRequest),
          think: modelInfo.capabilities.thinking === "no" ? undefined : false,
          temperature: strict ? 0 : 0.2,
          numCtx: window.numCtx,
          signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
        },
        SUMMARY_JSON_SCHEMA as unknown as Record<string, unknown>,
      );
      attempt = validateSummary(raw, { sourceTokens: sourceTokens + prevTokens, previous: sections, firstRequest });
      if (attempt.ok) break;
    }
    if (!attempt.ok) throw new CompactionError(`Résumé rejeté : ${attempt.reason} Le contexte précédent est conservé.`, "summary_invalid", 422);
    sections = attempt.sections;
  }

  const references = mergeReferences(
    prevSections?.references ?? [],
    extractReferences(
      toSummarize.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt })),
      await citedSources(toSummarize.filter((m) => m.role === "ASSISTANT").map((m) => m.id)),
    ),
  );
  const transcript = toSummarize.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt }));
  const requests = mergeRequests(prevSections?.requests ?? [], userRequests(transcript));
  const content: SummarySections = { ...(sections ?? EMPTY_SECTIONS), requests, references };
  const text = renderSummary(content);
  const boundary = toSummarize.at(-1)!;

  // Contexte après compaction, pour vérifier le gain et l'afficher.
  const covered = new Set(toSummarize.map((m) => m.id));
  const simulated = await buildActiveContext({
    userId: opts.userId,
    conversation: null,
    history: history.filter((m) => !covered.has(m.id) && m.createdAt > boundary.createdAt),
    modelId: opts.modelId,
    modelInfo,
    query: lastUser?.content ?? "",
    summaryTextOverride: text,
  });
  const summaryTokens = countTextTokens(text);
  const tokensBefore = before.assembled.total;
  const tokensAfter = simulated.assembled.total;
  // Un résumé qui ne réduit pas réellement le contexte n'est pas appliqué (le contexte actif reste inchangé).
  if (tokensAfter >= tokensBefore * 0.9) {
    return { status: "nothing", reason: `Le résumé (≈ ${summaryTokens} tokens) ne réduirait pas assez le contexte actuel : il n'a pas été appliqué.` };
  }

  // Bascule atomique : vérifie que rien n'a changé pendant la génération du résumé (édition, autre compaction).
  return db.$transaction(async (tx) => {
    const [stillActive, boundaryExists, last] = await Promise.all([
      tx.contextSummary.findFirst({ where: { conversationId: opts.conversationId, status: "ACTIVE" }, select: { id: true } }),
      tx.message.findFirst({ where: { id: boundary.id, conversationId: opts.conversationId, updatedAt: boundary.updatedAt }, select: { id: true } }),
      tx.contextSummary.findFirst({ where: { conversationId: opts.conversationId }, orderBy: { version: "desc" }, select: { version: true } }),
    ]);
    if ((stillActive?.id ?? null) !== (previous?.id ?? null) || !boundaryExists) {
      throw new CompactionError("La conversation a changé pendant la compaction : relancez-la.", "compaction_conflict", 409);
    }
    const version = (last?.version ?? 0) + 1;
    await tx.contextSummary.updateMany({ where: { conversationId: opts.conversationId, status: "ACTIVE" }, data: { status: "SUPERSEDED" } });
    await tx.contextSummary.create({
      data: {
        conversationId: opts.conversationId,
        version,
        status: "ACTIVE",
        content: content as unknown as Prisma.InputJsonValue,
        text,
        coveredMessageId: boundary.id,
        coveredUntil: boundary.createdAt,
        coveredCount: (previous?.coveredCount ?? 0) + toSummarize.length,
        tokensBefore,
        tokensAfter,
        summaryTokens,
        model: opts.modelId,
        trigger: opts.trigger,
      },
    });
    return { status: "compacted" as const, version, coveredCount: (previous?.coveredCount ?? 0) + toSummarize.length, tokensBefore, tokensAfter };
  });
}
