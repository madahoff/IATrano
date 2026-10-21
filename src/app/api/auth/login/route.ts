import { headers } from "next/headers";
import { z } from "zod";
import { db } from "@/lib/db";
import { clientIp, json, parseJson, route } from "@/lib/http";
import { AppError, tooManyRequests } from "@/lib/errors";
import { getDummyHash, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit";
import { ensureBootstrapped } from "@/lib/bootstrap";
import { logEvent } from "@/lib/logger";

const schema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1, "Mot de passe requis.").max(200),
});

const invalid = () => new AppError(401, "invalid_credentials", "E-mail ou mot de passe incorrect.");

export const POST = route(async (req) => {
  await ensureBootstrapped();
  const { email, password } = await parseJson(req, schema);
  const ip = clientIp(req);
  // 10 tentatives / 15 min par couple IP + e-mail, 50 par IP.
  for (const [key, limit] of [[`login:${ip}:${email}`, 10], [`login-ip:${ip}`, 50]] as const) {
    const r = rateLimit(key, limit, 15 * 60_000);
    if (!r.ok) throw tooManyRequests(r.retryAfterSec);
  }
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    await verifyPassword(password, await getDummyHash());
    throw invalid();
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    await logEvent("WARN", "auth", "Échec de connexion", { email, ip });
    throw invalid();
  }
  if (!user.isActive) throw new AppError(403, "account_disabled", "Ce compte est désactivé. Contactez un administrateur.");
  resetRateLimit(`login:${ip}:${email}`);
  await createSession(user.id, { userAgent: (await headers()).get("user-agent"), ip });
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return json({ ok: true });
});
