import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { logEvent } from "@/lib/logger";
import { ROUTING_FACTORY_DEFAULTS } from "@/lib/routing/config";
import { routingConfigFrom, saveRoutingSettings } from "@/lib/routing/service";

export const POST = route(async () => {
  const user = await requireApiUser("settings:manage");
  const saved = await saveRoutingSettings(ROUTING_FACTORY_DEFAULTS, user.id);
  await logEvent("INFO", "admin:routing", "Réglages du routage réinitialisés", undefined, user.id);
  return json({ settings: routingConfigFrom(saved) });
});
