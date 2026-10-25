// Fichiers joints du chat : conservation, aperçus, édition (texte, JSON, CSV, Word), droits, cycle de vie.
import { mkdtempSync, rmSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { db } from "@/lib/db";
import { createUser, jsonRequest, loginAs, params, resetDb } from "../support/fixtures";
import { buildPdf } from "../support/pdf-writer";
import * as attachmentsRoute from "@/app/api/chat/attachments/route";
import * as fileRoute from "@/app/api/chat/files/[id]/route";
import * as contentRoute from "@/app/api/chat/files/[id]/content/route";
import * as pagesRoute from "@/app/api/chat/files/[id]/pages/[number]/route";
import * as previewRoute from "@/app/api/chat/files/[id]/preview/route";
import * as thumbnailRoute from "@/app/api/chat/files/[id]/thumbnail/route";
import { claimChatFiles, sweepChatFiles } from "@/lib/files/chat-files";
import { deleteConversation } from "@/lib/chat/service";
import { attachmentBlock } from "@/lib/files/attachment-tag";
import { readDocxBlocks } from "@/lib/files/docx-text";
import type { ChatFileUpload } from "@/lib/files/types";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const DOCX = zipSync({
  "[Content_Types].xml": strToU8("<Types/>"),
  "word/document.xml": strToU8(
    `<w:document ${W}><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Titre</w:t></w:r></w:p><w:p><w:r><w:t>Paragraphe initial.</w:t></w:r></w:p><w:p><w:hyperlink><w:r><w:t>lien</w:t></w:r></w:hyperlink></w:p><w:sectPr/></w:body></w:document>`,
  ),
  "word/media/image1.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
});

let storage = "";
let alice = "";
let bob = "";

beforeAll(() => {
  storage = mkdtempSync(path.join(os.tmpdir(), "iatrano-chat-files-"));
  process.env.DOCUMENT_STORAGE_DIR = storage;
});
afterAll(() => rmSync(storage, { recursive: true, force: true }));

beforeEach(async () => {
  await resetDb();
  alice = (await createUser()).id;
  bob = (await createUser()).id;
});

async function upload(name: string, data: Uint8Array | string): Promise<{ status: number; body: ChatFileUpload & { error?: { code: string; message: string } } }> {
  const form = new FormData();
  form.append("file", new File([typeof data === "string" ? data : Buffer.from(data)], name));
  const res = await attachmentsRoute.POST(new Request("http://localhost:3000/api/chat/attachments", { method: "POST", body: form, headers: { host: "localhost:3000" } }), {});
  return { status: res.status, body: await res.json() };
}

const put = (id: string, body: unknown) => contentRoute.PUT(jsonRequest("PUT", `/api/chat/files/${id}/content`, body), params({ id }));
const content = (id: string, headers: Record<string, string> = {}) => contentRoute.GET(jsonRequest("GET", `/api/chat/files/${id}/content`, undefined, headers), params({ id }));
const dirOf = (userId: string, id: string) => path.join(storage, "chat", userId, id);

describe("Envoi et conservation", () => {
  it("conserve le fichier, renvoie le texte pour le modèle et les capacités d'aperçu", async () => {
    await loginAs(alice);
    const pdf = await upload("rapport.pdf", buildPdf([1, 2].map((n) => ({ kind: "text" as const, lines: [`Page ${n} du rapport`] }))));
    expect(pdf.status).toBe(200);
    expect(pdf.body).toMatchObject({ kind: "PDF", pageCount: 2, editMode: null, version: 1, sent: false });
    expect(pdf.body.text).toContain("Page 2 du rapport");
    expect(existsSync(path.join(dirOf(alice, pdf.body.id), "original-v1.pdf"))).toBe(true);

    const md = await upload("notes.md", "# Titre\n\nTexte");
    expect(md.body).toMatchObject({ kind: "MARKDOWN", editMode: "markdown", text: "# Titre\n\nTexte" });
    const docx = await upload("lettre.docx", DOCX);
    expect(docx.body).toMatchObject({ kind: "DOCX", editMode: "docx" });
  });

  it("refuse les formats non acceptés, les contenus déguisés et les fichiers corrompus", async () => {
    await loginAs(alice);
    expect((await upload("page.html", "<html></html>")).body.error?.code).toBe("unsupported_format");
    expect((await upload("faux.pdf", "MZ binaire")).body.error?.code).toBe("unsupported_format");
    const broken = buildPdf([{ kind: "text", lines: ["x"] }]).subarray(0, 300);
    const res = await upload("casse.pdf", broken);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("unreadable_file");
    expect(await db.chatFile.count()).toBe(0);
  });
});

describe("Aperçus et contenu", () => {
  it("sert le contenu (texte non interprété, plages d'octets), les pages PDF, la miniature et l'aperçu Word", async () => {
    await loginAs(alice);
    const csv = (await upload("notes.csv", "a;b\n1;2\n")).body;
    const res = await content(csv.id);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("a;b\n1;2\n");
    const partial = await content(csv.id, { range: "bytes=0-2" });
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("a;b");

    const pdf = (await upload("rapport.pdf", buildPdf([{ kind: "text", lines: ["Une page"] }]))).body;
    const page = await pagesRoute.GET(jsonRequest("GET", `/api/chat/files/${pdf.id}/pages/1?scale=1`), params({ id: pdf.id, number: "1" }));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("image/png");
    expect((await pagesRoute.GET(jsonRequest("GET", `/api/chat/files/${pdf.id}/pages/2`), params({ id: pdf.id, number: "2" }))).status).toBe(404);
    const thumb = await thumbnailRoute.GET(jsonRequest("GET", `/api/chat/files/${pdf.id}/thumbnail?v=1`), params({ id: pdf.id }));
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");

    const docx = (await upload("lettre.docx", DOCX)).body;
    const preview = await (await previewRoute.GET(jsonRequest("GET", `/api/chat/files/${docx.id}/preview`), params({ id: docx.id }))).json();
    expect(preview.type).toBe("docx");
    expect(preview.blocks.map((b: { text: string; editable: boolean }) => [b.text, b.editable])).toEqual([["Titre", true], ["Paragraphe initial.", true], ["lien", false]]);
  });
});

describe("Édition", () => {
  it("enregistre une nouvelle version, met à jour le texte du modèle et refuse les écritures concurrentes", async () => {
    await loginAs(alice);
    const md = (await upload("notes.md", "v1")).body;
    const saved = await put(md.id, { baseVersion: 1, text: "# Version 2" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ version: 2, text: "# Version 2" });
    expect(await (await content(md.id)).text()).toBe("# Version 2");
    const stale = await put(md.id, { baseVersion: 1, text: "écrasement" });
    expect(stale.status).toBe(409);
    expect(await (await content(md.id)).text()).toBe("# Version 2");
  });

  it("valide le JSON et refuse d'éditer un format en lecture seule", async () => {
    await loginAs(alice);
    const json = (await upload("config.json", '{"a":1}')).body;
    const bad = await put(json.id, { baseVersion: 1, text: "{invalide" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_json");
    const pdf = (await upload("rapport.pdf", buildPdf([{ kind: "text", lines: ["x"] }]))).body;
    expect((await put(pdf.id, { baseVersion: 1, text: "x" })).status).toBe(400);
  });

  it("modifie le texte d'un document Word sans toucher au reste de l'archive", async () => {
    await loginAs(alice);
    const docx = (await upload("lettre.docx", DOCX)).body;
    expect((await put(docx.id, { baseVersion: 1, edits: [{ index: 2, text: "x" }] })).status).toBe(400); // paragraphe avec lien
    const res = await put(docx.id, { baseVersion: 1, edits: [{ index: 1, text: "Paragraphe modifié." }] });
    expect(res.status).toBe(200);
    expect((await res.json()).text).toContain("Paragraphe modifié.");
    const saved = new Uint8Array(await (await content(docx.id)).arrayBuffer());
    expect(readDocxBlocks(saved).map((b) => b.text)).toEqual(["Titre", "Paragraphe modifié.", "lien"]);
  });
});

describe("Droits d'accès", () => {
  it("un autre utilisateur ne peut ni lire, ni modifier, ni supprimer le fichier (404 sans révéler son existence)", async () => {
    await loginAs(alice);
    const md = (await upload("prive.md", "secret")).body;
    await loginAs(bob);
    expect((await fileRoute.GET(jsonRequest("GET", `/api/chat/files/${md.id}`), params({ id: md.id }))).status).toBe(404);
    expect((await content(md.id)).status).toBe(404);
    expect((await put(md.id, { baseVersion: 1, text: "piraté" })).status).toBe(404);
    expect((await fileRoute.DELETE(jsonRequest("DELETE", `/api/chat/files/${md.id}`), params({ id: md.id }))).status).toBe(404);
    await loginAs(null);
    expect((await content(md.id)).status).toBe(401);
    await loginAs(alice);
    expect(await (await content(md.id)).text()).toBe("secret");
  });
});

describe("Cycle de vie", () => {
  it("rattache les fichiers cités à la conversation, puis les supprime avec elle", async () => {
    await loginAs(alice);
    const f = (await upload("notes.md", "contenu")).body;
    const conv = await db.conversation.create({ data: { userId: alice, title: "c" } });
    // Un fichier d'autrui cité dans le message n'est jamais rattaché.
    await loginAs(bob);
    const other = (await upload("autre.md", "x")).body;
    await claimChatFiles(alice, conv.id, `Question\n\n${attachmentBlock({ ...f, text: "contenu" })}\n\n${attachmentBlock({ ...other, text: "x" })}`);
    expect(await db.chatFile.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ conversationId: conv.id });
    expect((await db.chatFile.findUniqueOrThrow({ where: { id: other.id } })).conversationId).toBeNull();
    // Retrait depuis la zone de saisie : sans effet sur un fichier déjà envoyé.
    await loginAs(alice);
    await fileRoute.DELETE(jsonRequest("DELETE", `/api/chat/files/${f.id}`), params({ id: f.id }));
    expect(await db.chatFile.count({ where: { id: f.id } })).toBe(1);
    await deleteConversation(alice, conv.id);
    expect(await db.chatFile.count({ where: { id: f.id } })).toBe(0);
    expect(existsSync(dirOf(alice, f.id))).toBe(false);
  });

  it("retire tout de suite un fichier jamais envoyé ; le ménage supprime les oubliés et les dossiers orphelins", async () => {
    await loginAs(alice);
    const removed = (await upload("a.md", "a")).body;
    await fileRoute.DELETE(jsonRequest("DELETE", `/api/chat/files/${removed.id}`), params({ id: removed.id }));
    expect(existsSync(dirOf(alice, removed.id))).toBe(false);

    const old = (await upload("b.md", "b")).body;
    const fresh = (await upload("c.md", "c")).body;
    await db.chatFile.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    const orphan = dirOf(alice, "deadbeefdeadbeef");
    mkdirSync(orphan, { recursive: true });
    const past = new Date(Date.now() - 2 * 3600_000);
    utimesSync(orphan, past, past);
    expect(await sweepChatFiles()).toEqual({ unsent: 1, orphans: 1 });
    expect(existsSync(dirOf(alice, old.id))).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(dirOf(alice, fresh.id))).toBe(true);
  });
});
