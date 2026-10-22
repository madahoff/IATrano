import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { deleteProjectMemory } from "@/lib/projects/service";

type Ctx = { params: Promise<{ id: string; memoryId: string }> };

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  const p = await params;
  await deleteProjectMemory(user.id, p.id, p.memoryId);
  return json({ ok: true });
});
