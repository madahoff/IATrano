import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { requestContext } from "./request-context";

let seq = 0;

export async function resetDb() {
  await db.$executeRawUnsafe('TRUNCATE "Message", "Conversation", "Session", "UserSettings", "User", "ErrorLog", "AppSettings" CASCADE');
}

export async function createUser(role: Role = "USER", overrides: { email?: string; password?: string; isActive?: boolean } = {}) {
  seq++;
  return db.user.create({
    data: {
      email: overrides.email ?? `user${seq}-${Date.now()}@test.local`,
      name: `Utilisateur ${seq}`,
      role,
      isActive: overrides.isActive ?? true,
      passwordHash: await hashPassword(overrides.password ?? "motdepasse-de-test", { N: 1024 }),
    },
  });
}

/** Connecte l'utilisateur dans le contexte de requête simulé (vrai createSession, vrai cookie). */
export async function loginAs(userId: string | null) {
  requestContext.reset();
  if (userId) {
    await createSession(userId, { userAgent: "vitest" });
    if (!requestContext.getCookie(SESSION_COOKIE)) throw new Error("cookie de session non posé");
  }
}

export function jsonRequest(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { host: "localhost:3000", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

export async function createConversation(userId: string, title = "Conversation secrète") {
  return db.conversation.create({
    data: {
      userId,
      title,
      model: "fake:1b",
      messages: {
        create: [
          { role: "USER", content: "Mon code d'accès est 4242", createdAt: new Date(Date.now() - 2000) },
          { role: "ASSISTANT", content: "Noté.", createdAt: new Date(Date.now() - 1000) },
        ],
      },
    },
  });
}
