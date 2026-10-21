import { z } from "zod";
import { db } from "@/lib/db";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";

const schema = z.object({
  defaultModel: z.string().min(1).max(200).nullable().optional(),
  thinkingDefault: z.boolean().nullable().optional(),
  clarificationsEnabled: z.boolean().nullable().optional(),
  webSearchDefault: z.boolean().nullable().optional(),
  theme: z.enum(["SYSTEM", "LIGHT", "DARK"]).optional(),
});

export const GET = route(async () => {
  const user = await requireApiUser("profile:edit");
  const settings = await db.userSettings.findUnique({ where: { userId: user.id } });
  return json({ settings });
});

export const PATCH = route(async (req) => {
  const user = await requireApiUser("profile:edit");
  const data = await parseJson(req, schema);
  const settings = await db.userSettings.upsert({
    where: { userId: user.id },
    update: data,
    create: { userId: user.id, ...data },
  });
  return json({ settings });
});
