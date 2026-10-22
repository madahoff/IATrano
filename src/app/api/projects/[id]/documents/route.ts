import { Readable } from "node:stream";
import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { badRequest } from "@/lib/errors";
import { importDocument, listDocuments, type ImportResult } from "@/lib/documents/service";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";
export const maxDuration = 900;

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  return json({ documents: await listDocuments(user.id, (await params).id) });
});

/**
 * Import. Corps brut (recommandé, sans limite de mémoire) : en-tête `x-file-name` (encodé URI) et
 * `?replace=<documentId>` pour une nouvelle version. Formulaire multipart accepté pour plusieurs petits fichiers.
 * Le traitement se poursuit en arrière-plan : la réponse arrive dès que le fichier est enregistré.
 */
export const POST = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const projectId = (await params).id;
  const replaceId = new URL(req.url).searchParams.get("replace");
  const type = req.headers.get("content-type") ?? "";
  const results: ImportResult[] = [];
  if (type.startsWith("multipart/form-data")) {
    const form = await req.formData();
    const files = form.getAll("files").filter((v): v is File => typeof File !== "undefined" && v instanceof File);
    if (!files.length) throw badRequest("Sélectionnez au moins un fichier.");
    for (const file of files) results.push(await importDocument(user.id, projectId, { name: file.name, body: Readable.fromWeb(file.stream() as never), replaceId }));
  } else {
    const raw = req.headers.get("x-file-name");
    if (!raw || !req.body) throw badRequest("En-tête x-file-name et contenu du fichier requis.");
    let name: string;
    try {
      name = decodeURIComponent(raw);
    } catch {
      throw badRequest("Nom de fichier invalide.");
    }
    results.push(await importDocument(user.id, projectId, { name, body: req.body, replaceId }));
  }
  return json({ documents: results.map((r) => r.document), outcomes: results.map((r) => r.outcome) });
});
