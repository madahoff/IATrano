import { z } from "zod";
import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { badRequest } from "@/lib/errors";
import { listTestRuns } from "@/lib/diagnostics/history";

const target = z.enum(["JEV", "LLM", "SEARCH"]);

export const GET = route(async (req) => {
  await requireApiUser("diagnostics:view");
  const parsed = target.safeParse(new URL(req.url).searchParams.get("target"));
  if (!parsed.success) throw badRequest("Paramètre target attendu : JEV, LLM ou SEARCH.");
  return json({ runs: await listTestRuns(parsed.data) });
});
