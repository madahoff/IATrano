import "server-only";
import type { AppSettings, ContextSummary, Conversation, Message } from "@prisma/client";
import { db } from "@/lib/db";
import { notFound } from "@/lib/errors";
import type { Clarification } from "@/lib/chat/protocol";
import { getModels } from "@/lib/llm/discovery";
import type { HistoryMessage } from "@/lib/llm/prompt";
import { ESTIMATOR_LABEL } from "@/lib/llm/tokens";
import type { ModelInfo } from "@/lib/llm/types";
import { getMemorySettings, loadContextMemories } from "@/lib/memory/service";
import { memoryBudget, memoryLine, selectMemories } from "@/lib/memory/select";
import { getEffectivePreferences } from "@/lib/settings/service";
import { assembleContext, type AssembledContext } from "./assemble";
import { countMessagesTokens } from "@/lib/llm/tokens";
import { getProjectPromptContext, projectDocumentBlock } from "@/lib/projects/service";
import { splitForCompaction } from "./policy";
import type { SourceRef } from "./summary";
import { contextState, type ContextUsageDTO, type StoredRequestUsage, type SummaryDTO, type SummarySections } from "./types";
import { resolveWindow, type ResolvedWindow } from "./window";

// Point d'entrée serveur de la gestion du contexte : fenêtre effective du modèle, résumé actif,
// mémoire sélectionnée, assemblage du prompt et mesure de la consommation.

export async function getModelInfo(modelId: string): Promise<ModelInfo | null> {
  const snapshot = await getModels();
  return snapshot.models.find((m) => m.id === modelId) ?? null;
}

export async function getWindowFor(modelId: string, app: AppSettings, info?: ModelInfo | null): Promise<ResolvedWindow> {
  const [model, override] = await Promise.all([
    info !== undefined ? info : getModelInfo(modelId),
    db.modelContextConfig.findUnique({ where: { model: modelId } }),
  ]);
  return resolveWindow({
    providerKind: app.providerType,
    providerMax: model?.contextLength,
    override: override ? { contextWindow: override.contextWindow, responseReserve: override.responseReserve } : null,
    appDefaultWindow: app.contextDefaultWindow,
    appReserve: app.contextResponseReserve,
  });
}

/**
 * Résumé actif valide. Si des messages qu'il couvre ont été modifiés ou supprimés (édition, régénération),
 * il est invalidé et la version précédente encore valide reprend sa place ; sinon l'historique brut est utilisé.
 */
export async function resolveActiveSummary(conversationId: string): Promise<ContextSummary | null> {
  const candidates = await db.contextSummary.findMany({
    where: { conversationId, status: { in: ["ACTIVE", "SUPERSEDED"] } },
    orderBy: { version: "desc" },
    take: 5,
  });
  for (const s of candidates) {
    const [boundary, edited] = await Promise.all([
      db.message.findFirst({ where: { id: s.coveredMessageId, conversationId }, select: { id: true } }),
      db.message.count({ where: { conversationId, createdAt: { lte: s.coveredUntil }, updatedAt: { gt: s.createdAt } } }),
    ]);
    if (boundary && edited === 0) {
      if (s.status !== "ACTIVE") {
        await db.$transaction([
          db.contextSummary.updateMany({ where: { conversationId, status: "ACTIVE" }, data: { status: "STALE" } }),
          db.contextSummary.update({ where: { id: s.id }, data: { status: "ACTIVE" } }),
        ]);
      }
      return { ...s, status: "ACTIVE" };
    }
    await db.contextSummary.update({ where: { id: s.id }, data: { status: "STALE" } });
  }
  return null;
}

export function toHistory(messages: Message[]): HistoryMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content, clarification: m.clarification as Clarification | null }));
}

export function readStoredUsage(value: unknown): StoredRequestUsage | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<StoredRequestUsage>;
  if (typeof v.estimated !== "number" || typeof v.window !== "number" || !v.parts) return null;
  return v as StoredRequestUsage;
}

