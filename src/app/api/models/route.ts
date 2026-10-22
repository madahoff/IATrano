import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { getModels } from "@/lib/llm/discovery";
import { getEffectivePreferences } from "@/lib/settings/service";
import { isSearchConfigured, searchConfigFrom } from "@/lib/search/providers";
import { rateLimit } from "@/lib/rate-limit";
import { effectiveAuthMode, getRoutingSettings, routingConfigFrom } from "@/lib/routing/service";
import { ROUTING_MODES } from "@/lib/routing/config";

export const GET = route(async (req) => {
  const user = await requireApiUser("chat:use");
  const wantsRefresh = new URL(req.url).searchParams.get("refresh") === "1";
  const refresh = wantsRefresh && rateLimit(`models-refresh:${user.id}`, 10, 60_000).ok;
  const [snapshot, prefs, routingSettings] = await Promise.all([getModels({ refresh }), getEffectivePreferences(user.id), getRoutingSettings()]);
  const routing = routingConfigFrom(routingSettings);
  return json({
    ...snapshot,
    defaultModel: prefs.defaultModel,
    appDefaultModel: prefs.app.defaultModel,
    thinkingDefault: prefs.thinkingDefault,
    webSearch: {
      // Fonctionnalité activée par l'administration ET moteur configuré.
      available: prefs.app.webSearchEnabled && isSearchConfigured(searchConfigFrom(prefs.app)),
      enabled: prefs.app.webSearchEnabled,
      default: prefs.webSearchDefault,
    },
    // Routage JEV : mode d'autorisation effectif et règles d'administration (boutons interdits grisés).
    routing: {
      authMode: await effectiveAuthMode(user.id, routingSettings),
      defaultAuthMode: routing.defaultAuthMode,
      rules: Object.fromEntries(ROUTING_MODES.map((m) => [m, routing.modes[m].rule])),
      interactiveAvailable: true,
    },
  });
});
