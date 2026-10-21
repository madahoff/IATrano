import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { deleteMemory, MEMORY_MAX_CHARS, toMemoryDTO, updateMemory } from "@/lib/memory/service";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    content: z.string().min(1, "La mémoire est vide.").max(MEMORY_MAX_CHARS, `${MEMORY_MAX_CHARS} caractères maximum.`).optional(),
    kind: z.enum(["PREFERENCE", "FACT", "PROJECT"]).optional(),
    project: z.string().max(80).nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, "Aucune modification.");

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const data = await parseJson(req, patchSchema);
  return json({ memory: toMemoryDTO(await updateMemory(user.id, (await params).id, data)) });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  await deleteMemory(user.id, (await params).id);
  return json({ ok: true });
});
