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
import { getOwnedProject } from "@/lib/projects/service";
import type { ChatRequestBody, StreamEvent } from "./protocol";
import { MODE_LABELS } from "@/lib/routing/config";
import type { RoutingSnapshot } from "@/lib/routing/decide";
import { cleanVisibleText, createArtifactExtractor } from "@/lib/artifacts/extract";
import { ARTIFACT_EDIT_INSTRUCTIONS, ARTIFACT_INSTRUCTIONS, buildCurrentArtifactBlock } from "@/lib/artifacts/prompt";
import { saveArtifactVersion } from "@/lib/artifacts/service";
import { toArtifactRef } from "@/lib/artifacts/types";
import { chatStarted } from "@/lib/documents/activity";
import { checkCitationSupport, validateDocCitations } from "@/lib/documents/citations";
import { retrieveForQuestion, type RetrievalResult } from "@/lib/documents/retrieval";
import { getDocumentSettings } from "@/lib/documents/settings";
import { ownedDocumentIds } from "./service";

/** Modes décidés par le routage JEV pour cette réponse (null : ancien fonctionnement par interrupteurs). */
export type RoutingPlan = {
  snapshot: RoutingSnapshot;
  research: boolean;
  /** Mode interactif retenu : Qwen produit une page HTML autonome (artifact). */
  interactive?: boolean;
  /** Demande de modification d'une page existante : son code actuel est transmis à Qwen. */
  artifactEdit?: { key: string; title: string; version: number; code: string } | null;
} | null;

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
    const projectId = body.projectId ? (await getOwnedProject(userId, body.projectId)).id : null;
    if (body.conversationId) {
      const found = await db.conversation.findFirst({ where: { id: body.conversationId, userId } });
      if (!found) throw notFound("Conversation introuvable.");
      conversation = found;
    } else {
      conversation = await db.conversation.create({ data: { userId, title: fallbackTitle(content), model, webSearch: body.webSearch ?? webSearchDefault, projectId } });
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
  if (body.projectId) await getOwnedProject(userId, body.projectId);
  conversation = await db.conversation.update({
    where: { id: conversation.id },
    data: { model, updatedAt: new Date(), ...(body.webSearch !== undefined ? { webSearch: body.webSearch } : {}), ...(body.projectId !== undefined ? { projectId: body.projectId } : {}) },
  });
  // Sélection de documents envoyée avec le message : limitée aux documents du projet de la conversation.
  if (body.documentIds !== undefined) {
    conversation = await db.conversation.update({ where: { id: conversation.id }, data: { documentIds: await ownedDocumentIds(conversation.projectId, body.documentIds) } });
  }
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

type GenerationOptions = {
  userId: string;
  prepared: PreparedGeneration;
  resolved: ResolvedModel;
  modelId: string;
  signal: AbortSignal;
  emit: Emit;
  routing?: RoutingPlan;
};

export async function runGeneration(opts: GenerationOptions) {
  // Les traitements documentaires en arrière-plan cèdent la place au chat pendant la génération.
  const end = chatStarted();
  try {
    await generate(opts);
  } finally {
    end();
  }
}

async function generate(opts: GenerationOptions) {
  const { prepared, resolved, emit, signal } = opts;
  const routing = opts.routing ?? null;
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
  if (routing) {
    emit({ type: "routing", routing: routing.snapshot });
    if (routing.snapshot.jevUnavailable) {
      const on = routing.snapshot.outcomes.filter((o) => o.state === "on").map((o) => MODE_LABELS[o.mode].toLowerCase());
      emit({
        type: "notice",
        code: "jev_unavailable",
        message: on.length
          ? `JEV est momentanément indisponible : modes appliqués d'office (${on.join(", ")}).`
          : "JEV est momentanément indisponible : réponse simple, sans réflexion approfondie ni recherche.",
      });
    }
  }
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
  const web = await researchPhase({ userId: opts.userId, prepared, resolved, app: prefs.app, provider, modelId: opts.modelId, question, contextLength: window.window, signal, emit, routing });
  if (web?.result.status === "cancelled") {
    const durationMs = Date.now() - startedAt;
    await web.persist({ generation: "cancelled", cited: [], durationMs });
    await persist({ status: "CANCELLED", durationMs }).catch(() => {});
    emit({ type: "done", status: "CANCELLED", durationMs });
    return;
  }
  const rag = web?.result.rag.length ? web.result.rag : null;

  // --- Documents du projet : recherche hybride et itérative avant la génération (jamais bloquante en cas d'échec)
  const docs = await documentPhase({ userId: opts.userId, prepared, resolved, provider, modelId: opts.modelId, question, capacity: window.capacity, withWeb: Boolean(rag), signal, emit });

  const clarify = createClarifyExtractor();
  const interactive = Boolean(routing?.interactive);
  const artifactEdit = interactive ? (routing?.artifactEdit ?? null) : null;
  // Contexte actif : consignes + mémoire sélectionnée + résumé de compaction + messages récents (voir src/lib/context).
  const ctx = await buildActiveContext({
    userId: opts.userId,
    conversation,
    history: prepared.history,
    modelId: opts.modelId,
    modelInfo: resolved.model,
    query: question,
    // Réponse documentée : pas de questions de précision, le format de citation prime.
    // Réponse documentée ou page interactive : pas de questions de précision (format de sortie imposé).
    clarifications: prefs.clarificationsEnabled && !web && !interactive && !docs?.passages.length,
    documentBlock: docs?.block ?? "",
  });
  const messages = [...ctx.assembled.messages];
  if (web) {
    messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${rag ? RAG_INSTRUCTIONS : web.result.status === "failed" ? NO_SEARCH_NOTICE : NO_RESULTS_NOTICE}` };
    const last = messages.at(-1);
    if (rag && last?.role === "user") {
      const projectBlock = last.content.match(/^<project_documents>[\s\S]*?<\/project_documents>/)?.[0];
      const projectContext = projectBlock ? `${projectBlock}\n\n` : "";
      messages[messages.length - 1] = { role: "user", content: `${projectContext}${buildRagUserMessage(question, rag, new Date())}` };
    }
  }
  if (docs) {
    const limits = docs.limitations.length ? `\nLimites connues de cette recherche documentaire (à signaler si elles affectent la réponse) :\n${docs.limitations.map((l) => `- ${l}`).join("\n")}` : "";
    messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${docs.instructions}${limits}` };
  }
  if (interactive) {
    messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${ARTIFACT_INSTRUCTIONS}${artifactEdit ? `\n\n${ARTIFACT_EDIT_INSTRUCTIONS}` : ""}` };
    const last = messages.at(-1);
    if (artifactEdit && last?.role === "user") {
      messages[messages.length - 1] = { role: "user", content: `${buildCurrentArtifactBlock(artifactEdit)}\n\n${last.content}` };
    }
  }
  // Le bloc <artifact> est retiré du texte affiché au fil du flux ; son code est collecté à part.
  const artifactEx = createArtifactExtractor();
  const produced: Array<{ title: string; code: string; complete: boolean }> = [];
  let artifactChars = 0;
  let lastProgress = 0;
  const pushText = (raw: string) => {
    // Hors mode interactif, le texte est transmis tel quel (aucune page n'est demandée à Qwen).
    if (!interactive) return handleArtifactEvent({ type: "text", text: raw });
    for (const ev of artifactEx.push(raw)) handleArtifactEvent(ev);
  };
  const handleArtifactEvent = (ev: ReturnType<typeof artifactEx.push>[number]) => {
    if (ev.type === "text") {
      const visible = clarify.push(ev.text);
      if (visible) {
        text += visible;
        emit({ type: "text", delta: visible });
      }
    } else if (ev.type === "start") {
      artifactChars = 0;
      lastProgress = 0;
      emit({ type: "artifact_start", title: ev.title });
    } else if (ev.type === "code") {
      artifactChars += ev.delta.length;
      if (artifactChars - lastProgress >= 1500) {
        lastProgress = artifactChars;
        emit({ type: "artifact_progress", chars: artifactChars });
      }
    } else {
      produced.push({ title: ev.title, code: ev.code, complete: ev.type === "end" });
    }
  };

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
        pushText(chunk.delta);
      }
      if (Date.now() - lastFlush > FLUSH_INTERVAL_MS) {
        lastFlush = Date.now();
        await persist({ content: text, thinking: thinking || null });
      }
    }
    emit({ type: "context_measured", promptTokens: measured.prompt, completionTokens: measured.completion });
    if (interactive) for (const ev of artifactEx.finish()) handleArtifactEvent(ev);
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
    // Pages interactives : enregistrées comme nouvelle version (modification) ou nouvel artifact.
    if (produced.length) {
      text = cleanVisibleText(text);
      for (const [i, a] of produced.entries()) {
        const saved = await saveArtifactVersion({
          conversationId: conversation.id,
          messageId: assistantMessage.id,
          title: a.title,
          code: a.code,
          complete: a.complete,
          key: i === 0 ? artifactEdit?.key : null,
          origin: i === 0 && artifactEdit ? "EDITED" : "GENERATED",
        });
        emit({ type: "artifact", artifact: toArtifactRef(saved), content: text });
        if (!saved.valid) emit({ type: "notice", code: "artifact_invalid", message: `La page « ${saved.title} » est inutilisable en l'état (${saved.issues[0]?.toLowerCase() ?? "code invalide"}). Ouvrez-la pour la faire corriger.` });
      }
    } else if (interactive) {
      emit({
        type: "notice",
        code: "artifact_missing",
        message: artifactEdit ? "Qwen n'a pas renvoyé de nouvelle version de la page interactive." : "Qwen n'a pas produit de page interactive pour cette réponse.",
      });
    }
    if (resolved.thinkingEffective && !thinking) {
      emit({ type: "notice", code: "thinking_not_returned", message: "Le fournisseur n'a renvoyé aucun flux de réflexion distinct pour cette réponse." });
    }
    // Références documentaires [Dn] : validées, puis confrontées au passage cité.
    if (docs) {
      const check = validateDocCitations(text, new Set(docs.passages.map((p) => p.n)));
      text = check.content;
      const checks = checkCitationSupport(text, new Map(docs.passages.map((p) => [p.n, p.content])));
      emit({ type: "doc_citations", content: text, cited: check.cited, checks, removed: check.removed });
      if (check.removed > 0) emit({ type: "notice", code: "doc_citations_removed", message: `${check.removed} référence(s) documentaire(s) ne correspondant à aucun passage transmis ont été retirées.` });
      const weak = checks.filter((c) => !c.supported).map((c) => `[D${c.n}]`);
      if (weak.length) emit({ type: "notice", code: "doc_citations_weak", message: `Référence(s) ${weak.join(", ")} faiblement étayée(s) par le passage cité : vérifiez le passage original.` });
      await persistDocuments(assistantMessage.id, docs, check.cited, checks);
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
    if (!text.trim() && !clarification && produced.length === 0) {
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
    await afterResponse({
      userId: opts.userId,
      conversationId: conversation.id,
      projectId: conversation.projectId,
      modelId: opts.modelId,
      userMessageId: prepared.history.at(-1)?.id ?? null,
      userMessage: question,
      answer: text,
      provider,
      think: resolved.model?.capabilities.thinking === "no" ? undefined : false,
      signal,
      emit,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const aborted = signal.aborted || (err instanceof ProviderError && err.code === "aborted");
    if (aborted) {
      // Texte partiel : les références invalides sont retirées avant enregistrement.
      if (web) text = validateCitations(text, new Set(rag?.map((s) => s.n) ?? [])).content;
      if (docs) {
        text = validateDocCitations(text, new Set(docs.passages.map((p) => p.n))).content;
        await persistDocuments(assistantMessage.id, docs, [], []).catch(() => {});
      }
      await web?.persist({ generation: "cancelled", cited: [], durationMs }).catch(() => {});
      await persist({ content: text, thinking: thinking || null, status: "CANCELLED", durationMs, ...usageData() }).catch(() => {});
      emit({ type: "done", status: "CANCELLED", durationMs });
      return;
    }
    const e = err instanceof ProviderError ? err : new ProviderError("Erreur inattendue pendant la génération.", "bad_response");
    await web?.persist({ generation: "failed", cited: [], durationMs }).catch(() => {});
    if (docs) await persistDocuments(assistantMessage.id, docs, [], []).catch(() => {});
    await persist({ content: text, thinking: thinking || null, status: "ERROR", error: e.message, durationMs, ...usageData() }).catch(() => {});
    await logEvent("ERROR", "chat", e.message, { model: opts.modelId, code: e.code, ...errorDetails(err) }, opts.userId);
    emit({ type: "error", code: e.code, message: e.message, hint: e.hint });
  }
}

/** Récupère les passages des documents du projet pour la question (null : pas de projet ou aucun document prêt). */
async function documentPhase(opts: {
  userId: string;
  prepared: PreparedGeneration;
  resolved: ResolvedModel;
  provider: LlmProvider;
  modelId: string;
  question: string;
  capacity: number;
  withWeb: boolean;
  signal: AbortSignal;
  emit: Emit;
}): Promise<RetrievalResult | null> {
  const { conversation } = opts.prepared;
  if (!conversation.projectId || !opts.question.trim()) return null;
  const started = Date.now();
  try {
    const settings = await getDocumentSettings();
    const context = opts.prepared.history
      .slice(-3, -1)
      .map((m) => `${m.role === "USER" ? "Utilisateur" : "Assistant"} : ${m.content.slice(0, 400)}`)
      .join("\n");
    const result = await retrieveForQuestion({
      userId: opts.userId,
      projectId: conversation.projectId,
      documentIds: conversation.documentIds,
      question: opts.question,
      context: context || null,
      llm: { provider: opts.provider, model: opts.modelId, think: opts.resolved.model?.capabilities.thinking === "no" ? undefined : false, signal: opts.signal },
      budgetTokens: Math.floor(opts.capacity * (opts.withWeb ? 0.3 : 0.45)),
      maxPassages: settings.retrievalMaxPassages,
      onStep: (label) => opts.emit({ type: "documents_step", label }),
    });
    if (!result) return null;
    opts.emit({ type: "documents", retrieval: { intent: result.intent, queries: result.queries, sources: result.passages.map(toSource), cited: null, checks: [], limitations: result.limitations } });
    if (result.limitations.length) opts.emit({ type: "notice", code: "documents_partial", message: result.limitations[0] });
    result.plan.filters.durationMs = Date.now() - started;
    return result;
  } catch (err) {
    if (opts.signal.aborted) return null;
    await logEvent("WARN", "documents", "Recherche documentaire impossible", { ...errorDetails(err), conversationId: conversation.id }, opts.userId);
    opts.emit({ type: "notice", code: "documents_partial", message: "La recherche dans les documents du projet a échoué : la réponse ne s'appuie sur aucun document." });
    return null;
  }
}

function toSource(p: RetrievalResult["passages"][number]) {
  const { content: _content, score: _score, ordinal: _ordinal, ...dto } = p;
  return dto;
}

async function persistDocuments(messageId: string, docs: RetrievalResult, cited: number[], checks: Array<{ n: number; supported: boolean; score: number }>) {
  const data = {
    plan: docs.plan as unknown as Prisma.InputJsonValue,
    queries: docs.queries.slice(0, 20),
    // Extrait plus long que l'aperçu : la fiche de la source montre le passage transmis au modèle.
    sources: docs.passages.map((p) => ({ ...toSource(p), excerpt: p.content.slice(0, 1500) })) as unknown as Prisma.InputJsonValue,
    cited,
    checks: checks as unknown as Prisma.InputJsonValue,
    limitations: docs.limitations.slice(0, 20),
    durationMs: typeof docs.plan.filters.durationMs === "number" ? docs.plan.filters.durationMs : null,
  };
  await db.documentRetrieval.upsert({ where: { messageId }, create: { messageId, ...data }, update: data });
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
  routing: RoutingPlan;
}): Promise<ResearchPhase | null> {
  const { prepared, app, emit, routing } = opts;
  if (!app.webSearchEnabled || !opts.question.trim()) return null;
  // Avec routage JEV, seule la décision (JEV, utilisateur ou repli) compte ; sinon, le contrôle de la conversation.
  if (routing ? !routing.research : !prepared.conversation.webSearch) return null;
  const previous = prepared.history.filter((m) => m.role === "ASSISTANT").at(-1);
  const previousUsedSearch = previous ? (await db.webSearch.count({ where: { messageId: previous.id, status: "DONE" } })) > 0 : false;
  const automaticDecision = decideSearch(opts.question, { previousUsedSearch });
  const routedOutcome = routing?.snapshot.outcomes.find((o) => o.mode === "research");
  const routedReason = routedOutcome ? `Recherche web : ${routedOutcome.reason.charAt(0).toLowerCase()}${routedOutcome.reason.slice(1)}` : undefined;
  // La recherche est décidée en amont (routage ou contrôle explicite de l'utilisateur) : elle est forcée,
  // même pour une question que l'heuristique jugerait simple. L'heuristique ne sert qu'à qualifier la requête.
  const decision = automaticDecision.search
    ? { ...automaticDecision, reason: routedReason ?? automaticDecision.reason }
    : {
        search: true as const,
        mode: "auto" as const,
        reason: routedReason ?? "Recherche Web activée pour cette conversation.",
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
