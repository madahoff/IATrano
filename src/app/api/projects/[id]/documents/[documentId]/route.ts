import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { deleteDocument, getDocumentDetail } from "@/lib/documents/service";

type Ctx = { params: Promise<{ id: string; documentId: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  const p = await params;
  return json(await getDocumentDetail(user.id, p.id, p.documentId));
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  const p = await params;
  await deleteDocument(user.id, p.id, p.documentId);
  return json({ ok: true });
});
