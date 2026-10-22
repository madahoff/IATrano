import { z } from "zod";
import { db } from "@/lib/db";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { logEvent } from "@/lib/logger";
import { jevConnectionSchema } from "@/lib/jev/config";
import { getJevSettings, invalidateJevSettings, publicJevSettings, sealJevKey } from "@/lib/jev/settings";

export const GET = route(async () => {
  await requireApiUser("settings:manage");
  return json({ settings: publicJevSettings(await getJevSettings()) });
});

const schema = jevConnectionSchema.extend({
  // undefined : inchangée ; "" : supprimer ; valeur : remplacer (chiffrée avant stockage)
  apiKey: z.string().max(500).optional(),
});

export const PUT = route(async (req) => {
  const user = await requireApiUser("settings:manage");
  const input = await parseJson(req, schema);
  await getJevSettings();
  const key = input.apiKey?.trim();
  const updated = await db.jevSettings.update({
    where: { id: 1 },
    data: {
      host: input.host.trim().replace(/^\[|\]$/g, ""),
      port: input.port,
      protocol: input.protocol,
      timeoutMs: Math.round(input.timeoutSec * 1000),
      defaultThreshold: input.defaultThreshold,
      apiKeyEnc: input.apiKey === undefined ? undefined : key ? sealJevKey(key) : null,
      updatedById: user.id,
    },
  });
  invalidateJevSettings();
  await logEvent("INFO", "admin:jev", "Configuration JEV modifiée", { host: updated.host, port: updated.port, protocol: updated.protocol, keyChanged: input.apiKey !== undefined }, user.id);
  return json({ settings: publicJevSettings(updated) });
});
