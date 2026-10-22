import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { reprocessDocument } from "@/lib/documents/service";
import { STAGES } from "@/lib/documents/pipeline";

type Ctx = { params: Promise<{ id: string; documentId: string }> };

const schema = z.object({ from: z.enum(STAGES).default("EXTRACT") });

export const POST = route<Ctx>(async (req, { params }) => {
  const user = await requireApiUser("chat:use");
  const p = await params;
  const body = await parseJson(req, schema);
  const job = await reprocessDocument(user.id, p.id, p.documentId, body.from);
  return json({ job: { id: job.id, status: job.status } });
});
