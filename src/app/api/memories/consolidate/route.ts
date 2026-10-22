import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { consolidateMemories } from "@/lib/memory/consolidate";

/** Fusionne les doublons et ne garde qu'un souvenir actif par sujet exclusif (sans appel au modèle). */
export const POST = route(async () => {
  const user = await requireApiUser("chat:use");
  return json({ result: await consolidateMemories(user.id) });
});
