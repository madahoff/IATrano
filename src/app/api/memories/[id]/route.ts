import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { deleteMemory, PROJECT_MEMORY_MAX_CHARS, toMemoryDTO, updateMemory } from "@/lib/memory/service";
import { MEMORY_KINDS } from "@/lib/memory/types";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    content: z.string().min(1, "La mémoire est vide.").max(PROJECT_MEMORY_MAX_CHARS, `${PROJECT_MEMORY_MAX_CHARS} caractères maximum.`).optional(),
    kind: z.enum(MEMORY_KINDS).optional(),
    project: z.string().max(80).nullable().optional(),
    // Confirmer une hypothèse (« non confirmé ») sans la reformuler
    certainty: z.literal("CONFIRMED").optional(),
    importance: z.number().int().min(1).max(5).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, "Aucune modification.");

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const data = await parseJson(req, patchSchema);
  return json({ memory: toMemoryDTO(await updateMemory(user.id, (await params).id, data)) });
});

/** Oubli effectif : le souvenir, ses versions antérieures, et aucune analyse en attente ne peut le recréer. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  await deleteMemory(user.id, (await params).id);
  return json({ ok: true });
});
