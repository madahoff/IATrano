import { z } from "zod";
import { db } from "@/lib/db";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { AppError, tooManyRequests } from "@/lib/errors";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { passwordSchema } from "@/lib/users/service";
import { rateLimit } from "@/lib/rate-limit";

const schema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema });

export const POST = route(async (req) => {
  const sessionUser = await requireApiUser("profile:edit");
  const r = rateLimit(`pwd:${sessionUser.id}`, 5, 15 * 60_000);
  if (!r.ok) throw tooManyRequests(r.retryAfterSec);
  const { currentPassword, newPassword } = await parseJson(req, schema);
  const user = await db.user.findUniqueOrThrow({ where: { id: sessionUser.id } });
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AppError(403, "invalid_password", "Mot de passe actuel incorrect.");
  }
  await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
  // Révoque toutes les autres sessions ; la session courante reste active.
  await db.session.deleteMany({ where: { userId: user.id, id: { not: sessionUser.sessionId } } });
  return json({ ok: true });
});
