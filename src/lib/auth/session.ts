import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { generateSessionToken, hashSessionToken } from "./tokens";

export const SESSION_COOKIE = "iatrano_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  sessionId: string;
};

async function isSecureRequest(): Promise<boolean> {
  const mode = env().COOKIE_SECURE;
  if (mode === "true") return true;
  if (mode === "false") return false;
  // auto : cookie « Secure » seulement si la requête arrive en HTTPS (directement ou via le reverse proxy).
  const h = await headers();
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return proto === "https";
}

async function setSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: await isSecureRequest(),
    path: "/",
    expires: expiresAt,
  });
}

export async function createSession(userId: string, meta: { userAgent?: string | null; ip?: string | null }) {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: {
      userId,
      tokenHash: hashSessionToken(token, env().authSecret),
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip ?? null,
    },
  });
  await setSessionCookie(token, expiresAt);
}

export async function destroyCurrentSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.session.deleteMany({ where: { tokenHash: hashSessionToken(token, env().authSecret) } });
  }
  jar.delete(SESSION_COOKIE);
}

/** Utilisateur de la requête courante, ou null. Mémoïsé pour la durée de la requête. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || token.length > 200) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashSessionToken(token, env().authSecret) },
    include: { user: { select: { id: true, email: true, name: true, role: true, isActive: true } } },
  });
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now || !session.user.isActive) {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  // Session glissante : prolongée au plus une fois par jour.
  if (now - session.lastUsedAt.getTime() > SESSION_REFRESH_MS) {
    await db.session
      .update({ where: { id: session.id }, data: { lastUsedAt: new Date(now), expiresAt: new Date(now + SESSION_TTL_MS) } })
      .catch(() => {});
  }
  const { id, email, name, role } = session.user;
  return { id, email, name, role, sessionId: session.id };
});
