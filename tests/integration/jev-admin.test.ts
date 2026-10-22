// Routes de la page « Connexion JEV » : base réelle, sessions réelles, faux serveur JEV en HTTP.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createUser, jsonRequest, loginAs, resetDb } from "../support/fixtures";
import { startFakeJev, type FakeJev } from "../support/fake-jev";
import * as settingsRoute from "@/app/api/admin/jev/settings/route";
import * as resetRoute from "@/app/api/admin/jev/settings/reset/route";
import * as testRoute from "@/app/api/admin/jev/test/route";
import * as healthRoute from "@/app/api/jev/health/route";
import * as historyRoute from "@/app/api/admin/connection-tests/route";
import { invalidateJevSettings } from "@/lib/jev/settings";
import { resetRateLimit } from "@/lib/rate-limit";
import { safeJevDecide } from "@/lib/jev/service";

const KEY = "cle-jev-integration-5678";
let fake: FakeJev | null = null;

beforeEach(async () => {
  await resetDb();
  await db.$executeRawUnsafe('TRUNCATE "JevSettings", "ConnectionTestRun"');
  invalidateJevSettings();
});
afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function admin() {
  const u = await createUser("ADMIN");
  await loginAs(u.id);
  resetRateLimit(`jev-test:${u.id}`);
  return u;
}

const connection = (port: number) => ({ host: "127.0.0.1", port, protocol: "HTTP", timeoutSec: 2, defaultThreshold: 0.7 });

describe("Configuration JEV", () => {
  it("valeurs par défaut issues de l'environnement, puis enregistrement avec clé chiffrée jamais renvoyée", async () => {
    await admin();
    const get = await (await settingsRoute.GET(jsonRequest("GET", "/api/admin/jev/settings"), {})).json();
    expect(get.settings).toMatchObject({ host: "100.121.17.90", port: 8017, protocol: "HTTP", timeoutSec: 10, defaultThreshold: 0.5 });

    const put = await settingsRoute.PUT(jsonRequest("PUT", "/api/admin/jev/settings", { ...connection(9999), apiKey: KEY }), {});
    expect(put.status).toBe(200);
    const body = await put.text();
    expect(body).not.toContain(KEY);
    expect(JSON.parse(body).settings).toMatchObject({ port: 9999, hasStoredKey: true, keySource: "admin", defaultThreshold: 0.7 });

    const row = await db.jevSettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.apiKeyEnc).toBeTruthy();
    expect(row.apiKeyEnc).not.toContain(KEY);

    // "" supprime la clé ; l'absence du champ la conserve.
    await settingsRoute.PUT(jsonRequest("PUT", "/api/admin/jev/settings", connection(9999)), {});
    expect((await db.jevSettings.findUniqueOrThrow({ where: { id: 1 } })).apiKeyEnc).toBeTruthy();
    await settingsRoute.PUT(jsonRequest("PUT", "/api/admin/jev/settings", { ...connection(9999), apiKey: "" }), {});
    expect((await db.jevSettings.findUniqueOrThrow({ where: { id: 1 } })).apiKeyEnc).toBeNull();
  });

  it("refuse les valeurs invalides avec un message en français", async () => {
    await admin();
    for (const [bad, msg] of [
      [{ host: "http://x" }, "sans http://"],
      [{ port: 70000 }, "entre 1 et 65535"],
      [{ timeoutSec: 0 }, "supérieur à 0"],
      [{ defaultThreshold: 2 }, "entre 0 et 1"],
    ] as const) {
      const res = await settingsRoute.PUT(jsonRequest("PUT", "/api/admin/jev/settings", { ...connection(8017), ...bad }), {});
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain(msg);
    }
  });

  it("rétablit les valeurs par défaut en conservant la clé", async () => {
    await admin();
    await settingsRoute.PUT(jsonRequest("PUT", "/api/admin/jev/settings", { ...connection(9999), apiKey: KEY }), {});
    const res = await (await resetRoute.POST(jsonRequest("POST", "/api/admin/jev/settings/reset"), {})).json();
    expect(res.settings).toMatchObject({ host: "100.121.17.90", port: 8017, hasStoredKey: true });
  });

  it("réservée aux administrateurs", async () => {
    const u = await createUser("USER");
    await loginAs(u.id);
    expect((await settingsRoute.GET(jsonRequest("GET", "/api/admin/jev/settings"), {})).status).toBe(403);
    expect((await testRoute.POST(jsonRequest("POST", "/api/admin/jev/test", {}), {})).status).toBe(403);
  });
});

