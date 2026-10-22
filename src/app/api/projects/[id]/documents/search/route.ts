import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { badRequest } from "@/lib/errors";
import { searchProjectDocuments } from "@/lib/documents/explore";

type Ctx = { params: Promise<{ id: string }> };

const TYPES = new Set(["TEXT", "TABLE", "CAPTION", "OCR", "TRANSCRIPT", "VISUAL", "NOTE"]);

/** Recherche de passages : ?q=…&mode=hybrid|exact|occurrences&documentId=…&pageFrom=&pageTo=&section=&type=TABLE,OCR */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const sp = new URL(req.url).searchParams;
  const q = sp.get("q")?.trim() ?? "";
  if (q.length < 2) throw badRequest("Saisissez au moins deux caractères.");
  if (q.length > 500) throw badRequest("Requête trop longue.");
  const num = (k: string) => {
    const v = sp.get(k);
    return v && /^\d{1,6}$/.test(v) ? Number(v) : null;
  };
  const mode = sp.get("mode") === "exact" ? "exact" : sp.get("mode") === "occurrences" ? "occurrences" : "hybrid";
  const types = (sp.get("type") ?? "").split(",").filter((t) => TYPES.has(t)) as never[];
  return json(
    await searchProjectDocuments(user.id, (await params).id, {
      q,
      mode,
      documentIds: sp.getAll("documentId").slice(0, 50),
      pageFrom: num("pageFrom"),
      pageTo: num("pageTo"),
      section: sp.get("section")?.slice(0, 120) || null,
      types,
    }),
  );
});
