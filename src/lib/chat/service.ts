import "server-only";
import type { Artifact, Conversation, DocumentRetrieval, Message, Prisma, WebSearch } from "@prisma/client";
import { db } from "@/lib/db";
import { conversationFileDirs, removeFileDirs } from "@/lib/files/chat-files";
import { getOwnedProject } from "@/lib/projects/service";
import { notFound } from "@/lib/errors";
import { clarificationSchema } from "@/lib/llm/clarify";
import { parseSnapshot } from "@/lib/routing/decide";
import { toArtifactRef } from "@/lib/artifacts/types";
import { toDocumentRetrievalDTO } from "@/lib/documents/dto";
import { researchStepSchema, sourceSchema, type ResearchDTO } from "@/lib/search/research-types";
import type { Clarification, ConversationSummary, MessageDTO } from "./protocol";

// Couche d'accès aux conversations. Toutes les requêtes filtrent par userId :
// un utilisateur ne peut ni lire, ni modifier, ni supprimer la conversation d'un autre.

const STALE_STREAM_MS = 10 * 60_000;

const STATUS: Record<WebSearch["status"], ResearchDTO["status"]> = { RUNNING: "running", DONE: "done", FAILED: "failed", CANCELLED: "cancelled" };

/** Restitue la recherche persistée d'une réponse ; les entrées invalides sont ignorées plutôt qu'affichées. */
export function toResearchDTO(w: WebSearch, stale = false): ResearchDTO {
  const steps = (Array.isArray(w.steps) ? w.steps : []).flatMap((s) => {
    const r = researchStepSchema.safeParse(s);
    if (!r.success) return [];
    // Recherche interrompue (redémarrage) : aucune étape ne reste « en cours ».
    return stale && (r.data.status === "running" || r.data.status === "pending") ? [{ ...r.data, status: "failed" as const, detail: "Interrompu" }] : [r.data];
  });
  const sources = (Array.isArray(w.sources) ? w.sources : []).flatMap((s) => {
    const r = sourceSchema.safeParse(s);
    return r.success ? [r.data] : [];
  });
  const known = new Set(sources.map((s) => s.n));
  return {
    mode: w.mode === "deep" || w.mode === "explicit" ? w.mode : "auto",
    status: stale && w.status === "RUNNING" ? "cancelled" : STATUS[w.status],
    queries: w.queries,
    steps,
    sources,
    cited: w.status === "RUNNING" ? null : w.cited.filter((n) => known.has(n)),
    limitations: w.limitations,
    error: w.error,
    durationMs: w.durationMs,
  };
}

export function toMessageDTO(m: Message & { webSearch?: WebSearch | null; artifacts?: Artifact[]; documentRetrieval?: DocumentRetrieval | null }): MessageDTO {
  const clar = m.clarification ? clarificationSchema.safeParse(m.clarification) : null;
  // Un message resté « STREAMING » longtemps provient d'une génération interrompue (redémarrage, crash).
  const stale = m.status === "STREAMING" && Date.now() - m.updatedAt.getTime() > STALE_STREAM_MS;
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    thinking: m.thinking,
    thinkingEnabled: m.thinkingEnabled,
    clarification: clar?.success ? (clar.data as Clarification) : null,
    model: m.model,
    status: stale ? "CANCELLED" : m.status,
    error: stale ? "Génération interrompue." : m.error,
    durationMs: m.durationMs,
    createdAt: m.createdAt.toISOString(),
    research: m.webSearch ? toResearchDTO(m.webSearch, stale) : null,
    routing: parseSnapshot(m.routing),
    // Une carte par artifact : la version la plus récente produite par cette réponse (corrections comprises).
    artifacts: [...new Map((m.artifacts ?? []).map((a) => [a.key, a] as const)).values()].map(toArtifactRef),
    documents: m.documentRetrieval ? toDocumentRetrievalDTO(m.documentRetrieval) : null,
  };
}

export function toSummary(c: Pick<Conversation, "id" | "title" | "model" | "webSearch" | "projectId" | "archivedAt" | "updatedAt"> & { documentIds?: string[] }, snippet?: string): ConversationSummary {
  return {
    id: c.id,
    title: c.title ?? "Nouvelle conversation",
    model: c.model,
    webSearch: c.webSearch,
    projectId: c.projectId,
    documentIds: c.documentIds,
    archived: Boolean(c.archivedAt),
    updatedAt: c.updatedAt.toISOString(),
    snippet,
  };
}

