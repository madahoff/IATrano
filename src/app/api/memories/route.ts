import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { clearMemories, createMemory, getMemorySettings, listMemories, MEMORY_MAX_CHARS, toMemoryDTO } from "@/lib/memory/service";

// Mémoire persistante de l'utilisateur connecté — uniquement la sienne (filtrage par userId côté serveur).

export const GET = route(async () => {
  const user = await requireApiUser("chat:use");
  const [memories, settings] = await Promise.all([listMemories(user.id), getMemorySettings(user.id)]);
  return json({ memories: memories.map(toMemoryDTO), settings });
});

const createSchema = z.object({
  kind: z.enum(["PREFERENCE", "FACT", "PROJECT"]),
  content: z.string().min(1, "La mémoire est vide.").max(MEMORY_MAX_CHARS, `${MEMORY_MAX_CHARS} caractères maximum.`),
  project: z.string().max(80).nullable().optional(),
});

export const POST = route(async (req) => {
  const user = await requireApiUser("chat:use");
  const data = await parseJson(req, createSchema);
  const { memory, duplicateOf } = await createMemory(user.id, { ...data, source: "MANUAL" });
  return json({ memory: toMemoryDTO(memory), duplicateOf }, { status: duplicateOf ? 200 : 201 });
});

const clearSchema = z.object({ confirm: z.literal(true, { error: "Confirmation requise." }) });

/** Efface toutes les mémoires persistantes du compte. */
export const DELETE = route(async (req) => {
  const user = await requireApiUser("chat:use");
  await parseJson(req, clearSchema);
  return json({ deleted: await clearMemories(user.id) });
});
