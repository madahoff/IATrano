import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { deleteInsight } from "@/lib/documents/service";

type Ctx = { params: Promise<{ id: string; documentId: string; insightId: string }> };

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  const p = await params;
  await deleteInsight(user.id, p.id, p.documentId, p.insightId);
  return json({ ok: true });
});
