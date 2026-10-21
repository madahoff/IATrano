import "server-only";
import type { Conversation, Message, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { badRequest, notFound } from "@/lib/errors";
import { errorDetails, logEvent } from "@/lib/logger";
import {
  buildClarificationExtractionPrompt,
  CLARIFICATION_JSON_SCHEMA,
  createClarifyExtractor,
  looksLikeClarificationRequest,
  parseClarification,
  type Clarification,
} from "@/lib/llm/clarify";
import { getModels } from "@/lib/llm/discovery";
import { buildMessages, buildTitlePrompt, fallbackTitle, sanitizeTitle } from "@/lib/llm/prompt";
import { createProvider } from "@/lib/llm/registry";
import { ProviderError, type LlmProvider, type ModelInfo } from "@/lib/llm/types";
import { getEffectivePreferences, providerConfigFrom } from "@/lib/settings/service";
import type { ChatRequestBody, StreamEvent } from "./protocol";

type Emit = (event: StreamEvent) => void;

export type PreparedGeneration = {
  conversation: Conversation;
  userMessage: Message | null;
  assistantMessage: Message;
  history: Message[];
  isFirstExchange: boolean;
};

/** Valide l'action et prépare la base (message utilisateur, nettoyage pour édition/régénération). */
export async function prepareGeneration(userId: string, body: ChatRequestBody, model: string, thinkingEnabled: boolean, providerKind: Message["provider"]): Promise<PreparedGeneration> {
  let conversation: Conversation;
  let userMessage: Message | null = null;

  if (body.action === "send") {
    const content = body.content?.trim();
    if (!content) throw badRequest("Le message est vide.");
    if (body.conversationId) {
      const found = await db.conversation.findFirst({ where: { id: body.conversationId, userId } });
      if (!found) throw notFound("Conversation introuvable.");
      conversation = found;
    } else {
      conversation = await db.conversation.create({ data: { userId, title: fallbackTitle(content), model } });
    }
    userMessage = await db.message.create({ data: { conversationId: conversation.id, role: "USER", content } });
  } else {
    if (!body.conversationId) throw badRequest("conversationId requis.");
    const found = await db.conversation.findFirst({ where: { id: body.conversationId, userId } });
    if (!found) throw notFound("Conversation introuvable.");
    conversation = found;
    if (body.action === "edit") {
      const content = body.content?.trim();
      if (!content || !body.messageId) throw badRequest("Message et contenu requis pour l'édition.");
      const target = await db.message.findFirst({ where: { id: body.messageId, conversationId: conversation.id, role: "USER" } });
      if (!target) throw notFound("Message introuvable.");
      await db.message.deleteMany({ where: { conversationId: conversation.id, createdAt: { gt: target.createdAt } } });
      userMessage = await db.message.update({ where: { id: target.id }, data: { content } });
    } else {
      // regenerate : supprime la réponse visée (ou la dernière) et tout ce qui suit.
      const target = body.messageId
        ? await db.message.findFirst({ where: { id: body.messageId, conversationId: conversation.id, role: "ASSISTANT" } })
        : await db.message.findFirst({ where: { conversationId: conversation.id, role: "ASSISTANT" }, orderBy: { createdAt: "desc" } });
      if (target) await db.message.deleteMany({ where: { conversationId: conversation.id, createdAt: { gte: target.createdAt } } });
    }
  }

  const history = await db.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } });
  const last = history.at(-1);
  if (!last || last.role !== "USER") throw badRequest("Aucun message utilisateur à traiter.");

  // L'horodatage de la réponse est strictement postérieur à la question (ordre garanti pour édition/régénération).
  const assistantMessage = await db.message.create({
    data: {
      conversationId: conversation.id,
      role: "ASSISTANT",
      status: "STREAMING",
      model,
      provider: providerKind,
      thinkingEnabled,
      createdAt: new Date(Math.max(Date.now(), last.createdAt.getTime() + 1)),
    },
  });
  conversation = await db.conversation.update({ where: { id: conversation.id }, data: { model, updatedAt: new Date() } });
  return { conversation, userMessage, assistantMessage, history, isFirstExchange: history.length === 1 };
}

