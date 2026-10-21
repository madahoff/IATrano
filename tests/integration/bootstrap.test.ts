import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { bootstrap } from "@/lib/bootstrap";
import { resetDb } from "../support/fixtures";

const ENV_KEYS = ["SUPERADMIN_EMAIL", "SUPERADMIN_PASSWORD", "SUPERADMIN_NAME"] as const;

beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("Initialisation du super-administrateur", () => {
  it("crée le compte une seule fois et ne réinitialise jamais son mot de passe", async () => {
    process.env.SUPERADMIN_EMAIL = "Root@Test.local";
    process.env.SUPERADMIN_PASSWORD = "mot-de-passe-initial";
    await bootstrap();
    await bootstrap();
    const admins = await db.user.findMany({ where: { role: "SUPERADMIN" } });
    expect(admins).toHaveLength(1);
    expect(admins[0].email).toBe("root@test.local");
    expect(admins[0].passwordHash).not.toContain("mot-de-passe-initial");

    process.env.SUPERADMIN_PASSWORD = "un-autre-mot-de-passe";
    await bootstrap();
    const after = await db.user.findUniqueOrThrow({ where: { email: "root@test.local" } });
    expect(await verifyPassword("mot-de-passe-initial", after.passwordHash)).toBe(true);
    expect(await db.appSettings.count()).toBe(1);
  });

  it("refuse un mot de passe trop court et n'élève pas un compte existant", async () => {
    process.env.SUPERADMIN_EMAIL = "root@test.local";
    process.env.SUPERADMIN_PASSWORD = "court";
    await bootstrap();
    expect(await db.user.count()).toBe(0);
    expect(await db.errorLog.count({ where: { source: "bootstrap", level: "WARN" } })).toBe(1);

    await db.user.create({ data: { email: "root@test.local", name: "x", passwordHash: "scrypt$1$1$1$AA$AA" } });
    process.env.SUPERADMIN_PASSWORD = "mot-de-passe-assez-long";
    await bootstrap();
    expect(await db.user.count({ where: { role: "SUPERADMIN" } })).toBe(0);
  });
});

describe("Migrations", () => {
  it("le schéma Prisma correspond exactement aux migrations appliquées", () => {
    const out = execSync(`npx prisma migrate diff --from-url "${process.env.TEST_DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --exit-code`, {
      encoding: "utf8",
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    });
    expect(out).toMatch(/No difference detected|empty migration/i);
  });
});
