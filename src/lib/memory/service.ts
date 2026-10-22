import "server-only";
import type { Memory, MemoryCertainty, MemoryKind, MemorySource, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { findDuplicate } from "./select";
import { sensitiveReason } from "./sensitive";
import { fingerprint, topicHash } from "./tombstone";
import { normalizeTopic } from "./topics";

// Memory Storage & Management : accès à la mémoire persistante. Chaque requête est filtrée par userId :
// aucun souvenir d'un compte n'est lisible, modifiable ou supprimable depuis un autre compte (administrateurs
// compris). Portée : projectId null = mémoire personnelle ; sinon mémoire d'un projet appartenant à l'utilisateur.

/** Souvenirs actifs par compte (les versions remplacées, conservées pour l'historique, ne comptent pas). */
export const MAX_MEMORIES_PER_USER = 200;
export const MEMORY_MAX_CHARS = 500;
export const PROJECT_MEMORY_MAX_CHARS = 2000;

type Client = typeof db | Prisma.TransactionClient;

export type MemoryDTO = {
  id: string;
  kind: MemoryKind;
  project: string | null;
  projectId: string | null;
  projectName: string | null;
  content: string;
  topic: string | null;
  source: MemorySource;
  certainty: MemoryCertainty;
  status: "ACTIVE" | "SUPERSEDED";
  importance: number;
  mentionCount: number;
  supersededById: string | null;
  sourceConversationId: string | null;
  useCount: number;
  lastUsedAt: string | null;
  lastConfirmedAt: string;
  createdAt: string;
  updatedAt: string;
};

export function toMemoryDTO(m: Memory & { projectRef?: { name: string } | null }): MemoryDTO {
  return {
    id: m.id,
    kind: m.kind,
    project: m.project,
    projectId: m.projectId,
    projectName: m.projectRef?.name ?? null,
    content: m.content,
    topic: m.topic,
    source: m.source,
    certainty: m.certainty,
    status: m.status,
    importance: m.importance,
    mentionCount: m.mentionCount,
    supersededById: m.supersededById,
    sourceConversationId: m.sourceConversationId,
    useCount: m.useCount,
    lastUsedAt: m.lastUsedAt?.toISOString() ?? null,
    lastConfirmedAt: m.lastConfirmedAt.toISOString(),
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export type MemorySettings = { featureEnabled: boolean; enabled: boolean; autoSave: boolean };

export async function getMemorySettings(userId: string): Promise<MemorySettings> {
  const [app, user] = await Promise.all([
    db.appSettings.findUnique({ where: { id: 1 }, select: { memoryFeatureEnabled: true } }),
    db.userSettings.findUnique({ where: { userId }, select: { memoryEnabled: true, memoryAutoSave: true } }),
  ]);
  const featureEnabled = app?.memoryFeatureEnabled ?? true;
  return {
    featureEnabled,
    enabled: featureEnabled && (user?.memoryEnabled ?? true),
    autoSave: featureEnabled && (user?.memoryEnabled ?? true) && (user?.memoryAutoSave ?? true),
  };
}

export async function updateMemorySettings(userId: string, data: { memoryEnabled?: boolean; memoryAutoSave?: boolean }) {
  await db.userSettings.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  return getMemorySettings(userId);
}

/**
 * Souvenirs de l'utilisateur. projectId : undefined = toutes portées, null = personnels seulement, id = ce projet.
 * history : inclut les versions remplacées (SUPERSEDED).
 */
export function listMemories(userId: string, opts: { projectId?: string | null; history?: boolean } = {}) {
  return db.memory.findMany({
    where: { userId, ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}), ...(opts.history ? {} : { status: "ACTIVE" }) },
    include: { projectRef: { select: { name: true } } },
    orderBy: [{ kind: "asc" }, { updatedAt: "desc" }],
  });
}

/** Souvenirs actifs utilisables pour un prompt : personnels (si autorisés) et ceux du seul projet de la conversation. */
export function loadContextMemories(userId: string, scope: { personal: boolean; projectId: string | null }) {
  const or: Prisma.MemoryWhereInput[] = [];
  if (scope.personal) or.push({ projectId: null });
  if (scope.projectId) or.push({ projectId: scope.projectId });
  if (or.length === 0) return Promise.resolve([]);
  return db.memory.findMany({ where: { userId, status: "ACTIVE", OR: or } });
}

function clean(content: string, max = MEMORY_MAX_CHARS) {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length < 3) throw badRequest("La mémoire est vide.");
  if (text.length > max) throw badRequest(`Une mémoire ne doit pas dépasser ${max} caractères.`);
  const reason = sensitiveReason(text);
  if (reason) throw badRequest(reason, "sensitive_content");
  return text;
}

