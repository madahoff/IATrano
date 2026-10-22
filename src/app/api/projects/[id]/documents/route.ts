import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { importProjectDocument, listProjectDocuments } from "@/lib/projects/service";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  return json({ documents: await listProjectDocuments(user.id, (await params).id) });
});

export const POST = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const form = await req.formData();
  const files = form.getAll("files").filter((value): value is File => typeof File !== "undefined" && value instanceof File);
  if (!files.length) return json({ error: "Sélectionnez au moins un fichier." }, { status: 400 });
  const projectId = (await params).id;
  const documents = [];
  for (const file of files) documents.push(await importProjectDocument(user.id, projectId, file));
  return json({ documents });
});
