import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { deleteProject, getOwnedProject, toProjectDTO, updateProject } from "@/lib/projects/service";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().max(1000).nullable().optional(), instructions: z.string().max(8000).nullable().optional(), memoryEnabled: z.boolean().optional(), documentsEnabled: z.boolean().optional() });

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  return json({ project: toProjectDTO(await getOwnedProject(user.id, (await params).id)) });
});

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  return json({ project: toProjectDTO(await updateProject(user.id, (await params).id, await parseJson(req, schema))) });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  await deleteProject(user.id, (await params).id);
  return json({ ok: true });
});
