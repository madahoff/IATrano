import { db } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { logEvent } from "@/lib/logger";
import { getJevSettings, invalidateJevSettings, jevDefaults, publicJevSettings } from "@/lib/jev/settings";

// Rétablit les valeurs par défaut (JEV_* du .env, sinon valeurs d'usine). La clé enregistrée est conservée :
// elle se supprime explicitement depuis le formulaire.
export const POST = route(async () => {
  const user = await requireApiUser("settings:manage");
  await getJevSettings();
  const d = jevDefaults();
  const updated = await db.jevSettings.update({
    where: { id: 1 },
    data: { host: d.host, port: d.port, protocol: d.protocol, timeoutMs: Math.round(d.timeoutSec * 1000), defaultThreshold: d.defaultThreshold, updatedById: user.id },
  });
  invalidateJevSettings();
  await logEvent("INFO", "admin:jev", "Configuration JEV réinitialisée", undefined, user.id);
  return json({ settings: publicJevSettings(updated) });
});
