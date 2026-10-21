import "server-only";
import type { Role } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { AppError, badRequest, forbidden, notFound } from "@/lib/errors";
import { hashPassword, PASSWORD_MIN_LENGTH } from "@/lib/auth/password";
import { canAssignRole, canManageUser } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";

export const emailSchema = z.string().trim().toLowerCase().email("Adresse e-mail invalide.").max(254);
export const nameSchema = z.string().trim().min(1, "Le nom est requis.").max(80);
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères.`)
  .max(200);
export const roleSchema = z.enum(["SUPERADMIN", "ADMIN", "USER"]);

export const createUserSchema = z.object({
  email: emailSchema,
  name: nameSchema,
  password: passwordSchema,
  role: roleSchema.default("USER"),
});

export const updateUserSchema = z.object({
  name: nameSchema.optional(),
  email: emailSchema.optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
  password: passwordSchema.optional(),
});

const publicSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  _count: { select: { conversations: true, sessions: true } },
} as const;

export async function listUsers() {
  const users = await db.user.findMany({ orderBy: { createdAt: "asc" }, select: publicSelect });
  return users.map((u) => ({
    ...u,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  }));
}

async function assertEmailFree(email: string, exceptId?: string) {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing && existing.id !== exceptId) throw new AppError(409, "email_taken", "Cette adresse e-mail est déjà utilisée.");
}

export async function createUser(actor: SessionUser, input: z.infer<typeof createUserSchema>) {
  if (!canAssignRole(actor.role, input.role)) throw forbidden("Vous ne pouvez pas attribuer ce rôle.");
  await assertEmailFree(input.email);
  const user = await db.user.create({
    data: { email: input.email, name: input.name, role: input.role, passwordHash: await hashPassword(input.password) },
    select: { id: true },
  });
  return user.id;
}

async function countActiveSuperadmins(exceptId?: string) {
  return db.user.count({ where: { role: "SUPERADMIN", isActive: true, ...(exceptId ? { id: { not: exceptId } } : {}) } });
}

export async function updateUser(actor: SessionUser, id: string, input: z.infer<typeof updateUserSchema>) {
  const target = await db.user.findUnique({ where: { id } });
  if (!target) throw notFound("Utilisateur introuvable.");
  const self = target.id === actor.id;
  if (!self && !canManageUser(actor.role, target.role)) throw forbidden("Vous ne pouvez pas modifier ce compte.");
  if (input.role && input.role !== target.role) {
    if (self) throw badRequest("Vous ne pouvez pas modifier votre propre rôle.");
    if (!canAssignRole(actor.role, input.role)) throw forbidden("Vous ne pouvez pas attribuer ce rôle.");
  }
  if (input.isActive === false && self) throw badRequest("Vous ne pouvez pas désactiver votre propre compte.");
  const losesSuperadmin =
    target.role === "SUPERADMIN" && ((input.role && input.role !== "SUPERADMIN") || input.isActive === false);
  if (losesSuperadmin && (await countActiveSuperadmins(target.id)) === 0) {
    throw badRequest("Impossible : il doit rester au moins un super-administrateur actif.");
  }
  if (input.email) await assertEmailFree(input.email, target.id);
  await db.user.update({
    where: { id },
    data: {
      name: input.name,
      email: input.email,
      role: input.role as Role | undefined,
      isActive: input.isActive,
      ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
    },
  });
  // Désactivation, changement de rôle ou de mot de passe : les sessions existantes sont révoquées.
  if (input.isActive === false || input.password || (input.role && input.role !== target.role)) {
    await db.session.deleteMany({ where: { userId: id } });
  }
}

export async function deleteUser(actor: SessionUser, id: string) {
  const target = await db.user.findUnique({ where: { id } });
  if (!target) throw notFound("Utilisateur introuvable.");
  if (target.id === actor.id) throw badRequest("Vous ne pouvez pas supprimer votre propre compte.");
  if (!canManageUser(actor.role, target.role)) throw forbidden("Vous ne pouvez pas supprimer ce compte.");
  if (target.role === "SUPERADMIN" && (await countActiveSuperadmins(target.id)) === 0) {
    throw badRequest("Impossible : il doit rester au moins un super-administrateur actif.");
  }
  await db.user.delete({ where: { id } });
}
