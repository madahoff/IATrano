import "server-only";
import { redirect, notFound as nextNotFound } from "next/navigation";
import { forbidden, unauthorized } from "@/lib/errors";
import { getCurrentUser, type SessionUser } from "./session";
import { hasPermission, type Permission } from "./permissions";

/** Pour les pages : redirige vers /login si non connecté. */
export async function requirePageUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Pour les pages : 404 si la permission manque (on ne révèle pas l'existence de l'administration). */
export async function requirePagePermission(permission: Permission): Promise<SessionUser> {
  const user = await requirePageUser();
  if (!hasPermission(user.role, permission)) nextNotFound();
  return user;
}

/** Pour les routes API : lève une AppError 401/403. */
export async function requireApiUser(permission: Permission = "chat:use"): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw unauthorized();
  if (!hasPermission(user.role, permission)) throw forbidden();
  return user;
}