function cleanProject(kind: MemoryKind, project: string | null | undefined, projectId: string | null) {
  if (kind !== "PROJECT" || projectId) return null;
  const p = project?.replace(/\s+/g, " ").trim();
  if (!p) throw badRequest("Indiquez le nom du projet.");
  return p.slice(0, 80);
}

async function assertOwnedProject(userId: string, projectId: string | null | undefined) {
  if (!projectId) return null;
  const project = await db.project.findFirst({ where: { id: projectId, userId }, select: { id: true } });
  if (!project) throw notFound("Projet introuvable.");
  return project.id;
}

export function countActiveMemories(client: Client, userId: string) {
  return client.memory.count({ where: { userId, status: "ACTIVE" } });
}

export async function createMemory(
  userId: string,
  input: {
    kind: MemoryKind;
    content: string;
    project?: string | null;
    projectId?: string | null;
    topic?: string | null;
    source?: MemorySource;
    certainty?: MemoryCertainty;
    importance?: number;
    sourceConversationId?: string | null;
    sourceDocumentId?: string | null;
  },
): Promise<{ memory: Memory; duplicateOf: boolean }> {
  const projectId = await assertOwnedProject(userId, input.projectId);
  const kind = projectId && input.kind === "PROJECT" ? "FACT" : input.kind;
  const content = clean(input.content, projectId ? PROJECT_MEMORY_MAX_CHARS : MEMORY_MAX_CHARS);
  const project = cleanProject(kind, input.project, projectId);
  if (input.sourceDocumentId) {
    const doc = projectId ? await db.projectDocument.findFirst({ where: { id: input.sourceDocumentId, projectId } }) : null;
    if (!doc) throw notFound("Document source introuvable.");
  }
  const existing = await db.memory.findMany({ where: { userId, status: "ACTIVE", projectId, kind, project } });
  // Doublon : on rafraîchit le souvenir existant plutôt que d'en créer un second.
  const dup = findDuplicate(content, existing);
  if (dup) {
    const memory = await db.memory.update({
      where: { id: dup.id },
      data: { content, certainty: "CONFIRMED", mentionCount: { increment: 1 }, lastConfirmedAt: new Date() },
    });
    return { memory, duplicateOf: true };
  }
  if ((await countActiveMemories(db, userId)) >= MAX_MEMORIES_PER_USER) {
    throw new AppError(409, "memory_full", `Limite de ${MAX_MEMORIES_PER_USER} mémoires atteinte : supprimez-en avant d'en ajouter.`);
  }
  const memory = await db.memory.create({
    data: {
      userId,
      projectId,
      kind,
      project,
      content,
      topic: normalizeTopic(input.topic),
      source: input.source ?? "MANUAL",
      certainty: input.certainty ?? "CONFIRMED",
      importance: input.importance ?? (input.source === "AUTO" ? 3 : 4),
      sourceConversationId: input.sourceConversationId ?? null,
      sourceDocumentId: input.sourceDocumentId ?? null,
    },
  });
  return { memory, duplicateOf: false };
}

