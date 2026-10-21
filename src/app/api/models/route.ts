import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { getModels } from "@/lib/llm/discovery";
import { getEffectivePreferences } from "@/lib/settings/service";
import { rateLimit } from "@/lib/rate-limit";

export const GET = route(async (req) => {
  const user = await requireApiUser("chat:use");
  const wantsRefresh = new URL(req.url).searchParams.get("refresh") === "1";
  const refresh = wantsRefresh && rateLimit(`models-refresh:${user.id}`, 10, 60_000).ok;
  const [snapshot, prefs] = await Promise.all([getModels({ refresh }), getEffectivePreferences(user.id)]);
  return json({
    ...snapshot,
    defaultModel: prefs.defaultModel,
    appDefaultModel: prefs.app.defaultModel,
    thinkingDefault: prefs.thinkingDefault,
  });
});
