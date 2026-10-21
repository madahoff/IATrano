import "server-only";
import type { Memory, MemoryKind, MemorySource } from "@prisma/client";
import { db } from "@/lib/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { findDuplicate } from "./select";
import { sensitiveReason } from "./sensitive";

// Accès à la mémoire persistante. Chaque requête est filtrée par userId : aucun souvenir d'un compte
// n'est lisible, modifiable ou supprimable depuis un autre compte (administrateurs compris).

export const MAX_MEMORIES_PER_USER = 200;
export const MEMORY_MAX_CHARS = 500;

export type MemoryDTO = {
  id: string;
  kind: MemoryKind;
  project: string | null;
  content: string;
  source: MemorySource;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toMemoryDTO(m: Memory): MemoryDTO {
  return {
    id: m.id,
    kind: m.kind,
    project: m.project,
    content: m.content,
    source: m.source,
    useCount: m.useCount,
    lastUsedAt: m.lastUsedAt?.toISOString() ?? null,
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

export function listMemories(userId: string) {
  return db.memory.findMany({ where: { userId }, orderBy: [{ kind: "asc" }, { updatedAt: "desc" }] });
}

function clean(content: string) {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length < 3) throw badRequest("La mémoire est vide.");
  if (text.length > MEMORY_MAX_CHARS) throw badRequest(`Une mémoire ne doit pas dépasser ${MEMORY_MAX_CHARS} caractères.`);
  const reason = sensitiveReason(text);
  if (reason) throw badRequest(reason, "sensitive_content");
  return text;
}

function cleanProject(kind: MemoryKind, project: string | null | undefined) {
  if (kind !== "PROJECT") return null;
  const p = project?.replace(/\s+/g, " ").trim();
  if (!p) throw badRequest("Indiquez le nom du projet.");
  return p.slice(0, 80);
}

export async function createMemory(
  userId: string,
  input: { kind: MemoryKind; content: string; project?: string | null; source?: MemorySource; sourceConversationId?: string | null },
): Promise<{ memory: Memory; duplicateOf: boolean }> {
  const content = clean(input.content);
  const project = cleanProject(input.kind, input.project);
  const existing = await db.memory.findMany({ where: { userId } });
  // Doublon : on rafraîchit la mémoire existante plutôt que d'en créer une seconde.
  const dup = findDuplicate(content, existing.filter((m) => m.kind === input.kind && m.project === project));
  if (dup) {
    const memory = await db.memory.update({ where: { id: dup.id }, data: { content, updatedAt: new Date() } });
    return { memory, duplicateOf: true };
  }
  if (existing.length >= MAX_MEMORIES_PER_USER) {
    throw new AppError(409, "memory_full", `Limite de ${MAX_MEMORIES_PER_USER} mémoires atteinte : supprimez-en avant d'en ajouter.`);
  }
  const memory = await db.memory.create({
    data: { userId, kind: input.kind, project, content, source: input.source ?? "MANUAL", sourceConversationId: input.sourceConversationId ?? null },
  });
  return { memory, duplicateOf: false };
}

export async function updateMemory(userId: string, id: string, input: { content?: string; kind?: MemoryKind; project?: string | null }) {
  const current = await db.memory.findFirst({ where: { id, userId } });
  if (!current) throw notFound("Mémoire introuvable.");
  const kind = input.kind ?? current.kind;
  const res = await db.memory.updateMany({
    where: { id, userId },
    data: {
      kind,
      content: input.content !== undefined ? clean(input.content) : undefined,
      project: input.project !== undefined || input.kind !== undefined ? cleanProject(kind, input.project ?? current.project) : undefined,
    },
  });
  if (res.count === 0) throw notFound("Mémoire introuvable.");
  return (await db.memory.findFirst({ where: { id, userId } }))!;
}

export async function deleteMemory(userId: string, id: string) {
  const res = await db.memory.deleteMany({ where: { id, userId } });
  if (res.count === 0) throw notFound("Mémoire introuvable.");
}

export async function clearMemories(userId: string) {
  const res = await db.memory.deleteMany({ where: { userId } });
  return res.count;
}

export async function markMemoriesUsed(userId: string, ids: string[]) {
  if (ids.length === 0) return;
  await db.memory.updateMany({ where: { userId, id: { in: ids } }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() } });
}
