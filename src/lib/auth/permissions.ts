import type { Role } from "@prisma/client";

export const PERMISSIONS = [
  "chat:use",
  "profile:edit",
  "admin:access",
  "users:manage",
  "roles:manage",
  "settings:manage",
  "diagnostics:view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  USER: ["chat:use", "profile:edit"],
  ADMIN: ["chat:use", "profile:edit", "admin:access", "users:manage", "settings:manage", "diagnostics:view"],
  SUPERADMIN: PERMISSIONS,
};

export const ROLE_LABELS: Record<Role, string> = {
  SUPERADMIN: "Super-administrateur",
  ADMIN: "Administrateur",
  USER: "Utilisateur",
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

const RANK: Record<Role, number> = { USER: 0, ADMIN: 1, SUPERADMIN: 2 };

/**
 * Un acteur peut gérer un compte cible s'il a `users:manage` et que la cible a un rang strictement
 * inférieur (un ADMIN gère les USER), sauf le super-administrateur qui gère tout le monde.
 */
export function canManageUser(actor: Role, target: Role): boolean {
  if (!hasPermission(actor, "users:manage")) return false;
  if (actor === "SUPERADMIN") return true;
  return RANK[target] < RANK[actor];
}

/** Attribuer un rôle : seuls les détenteurs de `roles:manage` peuvent créer des administrateurs. */
export function canAssignRole(actor: Role, role: Role): boolean {
  if (!hasPermission(actor, "users:manage")) return false;
  if (role === "USER") return true;
  return hasPermission(actor, "roles:manage");
}
