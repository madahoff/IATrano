import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { memoryJobSummary } from "@/lib/memory/jobs";
import { clearMemories, createMemory, getMemorySettings, listMemories, PROJECT_MEMORY_MAX_CHARS, toMemoryDTO } from "@/lib/memory/service";
import { MEMORY_KINDS } from "@/lib/memory/types";

// Mémoire persistante de l'utilisateur connecté — uniquement la sienne (filtrage par userId côté serveur).
// ?projectId=<id> : mémoire de ce projet ; ?projectId=personal : mémoire personnelle ; ?history=1 : versions remplacées incluses.

export const GET = route(async (req) => {
  const user = await requireApiUser("chat:use");
  const url = new URL(req.url);
  const scope = url.searchParams.get("projectId");
  const [memories, settings, projects, jobs] = await Promise.all([
    listMemories(user.id, { projectId: scope === null ? undefined : scope === "personal" ? null : scope, history: url.searchParams.get("history") === "1" }),
    getMemorySettings(user.id),
    db.project.findMany({ where: { userId: user.id }, select: { id: true, name: true, memoryEnabled: true }, orderBy: { name: "asc" } }),
    memoryJobSummary(user.id),
  ]);
  return json({ memories: memories.map(toMemoryDTO), settings, projects, jobs });
});

const createSchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  content: z.string().min(1, "La mémoire est vide.").max(PROJECT_MEMORY_MAX_CHARS, `${PROJECT_MEMORY_MAX_CHARS} caractères maximum.`),
  project: z.string().max(80).nullable().optional(),
  projectId: z.string().min(1).max(64).nullable().optional(),
  importance: z.number().int().min(1).max(5).optional(),
});

export const POST = route(async (req) => {
  const user = await requireApiUser("chat:use");
  const data = await parseJson(req, createSchema);
  const { memory, duplicateOf } = await createMemory(user.id, { ...data, source: "MANUAL" });
  return json({ memory: toMemoryDTO(memory), duplicateOf }, { status: duplicateOf ? 200 : 201 });
});

const clearSchema = z.object({
  confirm: z.literal(true, { error: "Confirmation requise." }),
  // absent : tout ; null : mémoire personnelle ; id : mémoire de ce projet
  projectId: z.string().min(1).max(64).nullable().optional(),
});

/** Efface les mémoires persistantes du compte (toutes, personnelles ou d'un projet). */
export const DELETE = route(async (req) => {
  const user = await requireApiUser("chat:use");
  const data = await parseJson(req, clearSchema);
  return json({ deleted: await clearMemories(user.id, { projectId: data.projectId }) });
});