export async function getOwnedConversation(userId: string, id: string) {
  const conv = await db.conversation.findFirst({ where: { id, userId } });
  if (!conv) throw notFound("Conversation introuvable.");
  return conv;
}

export async function getConversationWithMessages(userId: string, id: string) {
  const conv = await db.conversation.findFirst({
    where: { id, userId },
    include: { messages: { orderBy: { createdAt: "asc" }, include: { webSearch: true, documentRetrieval: true, artifacts: { orderBy: { version: "asc" } } } } },
  });
  if (!conv) return null;
  return { ...toSummary(conv), messages: conv.messages.map(toMessageDTO) };
}

function makeSnippet(content: string, q: string): string {
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return content.slice(0, 100);
  const start = Math.max(0, idx - 40);
  const end = Math.min(content.length, idx + q.length + 60);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).replace(/\s+/g, " ")}${end < content.length ? "…" : ""}`;
}

export async function listConversations(
  userId: string,
  opts: { q?: string; archived?: boolean; limit?: number; projectId?: string } = {},
): Promise<ConversationSummary[]> {
  const q = opts.q?.trim();
  const limit = Math.min(opts.limit ?? 100, 200);
  const where: Prisma.ConversationWhereInput = {
    userId,
    archivedAt: opts.archived ? { not: null } : null,
    // Filtre par projet : toujours combiné avec userId, donc limité aux projets de l'utilisateur.
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
  };
  if (q) {
    // Recherche dans les données persistées (titres + contenu des messages), accélérée par les index trigrammes.
    delete where.archivedAt;
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { messages: { some: { content: { contains: q, mode: "insensitive" } } } },
    ];
  }
  const convs = await db.conversation.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { id: true, title: true, model: true, webSearch: true, projectId: true, archivedAt: true, updatedAt: true },
  });
  if (!q || convs.length === 0) return convs.map((c) => toSummary(c));
  const hits = await db.message.findMany({
    where: { conversationId: { in: convs.map((c) => c.id) }, content: { contains: q, mode: "insensitive" } },
    select: { conversationId: true, content: true },
    orderBy: { createdAt: "asc" },
  });
  const firstHit = new Map<string, string>();
  for (const h of hits) if (!firstHit.has(h.conversationId)) firstHit.set(h.conversationId, makeSnippet(h.content, q));
  return convs.map((c) => toSummary(c, firstHit.get(c.id)));
}

export async function updateConversation(
  userId: string,
  id: string,
  data: { title?: string; archived?: boolean; model?: string; webSearch?: boolean; projectId?: string | null; documentIds?: string[] },
) {
  const current = await getOwnedConversation(userId, id);
  // Rattachement à un projet : uniquement à un projet de l'utilisateur (sinon 404, comme pour une conversation d'autrui).
  if (data.projectId) await getOwnedProject(userId, data.projectId);
  const updated = await db.conversation.update({
    where: { id },
    data: {
      ...(data.title !== undefined ? { title: data.title, titleGenerated: true } : {}),
      ...(data.archived !== undefined ? { archivedAt: data.archived ? new Date() : null } : {}),
      ...(data.model !== undefined ? { model: data.model } : {}),
      ...(data.webSearch !== undefined ? { webSearch: data.webSearch } : {}),
      ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
      // Sélection de documents : propre au projet ; réinitialisée quand la conversation change de projet.
      ...(data.projectId !== undefined && data.projectId !== current.projectId ? { documentIds: [] } : {}),
      ...(data.documentIds !== undefined ? { documentIds: await ownedDocumentIds(data.projectId ?? current.projectId, data.documentIds) } : {}),
    },
  });
  return toSummary(updated);
}

/** Ne conserve que des documents du projet de la conversation (le projet appartient déjà à l'utilisateur). */
export async function ownedDocumentIds(projectId: string | null | undefined, ids: string[]) {
  if (!projectId || !ids.length) return [];
  const found = await db.projectDocument.findMany({ where: { projectId, id: { in: ids.slice(0, 100) } }, select: { id: true } });
  return found.map((d) => d.id);
}

export async function deleteConversation(userId: string, id: string) {
  // deleteMany avec userId : aucune suppression possible hors de son propre espace. Les messages suivent (cascade).
  // Dossiers des fichiers joints relevés avant la suppression (les lignes ChatFile suivent par cascade).
  const fileDirs = await conversationFileDirs(userId, id);
  const res = await db.conversation.deleteMany({ where: { id, userId } });
  if (res.count === 0) throw notFound("Conversation introuvable.");
  await removeFileDirs(fileDirs);
}
