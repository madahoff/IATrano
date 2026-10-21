import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { listConversations } from "@/lib/chat/service";

export const GET = route(async (req) => {
  const user = await requireApiUser("chat:use");
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.slice(0, 200) ?? undefined;
  const archived = url.searchParams.get("archived") === "1";
  return json({ conversations: await listConversations(user.id, { q, archived }) });
});
