import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { checkJevHealth } from "@/lib/jev/service";

// Pastille d'état (chat et administration). Les détails techniques ne sont renvoyés qu'aux administrateurs.
export const GET = route(async () => {
  const user = await requireApiUser("chat:use");
  const status = await checkJevHealth();
  if (hasPermission(user.role, "diagnostics:view")) return json(status);
  return json({ state: status.state, label: status.label, latencyMs: status.latencyMs, checkedAt: status.checkedAt });
});
