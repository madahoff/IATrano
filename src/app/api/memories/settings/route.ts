import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { updateMemorySettings } from "@/lib/memory/service";

const schema = z
  .object({ memoryEnabled: z.boolean().optional(), memoryAutoSave: z.boolean().optional() })
  .refine((d) => Object.keys(d).length > 0, "Aucune modification.");

export const PATCH = route(async (req) => {
  const user = await requireApiUser("chat:use");
  return json({ settings: await updateMemorySettings(user.id, await parseJson(req, schema)) });
});
