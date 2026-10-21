import { db } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";

export const GET = route(async (req) => {
  await requireApiUser("diagnostics:view");
  const level = new URL(req.url).searchParams.get("level");
  const logs = await db.errorLog.findMany({
    where: level === "ERROR" || level === "WARN" || level === "INFO" ? { level } : {},
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return json({ logs: logs.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })) });
});

export const DELETE = route(async () => {
  await requireApiUser("diagnostics:view");
  await db.errorLog.deleteMany({});
  return json({ ok: true });
});
