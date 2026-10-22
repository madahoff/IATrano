// Déplacement d'une conversation vers/hors d'un projet (glisser-déposer de la barre latérale) et filtre par projet.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createConversation, createUser, jsonRequest, loginAs, params, resetDb } from "../support/fixtures";
import * as conversationRoute from "@/app/api/conversations/[id]/route";
import * as conversationsRoute from "@/app/api/conversations/route";

let alice = "";
let bob = "";
beforeEach(async () => {
  await resetDb();
  alice = (await createUser()).id;
  bob = (await createUser()).id;
});

const patch = (id: string, body: unknown) => conversationRoute.PATCH(jsonRequest("PATCH", `/api/conversations/${id}`, body), params({ id }));

describe("Rattachement d'une conversation à un projet", () => {
  it("rattache puis retire une conversation de son propre projet", async () => {
    const project = await db.project.create({ data: { userId: alice, name: "Trano" } });
    const conv = await createConversation(alice);
    await loginAs(alice);

    const res = await patch(conv.id, { projectId: project.id });
    expect(res.status).toBe(200);
    expect((await res.json()).conversation.projectId).toBe(project.id);

    const list = await conversationsRoute.GET(jsonRequest("GET", `/api/conversations?projectId=${project.id}`), {});
    expect((await list.json()).conversations.map((c: { id: string }) => c.id)).toEqual([conv.id]);

    const out = await patch(conv.id, { projectId: null });
    expect((await out.json()).conversation.projectId).toBeNull();
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conv.id } })).projectId).toBeNull();
  });

  it("refuse de rattacher une conversation au projet d'un autre utilisateur", async () => {
    const bobProject = await db.project.create({ data: { userId: bob, name: "Secret" } });
    const conv = await createConversation(alice);
    await loginAs(alice);
    const res = await patch(conv.id, { projectId: bobProject.id });
    expect(res.status).toBe(404);
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conv.id } })).projectId).toBeNull();
  });

  it("le filtre par projet ne révèle pas les conversations d'un autre utilisateur", async () => {
    const bobProject = await db.project.create({ data: { userId: bob, name: "Secret" } });
    await db.conversation.create({ data: { userId: bob, title: "Privé", projectId: bobProject.id } });
    await loginAs(alice);
    const list = await conversationsRoute.GET(jsonRequest("GET", `/api/conversations?projectId=${bobProject.id}`), {});
    expect((await list.json()).conversations).toEqual([]);
  });
});