export type ResolvedModel = { model: ModelInfo | null; think: boolean | undefined; thinkingEffective: boolean; notice?: string; error?: ProviderError };

/** Vérifie la disponibilité réelle du modèle et décide comment piloter le Thinking. */
export async function resolveModel(modelId: string, wantThinking: boolean): Promise<ResolvedModel> {
  const snapshot = await getModels();
  if (!snapshot.provider.reachable) {
    return { model: null, think: undefined, thinkingEffective: false, error: new ProviderError(snapshot.provider.error ?? "Serveur IA injoignable.", "unreachable", snapshot.provider.hint) };
  }
  let model = snapshot.models.find((m) => m.id === modelId) ?? null;
  if (!model) {
    const fresh = await getModels({ refresh: true });
    model = fresh.models.find((m) => m.id === modelId) ?? null;
  }
  if (!model) {
    return { model: null, think: undefined, thinkingEffective: false, error: new ProviderError(`Le modèle « ${modelId} » n'est pas disponible sur le serveur IA.`, "model_not_found", "Choisissez un autre modèle dans le sélecteur.") };
  }
  const cap = model.capabilities.thinking;
  if (cap === "yes") return { model, think: wantThinking, thinkingEffective: wantThinking };
  if (cap === "unknown") return { model, think: wantThinking, thinkingEffective: wantThinking };
  return {
    model,
    think: undefined,
    thinkingEffective: false,
    notice: wantThinking ? `Le modèle « ${model.name} » ne prend pas en charge le mode Thinking : réponse standard.` : undefined,
  };
}

const FLUSH_INTERVAL_MS = 1000;