/** Correction par l'utilisateur : le souvenir devient confirmé. Seules les versions actives sont modifiables. */
export async function updateMemory(
  userId: string,
  id: string,
  input: { content?: string; kind?: MemoryKind; project?: string | null; certainty?: "CONFIRMED"; importance?: number },
) {
  const current = await db.memory.findFirst({ where: { id, userId, status: "ACTIVE" } });
  if (!current) throw notFound("Mémoire introuvable.");
  const kind = current.projectId && input.kind === "PROJECT" ? "FACT" : (input.kind ?? current.kind);
  const res = await db.memory.updateMany({
    where: { id, userId, status: "ACTIVE" },
    data: {
      kind,
      content: input.content !== undefined ? clean(input.content, current.projectId ? PROJECT_MEMORY_MAX_CHARS : MEMORY_MAX_CHARS) : undefined,
      project: input.project !== undefined || input.kind !== undefined ? cleanProject(kind, input.project ?? current.project, current.projectId) : undefined,
      importance: input.importance !== undefined ? Math.min(5, Math.max(1, Math.round(input.importance))) : undefined,
      certainty: "CONFIRMED",
      lastConfirmedAt: new Date(),
    },
  });
  if (res.count === 0) throw notFound("Mémoire introuvable.");
  return (await db.memory.findFirst({ where: { id, userId }, include: { projectRef: { select: { name: true } } } }))!;
}

/**
 * Oubli effectif : supprime les souvenirs, leurs versions antérieures (historique) et enregistre une empreinte
 * hachée pour qu'aucune analyse en attente ne les recrée. active : souvenirs actifs supprimés ; total : lignes visées trouvées.
 */
export async function forgetMemories(client: Client, userId: string, ids: string[]): Promise<{ active: number; total: number }> {
  if (ids.length === 0) return { active: 0, total: 0 };
  const targets = await client.memory.findMany({ where: { userId, id: { in: ids } } });
  if (targets.length === 0) return { active: 0, total: 0 };
  const all = new Set(targets.map((t) => t.id));
  let frontier = [...all];
  while (frontier.length) {
    const previous = await client.memory.findMany({ where: { userId, supersededById: { in: frontier } }, select: { id: true } });
    frontier = previous.map((p) => p.id).filter((pid) => !all.has(pid));
    frontier.forEach((pid) => all.add(pid));
  }
  await client.memory.deleteMany({ where: { userId, id: { in: [...all] } } });
  await client.memoryTombstone.createMany({
    data: targets.map((t) => ({ userId, projectId: t.projectId, fingerprint: fingerprint(t.content), topicHash: topicHash(t.topic) })),
  });
  return { active: targets.filter((t) => t.status === "ACTIVE").length, total: targets.length };
}

export async function deleteMemory(userId: string, id: string) {
  const { total } = await db.$transaction((tx) => forgetMemories(tx, userId, [id]));
  if (total === 0) throw notFound("Mémoire introuvable.");
}

/**
 * Efface toute la mémoire (projectId undefined), la mémoire personnelle (null) ou celle d'un projet.
 * Les analyses en attente de la même portée sont abandonnées : rien ne réapparaît après un effacement.
 */
export async function clearMemories(userId: string, opts: { projectId?: string | null } = {}) {
  if (opts.projectId) await assertOwnedProject(userId, opts.projectId);
  const where = { userId, ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}) };
  return db.$transaction(async (tx) => {
    const active = await tx.memory.count({ where: { ...where, status: "ACTIVE" } });
    await tx.memory.deleteMany({ where });
    await tx.memoryJob.updateMany({
      where: { userId, status: { in: ["PENDING", "FAILED"] }, ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}) },
      data: { status: "SKIPPED", error: "Mémoire effacée par l'utilisateur." },
    });
    return active;
  });
}

export async function markMemoriesUsed(userId: string, ids: string[]) {
  if (ids.length === 0) return;
  await db.memory.updateMany({ where: { userId, id: { in: ids } }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() } });
}
