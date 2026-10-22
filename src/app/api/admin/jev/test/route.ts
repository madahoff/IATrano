import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { tooManyRequests } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { jevConnectionSchema } from "@/lib/jev/config";
import { runJevDiagnostics } from "@/lib/jev/diagnostics";
import { describeKey, getJevSettings, resolveJevKey } from "@/lib/jev/settings";
import { recordTestRun } from "@/lib/diagnostics/history";
import { getRoutingSettings, routingConfigFrom } from "@/lib/routing/service";

// Test de connexion depuis le serveur IATrano (c'est lui qui joint JEV), avec la configuration
// enregistrée ou celle du formulaire (« Tester sans enregistrer »).
const schema = z.object({
  connection: jevConnectionSchema.optional(),
  // undefined : clé enregistrée ; "" : tester sans clé ; valeur : clé saisie (non enregistrée)
  apiKey: z.string().max(500).optional(),
});

export const POST = route(async (req) => {
  const user = await requireApiUser("settings:manage");
  const r = rateLimit(`jev-test:${user.id}`, 10, 60_000);
  if (!r.ok) throw tooManyRequests(r.retryAfterSec);
  const input = await parseJson(req, schema);
  const saved = await getJevSettings();
  const c = input.connection ?? { host: saved.host, port: saved.port, protocol: saved.protocol, timeoutSec: saved.timeoutMs / 1000 };
  const savedKey = resolveJevKey(saved);
  const typed = input.apiKey?.trim();
  const apiKey = input.apiKey === undefined ? savedKey.key : typed || null;
  const keyInfo = input.apiKey === undefined ? describeKey(savedKey.source, savedKey.unreadable) : typed ? "saisie dans le formulaire, non enregistrée (masquée)" : "aucune (test sans clé)";
  const report = await runJevDiagnostics({
    host: c.host.trim().replace(/^\[|\]$/g, ""),
    port: c.port,
    protocol: c.protocol,
    apiKey,
    timeoutMs: Math.round(c.timeoutSec * 1000),
    keyInfo,
    routingModes: routingConfigFrom(await getRoutingSettings()).modes,
  });
  await recordTestRun(report, user.id);
  return json({ report });
});
