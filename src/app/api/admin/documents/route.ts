import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { logEvent } from "@/lib/logger";
import { getDocumentAdminView } from "@/lib/documents/admin";
import { documentSettingsSchema, updateDocumentSettings } from "@/lib/documents/settings";

export const GET = route(async () => {
  await requireApiUser("settings:manage");
  return json(await getDocumentAdminView());
});

export const PATCH = route(async (req) => {
  const user = await requireApiUser("settings:manage");
  const data = await parseJson(req, documentSettingsSchema);
  await updateDocumentSettings(data, user.id);
  await logEvent("INFO", "admin:documents", "Réglages documentaires modifiés", data, user.id);
  return json(await getDocumentAdminView());
});
