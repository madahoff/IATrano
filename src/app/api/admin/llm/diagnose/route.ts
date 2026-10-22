import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { tooManyRequests } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { buildProvider } from "@/lib/llm/registry";
import { runLlmDiagnostics } from "@/lib/llm/diagnostics";
import { getAppSettings, providerConfigFrom } from "@/lib/settings/service";
import { recordTestRun } from "@/lib/diagnostics/history";

// Diagnostic du serveur LLM enregistré (Administration → Serveur IA).
export const POST = route(async () => {
  const user = await requireApiUser("settings:manage");
  const r = rateLimit(`llm-diagnose:${user.id}`, 5, 60_000);
  if (!r.ok) throw tooManyRequests(r.retryAfterSec);
  const settings = await getAppSettings();
  const config = providerConfigFrom(settings);
  const report = await runLlmDiagnostics({ config, preferredModel: settings.defaultModel }, { provider: buildProvider(config) });
  await recordTestRun(report, user.id);
  return json({ report });
});
