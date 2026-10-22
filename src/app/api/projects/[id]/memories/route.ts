import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { getOwnedProject } from "@/lib/projects/service";
import { createMemory, listMemories, PROJECT_MEMORY_MAX_CHARS, toMemoryDTO } from "@/lib/memory/service";
import { MEMORY_KINDS } from "@/lib/memory/types";

// Mémoire propre au projet : table Memory avec projectId (voir src/lib/memory). Jamais injectée hors du projet.

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({
  content: z.string().min(3).max(PROJECT_MEMORY_MAX_CHARS),
  kind: z.enum(MEMORY_KINDS),
  importance: z.number().int().min(1).max(5).optional(),
  sourceDocumentId: z.string().nullable().optional(),
});

export const GET = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const project = await getOwnedProject(user.id, (await params).id);
  const history = new URL(req.url).searchParams.get("history") === "1";
  return json({ memories: (await listMemories(user.id, { projectId: project.id, history })).map(toMemoryDTO) });
});

export const POST = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const project = await getOwnedProject(user.id, (await params).id);
  const data = await parseJson(req, schema);
  const { memory, duplicateOf } = await createMemory(user.id, { ...data, projectId: project.id, source: data.sourceDocumentId ? "DOCUMENT" : "MANUAL" });
  return json({ memory: toMemoryDTO(memory), duplicateOf }, { status: duplicateOf ? 200 : 201 });
});
