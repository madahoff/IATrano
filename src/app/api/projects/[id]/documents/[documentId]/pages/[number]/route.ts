import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { badRequest } from "@/lib/errors";
import { getPage } from "@/lib/documents/service";

type Ctx = { params: Promise<{ id: string; documentId: string; number: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  const p = await params;
  const n = Number(p.number);
  if (!Number.isInteger(n) || n < 1) throw badRequest("Numéro de page invalide.");
  return json(await getPage(user.id, p.id, p.documentId, n));
});
