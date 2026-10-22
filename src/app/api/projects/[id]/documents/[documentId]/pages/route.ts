import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { listPages } from "@/lib/documents/service";

type Ctx = { params: Promise<{ id: string; documentId: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  const p = await params;
  const pages = await listPages(user.id, p.id, p.documentId);
  return json({ pages: pages.map(({ imagePath, ...rest }) => ({ ...rest, hasImage: Boolean(imagePath) })) });
});
