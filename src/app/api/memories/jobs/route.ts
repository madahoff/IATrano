import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { errorDetails, logEvent } from "@/lib/logger";
import { memoryJobSummary, retryFailedMemoryJobs, runDueMemoryJobs } from "@/lib/memory/jobs";

// État de la file d'analyse de la mémoire du compte, et relance des analyses abandonnées.

export const GET = route(async () => {
  const user = await requireApiUser("chat:use");
  return json({ jobs: await memoryJobSummary(user.id) });
});

const schema = z.object({ action: z.literal("retry") });

export const POST = route(async (req) => {
  const user = await requireApiUser("chat:use");
  await parseJson(req, schema);
  const retried = await retryFailedMemoryJobs(user.id);
  if (retried) void runDueMemoryJobs(retried).catch((err) => logEvent("WARN", "memory:job", "Relance des analyses impossible", errorDetails(err), user.id));
  return json({ retried, jobs: await memoryJobSummary(user.id) });
});
