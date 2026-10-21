import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { getSystemStatus } from "@/lib/status";

export const GET = route(async () => {
  await requireApiUser("diagnostics:view");
  return json(await getSystemStatus());
});