/** Sources Web citées dans des réponses (pour conserver URL et titres lors d'une compaction). */
export async function citedSources(messageIds: string[]): Promise<SourceRef[]> {
  if (messageIds.length === 0) return [];
  const rows = await db.webSearch.findMany({ where: { messageId: { in: messageIds } }, select: { sources: true, cited: true }, orderBy: { createdAt: "asc" } });
  const out: SourceRef[] = [];
  for (const r of rows) {
    const list = Array.isArray(r.sources) ? (r.sources as Array<{ n?: unknown; url?: unknown; title?: unknown }>) : [];
    for (const s of list) {
      if (typeof s.url !== "string" || typeof s.n !== "number") continue;
      if (r.cited.length && !r.cited.includes(s.n)) continue;
      out.push({ url: s.url, title: typeof s.title === "string" ? s.title : s.url });
    }
  }
  return out;
}

export type ActiveContext = {
  app: AppSettings;
  window: ResolvedWindow;
  assembled: AssembledContext;
  summary: ContextSummary | null;
  summarized: number;
  memoryIds: string[];
  memoryEnabled: boolean;
  injected: Array<{ id: string; kind: string; content: string; scope: "personal" | "project" }>;
};

/**
 * Construit le contexte actif d'une conversation pour un modèle.
 * `history` : messages de la conversation dans l'ordre (déjà chargés), `query` : demande courante (sélection de la mémoire).
 */
export async function buildActiveContext(opts: {
  userId: string;
  conversation: (Pick<Conversation, "id"> & { projectId?: string | null }) | null;
  history: Message[];
  modelId: string;
  modelInfo?: ModelInfo | null;
  query: string;
  /** Remplace la préférence « questions de précision » (désactivées pour une réponse documentée). */
  clarifications?: boolean;
  /** Résumé à utiliser à la place du résumé actif (simulation de l'état après compaction). */
  summaryTextOverride?: string;
  /** Passages des documents du projet retenus pour cette demande (voir src/lib/documents/retrieval). */
  documentBlock?: string;
}): Promise<ActiveContext> {
  const prefs = await getEffectivePreferences(opts.userId);
  const app = prefs.app;
  const [window, summary, memSettings] = await Promise.all([
    getWindowFor(opts.modelId, app, opts.modelInfo),
    opts.conversation ? resolveActiveSummary(opts.conversation.id) : Promise.resolve(null),
    getMemorySettings(opts.userId),
  ]);
  const project = await getProjectPromptContext(opts.userId, opts.conversation?.projectId);
  const after = summary ? opts.history.filter((m) => m.createdAt > summary.coveredUntil) : opts.history;

  // Mémoire : personnelle (si l'utilisateur l'utilise) + celle du projet de la conversation (si le projet l'active).
  // Seuls les souvenirs pertinents pour la demande entrent dans le budget ; les autres projets ne sont jamais lus.
  const memoryProjectId = project.memoryEnabled ? (opts.conversation?.projectId ?? null) : null;
  let injected: ActiveContext["injected"] = [];
  if (memSettings.enabled || memoryProjectId) {
    const all = await loadContextMemories(opts.userId, { personal: memSettings.enabled, projectId: memoryProjectId });
    const objective = (summary?.content as Partial<SummarySections> | null)?.objective ?? "";
    injected = selectMemories(all, `${opts.query}\n${objective}`, memoryBudget(window.capacity), { projectId: memoryProjectId }).map((m) => ({
      id: m.id,
      kind: m.kind,
      content: memoryLine(m),
      scope: m.projectId ? ("project" as const) : ("personal" as const),
    }));
  }

  const assembled = assembleContext({
    systemPrompt: [app.systemPrompt, project.instructions ? `INSTRUCTIONS DU PROJET :\n${project.instructions}` : ""].filter(Boolean).join("\n\n"),
    clarifications: opts.clarifications ?? prefs.clarificationsEnabled,
    memoryLines: injected.filter((m) => m.scope === "personal").map((m) => m.content),
    projectMemoryLines: injected.filter((m) => m.scope === "project").map((m) => m.content),
    projectName: project.name,
    memoryActive: memSettings.enabled,
    summaryText: opts.summaryTextOverride ?? summary?.text,
    history: toHistory(after),
    capacity: window.capacity,
  });
  const projectDocs = opts.documentBlock ?? projectDocumentBlock(project.documents);
  if (projectDocs && assembled.messages.at(-1)?.role === "user") {
    assembled.messages[assembled.messages.length - 1] = { role: "user", content: `${projectDocs}\n\n${assembled.messages.at(-1)!.content}` };
    const before = assembled.total;
    assembled.total = countMessagesTokens(assembled.messages);
    assembled.parts.rag += Math.max(0, assembled.total - before);
  }
  return {
    app,
    window,
    assembled,
    summary,
    summarized: opts.history.length - after.length,
    memoryIds: injected.map((m) => m.id),
    memoryEnabled: memSettings.enabled,
    injected,
  };
}

