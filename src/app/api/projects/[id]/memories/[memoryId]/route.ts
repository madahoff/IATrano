import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { deleteMemory } from "@/lib/memory/service";
import { getOwnedProject } from "@/lib/projects/service";

type Ctx = { params: Promise<{ id: string; memoryId: string }> };

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  const p = await params;
  const project = await getOwnedProject(user.id, p.id);
  if (!(await db.memory.count({ where: { id: p.memoryId, userId: user.id, projectId: project.id } }))) throw notFound("Mémoire de projet introuvable.");
  await deleteMemory(user.id, p.memoryId);
  return json({ ok: true });
});