export async function runGeneration(opts: {
  userId: string;
  prepared: PreparedGeneration;
  resolved: ResolvedModel;
  modelId: string;
  signal: AbortSignal;
  emit: Emit;
}) {
  const { prepared, resolved, emit, signal } = opts;
  const { conversation, assistantMessage } = prepared;
  const startedAt = Date.now();
  const prefs = await getEffectivePreferences(opts.userId);
  const provider: LlmProvider = createProvider(providerConfigFrom(prefs.app));

  emit({
    type: "start",
    conversationId: conversation.id,
    userMessage: prepared.userMessage
      ? { id: prepared.userMessage.id, content: prepared.userMessage.content, createdAt: prepared.userMessage.createdAt.toISOString() }
      : null,
    assistantMessageId: assistantMessage.id,
    model: opts.modelId,
    thinking: resolved.thinkingEffective,
  });
  if (resolved.notice) emit({ type: "notice", code: "thinking_unsupported", message: resolved.notice });

  let text = "";
  let thinking = "";
  let lastFlush = Date.now();
  const persist = (data: Prisma.MessageUpdateInput) => db.message.update({ where: { id: assistantMessage.id }, data });

  if (resolved.error) {
    emit({ type: "error", code: resolved.error.code, message: resolved.error.message, hint: resolved.error.hint });
    await persist({ status: "ERROR", error: resolved.error.message, durationMs: 0 });
    await logEvent("WARN", "chat", resolved.error.message, { model: opts.modelId, code: resolved.error.code }, opts.userId);
    return;
  }

  const clarify = createClarifyExtractor();
  const messages = buildMessages({
    systemPrompt: prefs.app.systemPrompt,
    clarifications: prefs.clarificationsEnabled,
    history: prepared.history.map((m) => ({ role: m.role, content: m.content, clarification: m.clarification as Clarification | null })),
    charBudget: resolved.model?.contextLength ? Math.min(resolved.model.contextLength * 3, 60_000) : undefined,
  });

  try {
    for await (const chunk of provider.chatStream({ model: opts.modelId, messages, think: resolved.think, signal })) {
      if (chunk.type === "thinking") {
        thinking += chunk.delta;
        emit({ type: "thinking", delta: chunk.delta });
      } else if (chunk.type === "text") {
        const visible = clarify.push(chunk.delta);
        if (visible) {
          text += visible;
          emit({ type: "text", delta: visible });
        }
      }
      if (Date.now() - lastFlush > FLUSH_INTERVAL_MS) {
        lastFlush = Date.now();
        await persist({ content: text, thinking: thinking || null });
      }
    }
    const end = clarify.finish();
    if (end.text) {
      text += end.text;
      emit({ type: "text", delta: end.text });
    }
    let clarification = end.clarification;
    if (!clarification && prefs.clarificationsEnabled && looksLikeClarificationRequest(text)) {
      clarification = await extractClarification(provider, opts.modelId, resolved, prepared.history.at(-1)?.content ?? "", text, signal);
    }
    if (clarification) emit({ type: "clarification", data: clarification });
    else if (end.malformed) emit({ type: "notice", code: "clarification_invalid", message: "Le modèle a proposé des questions de précision dans un format invalide ; elles ont été ignorées." });
    if (resolved.thinkingEffective && !thinking) {
      emit({ type: "notice", code: "thinking_not_returned", message: "Le fournisseur n'a renvoyé aucun flux de réflexion distinct pour cette réponse." });
    }
    const durationMs = Date.now() - startedAt;
    if (!text.trim() && !clarification) {
      const message = thinking ? "Le modèle a réfléchi mais n'a produit aucune réponse finale." : "Le modèle a renvoyé une réponse vide.";
      emit({ type: "notice", code: "empty_response", message });
      await persist({ content: text, thinking: thinking || null, status: "ERROR", error: message, durationMs });
      emit({ type: "done", status: "COMPLETE", durationMs });
      return;
    }
    await persist({
      content: text.trim(),
      thinking: thinking || null,
      clarification: clarification ?? undefined,
      status: "COMPLETE",
      durationMs,
    });
    emit({ type: "done", status: "COMPLETE", durationMs });
    if (prepared.isFirstExchange && !conversation.titleGenerated) {
      await generateTitle(provider, opts.modelId, resolved, conversation.id, prepared.history[0]?.content ?? "", text, emit);
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const aborted = signal.aborted || (err instanceof ProviderError && err.code === "aborted");
    if (aborted) {
      await persist({ content: text, thinking: thinking || null, status: "CANCELLED", durationMs }).catch(() => {});
      emit({ type: "done", status: "CANCELLED", durationMs });
      return;
    }
    const e = err instanceof ProviderError ? err : new ProviderError("Erreur inattendue pendant la génération.", "bad_response");
    await persist({ content: text, thinking: thinking || null, status: "ERROR", error: e.message, durationMs }).catch(() => {});
    await logEvent("ERROR", "chat", e.message, { model: opts.modelId, code: e.code, ...errorDetails(err) }, opts.userId);
    emit({ type: "error", code: e.code, message: e.message, hint: e.hint });
  }
}

async function extractClarification(
  provider: LlmProvider,
  model: string,
  resolved: ResolvedModel,
  userMessage: string,
  answer: string,
  signal: AbortSignal,
): Promise<Clarification | null> {
  try {
    const raw = await provider.completeJson(
      {
        model,
        messages: buildClarificationExtractionPrompt(userMessage, answer),
        think: resolved.model?.capabilities.thinking === "no" ? undefined : false,
        temperature: 0,
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      },
      CLARIFICATION_JSON_SCHEMA as unknown as Record<string, unknown>,
    );
    return parseClarification(raw);
  } catch (err) {
    if (signal.aborted) throw err;
    await logEvent("INFO", "chat:clarify", "Extraction des questions impossible", errorDetails(err));
    return null;
  }
}

async function generateTitle(
  provider: LlmProvider,
  model: string,
  resolved: ResolvedModel,
  conversationId: string,
  question: string,
  answer: string,
  emit: Emit,
) {
  try {
    const raw = await provider.complete({
      model,
      messages: buildTitlePrompt(question, answer),
      think: resolved.model?.capabilities.thinking === "no" ? undefined : false,
      temperature: 0.2,
      signal: AbortSignal.timeout(20_000),
    });
    const title = sanitizeTitle(raw);
    if (!title) return;
    await db.conversation.update({ where: { id: conversationId }, data: { title, titleGenerated: true } });
    emit({ type: "title", conversationId, title });
  } catch (err) {
    await logEvent("INFO", "chat:title", "Titre automatique non généré", errorDetails(err));
  }
}
