import "server-only";
import type { AppSettings, Conversation, Message, Prisma } from "@prisma/client";
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
import { buildTitlePrompt, fallbackTitle, sanitizeTitle } from "@/lib/llm/prompt";
import { createProvider } from "@/lib/llm/registry";
import { withContextWindow } from "@/lib/llm/with-window";
import { finalizeContext } from "@/lib/context/assemble";
import { afterResponse } from "@/lib/context/after";
import { buildActiveContext, getWindowFor } from "@/lib/context/service";
import type { StoredRequestUsage } from "@/lib/context/types";
import { markMemoriesUsed } from "@/lib/memory/service";
import { ProviderError, type LlmProvider, type ModelInfo } from "@/lib/llm/types";
import { getEffectivePreferences, providerConfigFrom } from "@/lib/settings/service";
import { decideSearch } from "@/lib/search/decide";
import { runResearch, type PipelineResult } from "@/lib/search/pipeline";
import { buildRagUserMessage, NO_SEARCH_NOTICE, RAG_INSTRUCTIONS } from "@/lib/search/rag-prompt";
import type { ResearchStep } from "@/lib/search/research-types";
import { validateCitations } from "./citations";
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
export async function prepareGeneration(
  userId: string,
  body: ChatRequestBody,
  model: string,
  thinkingEnabled: boolean,
  providerKind: Message["provider"],
  webSearchDefault = true,
): Promise<PreparedGeneration> {
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
      conversation = await db.conversation.create({ data: { userId, title: fallbackTitle(content), model, webSearch: body.webSearch ?? webSearchDefault } });
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
  // Le contrôle « Recherche Web » envoyé avec le message devient l'état persistant de la conversation.
  conversation = await db.conversation.update({
    where: { id: conversation.id },
    data: { model, updatedAt: new Date(), ...(body.webSearch !== undefined ? { webSearch: body.webSearch } : {}) },
  });
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
  const baseProvider: LlmProvider = createProvider(providerConfigFrom(prefs.app));

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

  // --- Fenêtre de contexte effective : imposée au moteur et identique pour tous les appels de cette génération.
  const window = await getWindowFor(opts.modelId, prefs.app, resolved.model);
  const provider = withContextWindow(baseProvider, window.numCtx);

  // --- Recherche Web (avant la génération ; ne bloque jamais la réponse en cas d'échec)
  const question = prepared.history.at(-1)?.content ?? "";
  const web = await researchPhase({ userId: opts.userId, prepared, resolved, app: prefs.app, provider, modelId: opts.modelId, question, contextLength: window.window, signal, emit });
  if (web?.result.status === "cancelled") {
    const durationMs = Date.now() - startedAt;
    await web.persist({ generation: "cancelled", cited: [], durationMs });
    await persist({ status: "CANCELLED", durationMs }).catch(() => {});
    emit({ type: "done", status: "CANCELLED", durationMs });
    return;
  }
  const rag = web?.result.rag.length ? web.result.rag : null;

  const clarify = createClarifyExtractor();
  // Contexte actif : consignes + mémoire sélectionnée + résumé de compaction + messages récents (voir src/lib/context).
  const ctx = await buildActiveContext({
    userId: opts.userId,
    conversation,
    history: prepared.history,
    modelId: opts.modelId,
    modelInfo: resolved.model,
    query: question,
    // Réponse documentée : pas de questions de précision, le format de citation prime.
    clarifications: prefs.clarificationsEnabled && !web,
  });
  const messages = [...ctx.assembled.messages];
  if (web) {
    messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${rag ? RAG_INSTRUCTIONS : web.result.status === "failed" ? NO_SEARCH_NOTICE : NO_RESULTS_NOTICE}` };
    const last = messages.at(-1);
    if (rag && last?.role === "user") messages[messages.length - 1] = { role: "user", content: buildRagUserMessage(question, rag, new Date()) };
  }

  // Ajustement final au budget, documents Web compris : c'est ce prompt-là qui est envoyé et mesuré.
  const final = finalizeContext(messages, ctx.assembled, ctx.window.capacity);
  const usage: StoredRequestUsage = {
    estimated: final.total,
    window: ctx.window.window,
    reserve: ctx.window.reserve,
    parts: final.parts,
    sentMessages: final.sentMessages,
    droppedMessages: final.droppedMessages,
    summaryVersion: ctx.summary?.version ?? null,
    memoryIds: ctx.memoryIds,
  };
  emit({ type: "context", promptTokens: final.total, window: ctx.window.window, capacity: ctx.window.capacity, dropped: final.droppedMessages, rag: final.parts.rag });
  if (final.droppedMessages > 0) {
    emit({
      type: "notice",
      code: "context_truncated",
      message: `${final.droppedMessages} message(s) ancien(s) n'ont pas pu être transmis au modèle faute de place dans sa fenêtre de contexte (${ctx.window.window} tokens). Ils restent dans l'historique ; réduisez le contexte pour les conserver sous forme de résumé.`,
    });
  }
  void markMemoriesUsed(opts.userId, ctx.memoryIds).catch(() => {});
  const measured: { prompt: number | null; completion: number | null } = { prompt: null, completion: null };
  const usageData = () => ({ promptTokens: measured.prompt, completionTokens: measured.completion, contextUsage: usage as unknown as Prisma.InputJsonValue });

  try {
    for await (const chunk of provider.chatStream({ model: opts.modelId, messages: final.messages, think: resolved.think, signal })) {
      if (chunk.type === "done") {
        measured.prompt = chunk.promptTokens ?? null;
        measured.completion = chunk.evalCount ?? null;
      }
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
    emit({ type: "context_measured", promptTokens: measured.prompt, completionTokens: measured.completion });
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
    // Citations : seules les références à des sources réellement transmises au modèle sont conservées.
    let cited: number[] = [];
    if (web) {
      const check = validateCitations(text, new Set(rag?.map((s) => s.n) ?? []));
      cited = check.cited;
      text = check.content;
      emit({ type: "citations", content: check.content, cited: check.cited, removed: check.removed });
      if (check.removed > 0) {
        emit({ type: "notice", code: "citations_removed", message: `${check.removed} référence(s) ne correspondant à aucune source récupérée ont été retirées de la réponse.` });
      }
    }
    const durationMs = Date.now() - startedAt;
    await web?.persist({ generation: "done", cited, durationMs });
    if (!text.trim() && !clarification) {
      const message = thinking ? "Le modèle a réfléchi mais n'a produit aucune réponse finale." : "Le modèle a renvoyé une réponse vide.";
      emit({ type: "notice", code: "empty_response", message });
      await persist({ content: text, thinking: thinking || null, status: "ERROR", error: message, durationMs, ...usageData() });
      emit({ type: "done", status: "COMPLETE", durationMs });
      return;
    }
    await persist({
      content: text.trim(),
      thinking: thinking || null,
      clarification: clarification ?? undefined,
      status: "COMPLETE",
      durationMs,
      ...usageData(),
    });
    emit({ type: "done", status: "COMPLETE", durationMs });
    if (prepared.isFirstExchange && !conversation.titleGenerated) {
      await generateTitle(provider, opts.modelId, resolved, conversation.id, prepared.history[0]?.content ?? "", text, emit);
    }
    // Mémoire persistante et compaction automatique : après la réponse, sans la retarder.
    await afterResponse({ userId: opts.userId, conversationId: conversation.id, modelId: opts.modelId, userMessage: question, answer: text, provider, think: resolved.model?.capabilities.thinking === "no" ? undefined : false, signal, emit });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const aborted = signal.aborted || (err instanceof ProviderError && err.code === "aborted");
    if (aborted) {
      // Texte partiel : les références invalides sont retirées avant enregistrement.
      if (web) text = validateCitations(text, new Set(rag?.map((s) => s.n) ?? [])).content;
      await web?.persist({ generation: "cancelled", cited: [], durationMs }).catch(() => {});
      await persist({ content: text, thinking: thinking || null, status: "CANCELLED", durationMs, ...usageData() }).catch(() => {});
      emit({ type: "done", status: "CANCELLED", durationMs });
      return;
    }
    const e = err instanceof ProviderError ? err : new ProviderError("Erreur inattendue pendant la génération.", "bad_response");
    await web?.persist({ generation: "failed", cited: [], durationMs }).catch(() => {});
    await persist({ content: text, thinking: thinking || null, status: "ERROR", error: e.message, durationMs, ...usageData() }).catch(() => {});
    await logEvent("ERROR", "chat", e.message, { model: opts.modelId, code: e.code, ...errorDetails(err) }, opts.userId);
    emit({ type: "error", code: e.code, message: e.message, hint: e.hint });
  }
}

const NO_RESULTS_NOTICE = `RECHERCHE WEB SANS RÉSULTAT PERTINENT : une recherche a été effectuée mais aucune page consultée ne répond à la question. Dis-le brièvement, puis réponds avec tes connaissances en précisant qu'elles n'ont pas été vérifiées et peuvent être dépassées. Ne mets aucun numéro de source.`;

type ResearchPhase = {
  result: PipelineResult;
  persist: (end: { generation: "done" | "failed" | "cancelled"; cited: number[]; durationMs: number }) => Promise<unknown>;
};

/**
 * Décide (côté serveur) s'il faut chercher sur le Web, exécute le pipeline et prépare sa persistance.
 * Renvoie null si aucune recherche n'est effectuée (contrôle désactivé, fonction coupée, question simple).
 */
async function researchPhase(opts: {
  userId: string;
  prepared: PreparedGeneration;
  resolved: ResolvedModel;
  app: AppSettings;
  provider: LlmProvider;
  modelId: string;
  question: string;
  /** Fenêtre de contexte effective (tokens) : borne le volume de documents injectés. */
  contextLength: number;
  signal: AbortSignal;
  emit: Emit;
}): Promise<ResearchPhase | null> {
  const { prepared, app, emit } = opts;
  if (!app.webSearchEnabled || !prepared.conversation.webSearch || !opts.question.trim()) return null;
  const previous = prepared.history.filter((m) => m.role === "ASSISTANT").at(-1);
  const previousUsedSearch = previous ? (await db.webSearch.count({ where: { messageId: previous.id, status: "DONE" } })) > 0 : false;
  const automaticDecision = decideSearch(opts.question, { previousUsedSearch });
  // Le contrôle Recherche Web est une commande explicite de l'utilisateur :
  // activé, il force une recherche même pour une question simple ou du code ;
  // désactivé, le retour ci-dessus empêche toute recherche.
  const decision = automaticDecision.search
    ? automaticDecision
    : {
        search: true as const,
        mode: "auto" as const,
        reason: "Recherche Web activée pour cette conversation.",
        timeSensitive: false,
      };
  if (!decision.search) return null;

  const startedAt = Date.now();
  emit({ type: "research_start", mode: decision.mode, reason: decision.reason });
  const record = await db.webSearch.create({
    data: {
      messageId: prepared.assistantMessage.id,
      question: opts.question.slice(0, 4000),
      mode: decision.mode,
      reason: decision.reason,
      provider: app.searchProvider,
      model: opts.modelId,
      queries: [],
      cited: [],
      limitations: [],
    },
  });
  // Contexte court pour reformuler les questions de suivi (« et la version suivante ? »).
  const context = prepared.history
    .slice(-3, -1)
    .map((m) => `${m.role === "USER" ? "Utilisateur" : "Assistant"} : ${m.content.slice(0, 400)}`)
    .join("\n");
  const result = await runResearch({
    question: opts.question,
    context: context || null,
    decision,
    settings: app,
    llm: opts.provider,
    model: opts.modelId,
    utilityThink: opts.resolved.model?.capabilities.thinking === "no" ? undefined : false,
    contextLength: opts.contextLength,
    signal: opts.signal,
    emit,
    userId: opts.userId,
  });
  emit({ type: "research_end", status: result.status, queries: result.queries, limitations: result.limitations.slice(0, 20), error: result.error });
  if (result.status === "failed") {
    emit({
      type: "notice",
      code: "search_unavailable",
      message: `Recherche Web impossible : ${result.error ?? "moteur indisponible"}${result.hint ? ` ${result.hint}` : ""} La réponse ci-dessous n'utilise aucune source Web.`,
    });
  }

  const steps: ResearchStep[] = [...result.steps];
  let seq = 1000;
  const setGenerate = (status: ResearchStep["status"], detail?: string) => {
    const step: ResearchStep = { id: "generate", kind: "generate", label: "Génération de la réponse", status, detail };
    const i = steps.findIndex((s) => s.id === "generate");
    if (i >= 0) steps[i] = step;
    else steps.push(step);
    emit({ type: "research_step", seq: seq++, step });
  };
  if (result.status !== "cancelled") setGenerate("running", result.rag.length ? `À partir de ${result.rag.length} source(s)` : "Sans source Web");
  await db.webSearch.update({
    where: { id: record.id },
    data: { queries: result.queries, steps: steps as unknown as Prisma.InputJsonValue, sources: result.sources as unknown as Prisma.InputJsonValue, limitations: result.limitations, error: result.error },
  });

  return {
    result,
    persist: async (end) => {
      if (result.status !== "cancelled") {
        if (end.generation === "done") setGenerate("done", end.cited.length ? `${end.cited.length} source(s) citée(s)` : result.rag.length ? "Aucune source citée explicitement par le modèle" : undefined);
        else setGenerate("failed", end.generation === "cancelled" ? "Annulé" : "Échec de la génération");
      }
      const status = result.status === "cancelled" || end.generation === "cancelled" ? "CANCELLED" : result.status === "failed" ? "FAILED" : "DONE";
      return db.webSearch.update({
        where: { id: record.id },
        data: { status, steps: steps as unknown as Prisma.InputJsonValue, cited: end.cited, durationMs: Date.now() - startedAt },
      });
    },
  };
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