describe("Test de connexion", () => {
  it("teste la configuration enregistrée, applique un changement sans redémarrage et garde l'historique", async () => {
    await admin();
    fake = await startFakeJev({ apiKey: KEY });
    await settingsRoute.PUT(jsonRequest("PUT", "/api/admin/jev/settings", { ...connection(fake.port), apiKey: KEY }), {});

    const { report } = await (await testRoute.POST(jsonRequest("POST", "/api/admin/jev/test", {}), {})).json();
    expect(report.steps.find((s: { id: string }) => s.id === "auth").status).toBe("ok");
    expect(report.steps.find((s: { id: string }) => s.id === "decision").status).toBe("ok");
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(fake.requests.some((r) => r.auth === `Bearer ${KEY}`)).toBe(true);

    // Le service applicatif utilise immédiatement la nouvelle configuration.
    const d = await safeJevDecide("I was charged twice.", [{ name: "billing", instructions: "Is this a billing problem?" }]);
    expect(d).toMatchObject({ ok: true });

    const history = await (await historyRoute.GET(jsonRequest("GET", "/api/admin/connection-tests?target=JEV"), {})).json();
    expect(history.runs).toHaveLength(1);
    expect(JSON.stringify(history)).not.toContain(KEY);
  });

  it("« Tester sans enregistrer » utilise le formulaire sans modifier la configuration", async () => {
    await admin();
    fake = await startFakeJev({ apiKey: KEY });
    const res = await (await testRoute.POST(jsonRequest("POST", "/api/admin/jev/test", { connection: connection(fake.port), apiKey: "mauvaise-cle" }), {})).json();
    expect(res.report.verdict).toBe("FAILED");
    expect(res.report.steps.find((s: { id: string }) => s.id === "auth").hint).toMatch(/Clé API refusée/);
    expect(res.report.keyInfo).toMatch(/non enregistrée/);
    expect((await db.jevSettings.findUniqueOrThrow({ where: { id: 1 } })).port).toBe(8017);
  });

  it("ne conserve que les 20 derniers tests", async () => {
    const u = await admin();
    await db.connectionTestRun.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({ target: "JEV" as const, verdict: "OK" as const, latencyMs: i, report: {}, userId: u.id, createdAt: new Date(Date.now() - (i + 1) * 60_000) })),
    });
    fake = await startFakeJev();
    await testRoute.POST(jsonRequest("POST", "/api/admin/jev/test", { connection: connection(fake.port), apiKey: "" }), {});
    expect(await db.connectionTestRun.count({ where: { target: "JEV" } })).toBe(20);
    expect(await db.connectionTestRun.count({ where: { latencyMs: 19 } })).toBe(0);
  });
});

describe("Pastille d'état", () => {
  it("vert quand JEV est prêt, orange en chargement, rouge injoignable ; détails réservés aux administrateurs", async () => {
    await admin();
    fake = await startFakeJev({ apiKey: KEY });
    await settingsRoute.PUT(jsonRequest("PUT", "/api/admin/jev/settings", connection(fake.port)), {});
    expect((await (await healthRoute.GET(jsonRequest("GET", "/api/jev/health"), {})).json()).state).toBe("green");

    fake.options.healthStatus = "loading";
    expect(await (await healthRoute.GET(jsonRequest("GET", "/api/jev/health"), {})).json()).toMatchObject({ state: "orange", detail: "Statut : loading" });

    await fake.close();
    invalidateJevSettings();
    const red = await (await healthRoute.GET(jsonRequest("GET", "/api/jev/health"), {})).json();
    expect(red.state).toBe("red");
    expect(red.endpoint).toContain("127.0.0.1");

    const user = await createUser("USER");
    await loginAs(user.id);
    const forUser = await (await healthRoute.GET(jsonRequest("GET", "/api/jev/health"), {})).json();
    expect(forUser.state).toBe("red");
    expect(forUser.endpoint).toBeUndefined();
    expect(forUser.detail).toBeUndefined();
  });

  it("une panne de JEV ne lève jamais d'exception côté service", async () => {
    await admin();
    await settingsRoute.PUT(jsonRequest("PUT", "/api/admin/jev/settings", { ...connection(1), timeoutSec: 0.5 }), {});
    const d = await safeJevDecide("x", [{ name: "q", instructions: "Q?" }]);
    expect(d).toMatchObject({ ok: false, code: "unreachable" });
  });
});
