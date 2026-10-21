import { json, route } from "@/lib/http";
import { destroyCurrentSession } from "@/lib/auth/session";

export const POST = route(async () => {
  await destroyCurrentSession();
  return json({ ok: true });
});
