import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { deleteProjectDocument } from "@/lib/projects/service";

type Ctx = { params: Promise<{ id: string; documentId: string }> };

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  const p = await params;
  await deleteProjectDocument(user.id, p.id, p.documentId);
  return json({ ok: true });
});