export function toSummaryDTO(s: ContextSummary, versions: number): SummaryDTO {
  return {
    version: s.version,
    createdAt: s.createdAt.toISOString(),
    model: s.model,
    trigger: s.trigger === "auto" ? "auto" : "manual",
    coveredCount: s.coveredCount,
    coveredUntil: s.coveredUntil.toISOString(),
    sections: s.content as SummarySections,
    tokens: s.summaryTokens,
    tokensBefore: s.tokensBefore,
    tokensAfter: s.tokensAfter,
    versions,
  };
}

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

/** Consommation du contexte que la PROCHAINE génération occupera (hors message pas encore écrit). */
export async function computeContextUsage(userId: string, conversationId: string | null, modelId: string): Promise<ContextUsageDTO> {
  const conversation = conversationId ? await db.conversation.findFirst({ where: { id: conversationId, userId } }) : null;
  if (conversationId && !conversation) throw notFound("Conversation introuvable.");
  const history = conversation ? await db.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } }) : [];
  const lastUser = [...history].reverse().find((m) => m.role === "USER");
  const ctx = await buildActiveContext({ userId, conversation, history, modelId, query: lastUser?.content ?? "" });
  const { window, assembled, app } = ctx;

  // Dernière requête réellement envoyée, et recalibrage de l'estimation par la mesure du fournisseur.
  const lastAssistant = [...history].reverse().find((m) => m.role === "ASSISTANT" && m.contextUsage);
  const stored = lastAssistant ? readStoredUsage(lastAssistant.contextUsage) : null;
  let calibration: ContextUsageDTO["calibration"] = null;
  if (lastAssistant && stored && lastAssistant.promptTokens && lastAssistant.model === modelId && stored.estimated > 50) {
    calibration = {
      factor: clamp(lastAssistant.promptTokens / stored.estimated, 0.6, 1.6),
      measured: lastAssistant.promptTokens,
      estimated: stored.estimated,
      at: lastAssistant.createdAt.toISOString(),
    };
  }
  const used = Math.round(assembled.total * (calibration?.factor ?? 1));
  const percent = Math.round((used / window.capacity) * 1000) / 10;
  const thresholds = { warn: app.contextWarnPct, high: app.contextHighPct, autoCompact: app.contextAutoCompactPct };
  const afterSummary = ctx.summary ? history.filter((m) => m.createdAt > ctx.summary!.coveredUntil) : history;
  const versions = conversation ? await db.contextSummary.count({ where: { conversationId: conversation.id, status: { not: "STALE" } } }) : 0;

  return {
    model: modelId,
    window: window.window,
    reserve: window.reserve,
    capacity: window.capacity,
    windowSource: window.source,
    providerMax: window.providerMax,
    used,
    usedRaw: assembled.total,
    remaining: window.capacity - used,
    percent,
    state: contextState(percent, thresholds),
    thresholds,
    estimated: true,
    estimator: ESTIMATOR_LABEL,
    calibration,
    parts: assembled.parts,
    messages: {
      total: history.filter((m) => m.content.trim()).length,
      sent: assembled.sentMessages,
      summarized: ctx.summarized,
      dropped: assembled.droppedMessages,
    },
    lastRequest:
      lastAssistant && stored
        ? {
            at: lastAssistant.createdAt.toISOString(),
            model: lastAssistant.model,
            promptTokens: lastAssistant.promptTokens,
            completionTokens: lastAssistant.completionTokens,
            estimated: stored.estimated,
            window: stored.window,
            rag: stored.parts.rag,
            dropped: stored.droppedMessages,
          }
        : null,
    summary: ctx.summary ? toSummaryDTO(ctx.summary, versions) : null,
    compaction: {
      status: conversation?.compactionStatus ?? null,
      at: (conversation?.compactedAt ?? conversation?.compactionStartedAt)?.toISOString() ?? null,
      error: conversation?.compactionError ?? null,
    },
    compactable: splitForCompaction(afterSummary.filter((m) => m.status !== "STREAMING"), window.capacity).toSummarize.length,
    memory: { enabled: ctx.memoryEnabled, injected: ctx.injected },
  };
}
