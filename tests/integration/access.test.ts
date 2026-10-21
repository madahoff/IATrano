import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { requestContext } from "../support/request-context";
import { createConversation, createUser, jsonRequest, loginAs, params, resetDb } from "../support/fixtures";
import * as conversationRoute from "@/app/api/conversations/[id]/route";
import * as conversationsRoute from "@/app/api/conversations/route";
import * as chatRoute from "@/app/api/chat/route";
import * as adminUsersRoute from "@/app/api/admin/users/route";
import * as adminUserRoute from "@/app/api/admin/users/[id]/route";
import * as adminSettingsRoute from "@/app/api/admin/settings/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as meRoute from "@/app/api/me/route";
import { SESSION_COOKIE } from "@/lib/auth/session";

vi.mock("@/lib/llm/discovery", () => ({
  getModels: async () => ({
    provider: { kind: "OLLAMA", reachable: true },
    models: [{ id: "fake:1b", name: "fake:1b", provider: "OLLAMA", capabilities: { thinking: "no", tools: "no", vision: "no" } }],
    fetchedAt: new Date().toISOString(),
  }),
  invalidateModelCache: () => {},
}));

beforeEach(async () => {
  await resetDb();
});

describe("Isolation des conversations entre utilisateurs", () => {
  it("un utilisateur ne peut ni lire, ni modifier, ni supprimer la conversation d'un autre", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const conv = await createConversation(alice.id);

    await loginAs(alice.id);
    expect((await conversationRoute.GET(jsonRequest("GET", `/api/conversations/${conv.id}`), params({ id: conv.id }))).status).toBe(200);

    await loginAs(bob.id);
    const get = await conversationRoute.GET(jsonRequest("GET", `/api/conversations/${conv.id}`), params({ id: conv.id }));
    expect(get.status).toBe(404);
    expect(JSON.stringify(await get.json())).not.toContain("4242");

    const patch = await conversationRoute.PATCH(jsonRequest("PATCH", `/api/conversations/${conv.id}`, { title: "piraté" }), params({ id: conv.id }));
    expect(patch.status).toBe(404);
    const del = await conversationRoute.DELETE(jsonRequest("DELETE", `/api/conversations/${conv.id}`), params({ id: conv.id }));
    expect(del.status).toBe(404);

    const regen = await chatRoute.POST(jsonRequest("POST", "/api/chat", { action: "regenerate", conversationId: conv.id, model: "fake:1b" }), {});
    expect(regen.status).toBe(404);
    const send = await chatRoute.POST(jsonRequest("POST", "/api/chat", { action: "send", conversationId: conv.id, content: "salut", model: "fake:1b" }), {});
    expect(send.status).toBe(404);

    const after = await db.conversation.findUniqueOrThrow({ where: { id: conv.id }, include: { messages: true } });
    expect(after.title).toBe("Conversation secrète");
    expect(after.messages).toHaveLength(2);
  });

  it("la recherche ne renvoie que les conversations de l'utilisateur connecté", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await createConversation(alice.id, "Projet Alice");
    await createConversation(bob.id, "Projet Bob");

    await loginAs(bob.id);
    const res = await conversationsRoute.GET(jsonRequest("GET", "/api/conversations?q=4242"), {});
    const data = (await res.json()) as { conversations: Array<{ title: string; snippet?: string }> };
    expect(data.conversations.map((c) => c.title)).toEqual(["Projet Bob"]);
    expect(data.conversations[0].snippet).toContain("4242");

    const byTitle = await conversationsRoute.GET(jsonRequest("GET", "/api/conversations?q=alice"), {});
    expect(((await byTitle.json()) as { conversations: unknown[] }).conversations).toHaveLength(0);
  });

  it("supprimer une conversation supprime ses messages", async () => {
    const alice = await createUser();
    const conv = await createConversation(alice.id);
    await loginAs(alice.id);
    expect((await conversationRoute.DELETE(jsonRequest("DELETE", `/api/conversations/${conv.id}`), params({ id: conv.id }))).status).toBe(200);
    expect(await db.message.count({ where: { conversationId: conv.id } })).toBe(0);
  });
});

