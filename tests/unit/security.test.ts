import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { canAssignRole, canManageUser, hasPermission } from "@/lib/auth/permissions";
import { generateSessionToken, hashSessionToken } from "@/lib/auth/tokens";
import { rateLimit } from "@/lib/rate-limit";

describe("Mots de passe (scrypt)", () => {
  it("hache avec un sel aléatoire et vérifie", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("mauvais mot de passe", a)).toBe(false);
  });
  it("rejette un hash mal formé sans lever d'exception", async () => {
    expect(await verifyPassword("x", "plaintext")).toBe(false);
    expect(await verifyPassword("x", "scrypt$abc$8$1$AA$AA")).toBe(false);
  });
});

describe("Jetons de session", () => {
  it("sont aléatoires et seul leur HMAC est stocké", () => {
    const t = generateSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionToken()).not.toBe(t);
    expect(hashSessionToken(t, "s1")).not.toBe(hashSessionToken(t, "s2"));
    expect(hashSessionToken(t, "s1")).toHaveLength(64);
  });
});

describe("Rôles et permissions", () => {
  it("attribue les permissions par rôle", () => {
    expect(hasPermission("USER", "chat:use")).toBe(true);
    expect(hasPermission("USER", "admin:access")).toBe(false);
    expect(hasPermission("ADMIN", "settings:manage")).toBe(true);
    expect(hasPermission("ADMIN", "roles:manage")).toBe(false);
    expect(hasPermission("SUPERADMIN", "roles:manage")).toBe(true);
  });
  it("un administrateur ne gère que les utilisateurs de rang inférieur", () => {
    expect(canManageUser("ADMIN", "USER")).toBe(true);
    expect(canManageUser("ADMIN", "ADMIN")).toBe(false);
    expect(canManageUser("ADMIN", "SUPERADMIN")).toBe(false);
    expect(canManageUser("SUPERADMIN", "SUPERADMIN")).toBe(true);
    expect(canManageUser("USER", "USER")).toBe(false);
  });
  it("seul le super-administrateur crée des administrateurs", () => {
    expect(canAssignRole("ADMIN", "USER")).toBe(true);
    expect(canAssignRole("ADMIN", "ADMIN")).toBe(false);
    expect(canAssignRole("SUPERADMIN", "ADMIN")).toBe(true);
    expect(canAssignRole("USER", "USER")).toBe(false);
  });
});

describe("Limitation de débit", () => {
  it("bloque au-delà du quota puis libère après la fenêtre", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, 1000, now + i).ok).toBe(true);
    const blocked = rateLimit("k", 3, 1000, now + 10);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(rateLimit("k", 3, 1000, now + 1500).ok).toBe(true);
    expect(rateLimit("autre", 3, 1000, now).ok).toBe(true);
  });
});
