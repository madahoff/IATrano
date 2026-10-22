import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { logEvent } from "@/lib/logger";
import { routingSettingsSchema } from "@/lib/routing/config";
import { getRoutingSettings, routingConfigFrom, saveRoutingSettings } from "@/lib/routing/service";

export const GET = route(async () => {
  await requireApiUser("settings:manage");
  return json({ settings: routingConfigFrom(await getRoutingSettings()) });
});

export const PUT = route(async (req) => {
  const user = await requireApiUser("settings:manage");
  const input = await parseJson(req, routingSettingsSchema);
  const saved = await saveRoutingSettings(input, user.id);
  await logEvent("INFO", "admin:routing", "Réglages du routage modifiés", { defaultAuthMode: input.defaultAuthMode, highThreshold: input.highThreshold }, user.id);
  return json({ settings: routingConfigFrom(saved) });
});
