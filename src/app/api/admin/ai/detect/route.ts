import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { tooManyRequests } from "@/lib/errors";
import { detectProviders } from "@/lib/llm/discovery";
import { inDocker } from "@/lib/llm/url";
import { getAppSettings } from "@/lib/settings/service";
import { rateLimit } from "@/lib/rate-limit";

export const POST = route(async () => {
  const user = await requireApiUser("settings:manage");
  const r = rateLimit(`ai-detect:${user.id}`, 6, 60_000);
  if (!r.ok) throw tooManyRequests(r.retryAfterSec);
  const settings = await getAppSettings();
  const results = await detectProviders([settings.baseUrl]);
  return json({ inDocker: inDocker(), results });
});