describe("Authentification et sessions", () => {
  it("refuse les requêtes sans session valide", async () => {
    await loginAs(null);
    expect((await conversationsRoute.GET(jsonRequest("GET", "/api/conversations"), {})).status).toBe(401);
    requestContext.setCookie(SESSION_COOKIE, "jeton-inventé");
    expect((await conversationsRoute.GET(jsonRequest("GET", "/api/conversations"), {})).status).toBe(401);
  });

  it("connexion : mauvais mot de passe refusé, compte désactivé refusé, session créée sinon", async () => {
    const u = await createUser("USER", { email: "login@test.local", password: "bon-mot-de-passe" });
    await loginAs(null);
    const bad = await loginRoute.POST(jsonRequest("POST", "/api/auth/login", { email: "login@test.local", password: "faux" }), {});
    const unknown = await loginRoute.POST(jsonRequest("POST", "/api/auth/login", { email: "inconnu@test.local", password: "faux" }), {});
    expect([bad.status, unknown.status]).toEqual([401, 401]);
    // même message : on ne révèle pas si l'e-mail existe
    expect((await unknown.json()).error.message).toBe((await bad.json()).error.message);

    const ok = await loginRoute.POST(jsonRequest("POST", "/api/auth/login", { email: "LOGIN@test.local", password: "bon-mot-de-passe" }), {});
    expect(ok.status).toBe(200);
    expect(requestContext.getCookie(SESSION_COOKIE)).toBeTruthy();
    expect(await db.session.count({ where: { userId: u.id } })).toBe(1);

    await db.user.update({ where: { id: u.id }, data: { isActive: false } });
    // la session existante n'est plus acceptée
    expect((await meRoute.GET(jsonRequest("GET", "/api/me"), {})).status).toBe(401);
    await loginAs(null);
    const disabled = await loginRoute.POST(jsonRequest("POST", "/api/auth/login", { email: "login@test.local", password: "bon-mot-de-passe" }), {});
    expect(disabled.status).toBe(403);
  });

  it("limite les tentatives de connexion", async () => {
    await createUser("USER", { email: "brute@test.local" });
    await loginAs(null);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await loginRoute.POST(jsonRequest("POST", "/api/auth/login", { email: "brute@test.local", password: `x${i}` }), {})).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("rejette les mutations d'origine croisée", async () => {
    const alice = await createUser();
    const conv = await createConversation(alice.id);
    await loginAs(alice.id);
    const res = await conversationRoute.DELETE(jsonRequest("DELETE", `/api/conversations/${conv.id}`, undefined, { origin: "http://evil.example" }), params({ id: conv.id }));
    expect(res.status).toBe(403);
    expect(await db.conversation.count({ where: { id: conv.id } })).toBe(1);
  });
});

describe("Contrôles d'autorisation de l'administration", () => {
  it("un utilisateur standard n'accède à aucune route d'administration", async () => {
    const u = await createUser("USER");
    await loginAs(u.id);
    expect((await adminUsersRoute.GET(jsonRequest("GET", "/api/admin/users"), {})).status).toBe(403);
    expect((await adminSettingsRoute.GET(jsonRequest("GET", "/api/admin/settings"), {})).status).toBe(403);
    expect((await adminSettingsRoute.PATCH(jsonRequest("PATCH", "/api/admin/settings", { baseUrl: "http://evil:1" }), {})).status).toBe(403);
  });

  it("un administrateur gère les utilisateurs mais ne peut pas créer d'admin ni toucher au super-admin", async () => {
    const admin = await createUser("ADMIN");
    const superadmin = await createUser("SUPERADMIN");
    await loginAs(admin.id);
    expect((await adminUsersRoute.GET(jsonRequest("GET", "/api/admin/users"), {})).status).toBe(200);
    const created = await adminUsersRoute.POST(jsonRequest("POST", "/api/admin/users", { email: "nouveau@test.local", name: "Nouveau", password: "motdepasse-long", role: "USER" }), {});
    expect(created.status).toBe(201);
    const escalate = await adminUsersRoute.POST(jsonRequest("POST", "/api/admin/users", { email: "admin2@test.local", name: "A2", password: "motdepasse-long", role: "ADMIN" }), {});
    expect(escalate.status).toBe(403);
    const touchSuper = await adminUserRoute.PATCH(jsonRequest("PATCH", `/api/admin/users/${superadmin.id}`, { isActive: false }), params({ id: superadmin.id }));
    expect(touchSuper.status).toBe(403);
    const selfPromote = await adminUserRoute.PATCH(jsonRequest("PATCH", `/api/admin/users/${admin.id}`, { role: "SUPERADMIN" }), params({ id: admin.id }));
    expect(selfPromote.status).toBe(400);
  });

  it("protège le dernier super-administrateur et révoque les sessions d'un compte désactivé", async () => {
    const sa = await createUser("SUPERADMIN");
    const victim = await createUser("USER");
    await loginAs(victim.id);
    await loginAs(sa.id);
    expect((await adminUserRoute.PATCH(jsonRequest("PATCH", `/api/admin/users/${sa.id}`, { isActive: false }), params({ id: sa.id }))).status).toBe(400);
    expect((await adminUserRoute.DELETE(jsonRequest("DELETE", `/api/admin/users/${sa.id}`), params({ id: sa.id }))).status).toBe(400);

    expect(await db.session.count({ where: { userId: victim.id } })).toBe(1);
    expect((await adminUserRoute.PATCH(jsonRequest("PATCH", `/api/admin/users/${victim.id}`, { isActive: false }), params({ id: victim.id }))).status).toBe(200);
    expect(await db.session.count({ where: { userId: victim.id } })).toBe(0);
  });

  it("valide l'URL du serveur IA et ne renvoie jamais la clé d'API", async () => {
    const sa = await createUser("SUPERADMIN");
    await loginAs(sa.id);
    const bad = await adminSettingsRoute.PATCH(jsonRequest("PATCH", "/api/admin/settings", { baseUrl: "file:///etc/passwd" }), {});
    expect(bad.status).toBe(400);
    const ok = await adminSettingsRoute.PATCH(jsonRequest("PATCH", "/api/admin/settings", { baseUrl: "192.168.1.20:11434", apiKey: "sk-secret" }), {});
    const body = await ok.json();
    expect(body.settings.baseUrl).toBe("http://192.168.1.20:11434");
    expect(body.settings.hasApiKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-secret");
  });
});
