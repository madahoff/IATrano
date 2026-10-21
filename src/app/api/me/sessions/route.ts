import { z } from "zod";
import { db } from "@/lib/db";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";

export const GET = route(async () => {
  const user = await requireApiUser("profile:edit");
  const sessions = await db.session.findMany({
    where: { userId: user.id, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true },
  });
  return json({ sessions: sessions.map((s) => ({ ...s, current: s.id === user.sessionId })) });
});

const schema = z.object({ sessionId: z.string().optional(), others: z.boolean().optional() });

export const DELETE = route(async (req) => {
  const user = await requireApiUser("profile:edit");
  const { sessionId, others } = await parseJson(req, schema);
  if (others) await db.session.deleteMany({ where: { userId: user.id, id: { not: user.sessionId } } });
  else if (sessionId) await db.session.deleteMany({ where: { userId: user.id, id: sessionId } });
  return json({ ok: true });
});
