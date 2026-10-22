import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { createProjectMemory, listProjectMemories } from "@/lib/projects/service";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({ content: z.string().min(3).max(2000), kind: z.enum(["OBJECTIVE", "CONSTRAINT", "DECISION", "FACT", "DEFINITION", "CONCLUSION", "OTHER"]), source: z.enum(["USER", "DOCUMENT", "AI"]).optional(), sourceDocumentId: z.string().nullable().optional() });

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  return json({ memories: await listProjectMemories(user.id, (await params).id) });
});

export const POST = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  return json({ memory: await createProjectMemory(user.id, (await params).id, await parseJson(req, schema)) }, { status: 201 });
});
