import "server-only";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ChatFile } from "@prisma/client";
import { db } from "@/lib/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { errorDetails, logEvent } from "@/lib/logger";
import { discardTemp, moveIntoPlace, receiveStream, resolveStored, storageRoot } from "@/lib/documents/storage";
import { detectFormat, safeDisplayName } from "@/lib/documents/formats";
import { extractPdfPages, pdfInfo } from "@/lib/documents/extract/pdf";
import { extractPptx, extractXlsx, readXlsxSheets } from "@/lib/documents/extract/office";
import { decodeText } from "@/lib/documents/extract/text";
import { ZipLimitError } from "@/lib/documents/extract/zip";
import { cleanOcrText, ocrImage } from "@/lib/documents/ocr";
import { getDocumentSettings } from "@/lib/documents/settings";
import { runTool, ToolError, toolPath } from "@/lib/documents/tools";
import { DocxEditError, readDocxBlocks, rewriteDocx, type DocxBlock, type DocxEdit } from "./docx-text";
import { attachmentIds } from "./attachment-tag";
import { CHAT_FILE_KINDS, CHAT_FILE_MAX_BYTES, editModeOf, type ChatFileDTO, type ChatFileUpload, type FileKind } from "./types";

// Les commentaires turbopackIgnore excluent ces accès dynamiques du traçage de la sortie standalone (sinon tout le
// dépôt, données locales comprises, y serait copié) : ils visent des fichiers de données, jamais du code.
//
// Fichiers joints du chat : conservés sur disque (<stockage>/chat/<utilisateur>/<fichier>/original-v<n>.<ext>)
// pour l'aperçu et l'édition ; leur texte extrait est transmis au modèle dans le message.
// Cycle de vie : un fichier jamais envoyé est supprimé après 24 h ; un fichier envoyé suit sa conversation.

const MAX_CHARS = 42_000;
const MAX_PDF_PAGES = 60;
const UNSENT_TTL_MS = 24 * 3600_000;
const ID = /^[a-z0-9]{8,40}$/;

const fileDir = (userId: string, fileId: string) => {
  if (!ID.test(userId) || !ID.test(fileId)) throw new Error("Identifiant invalide.");
  return path.join(/* turbopackIgnore: true */ "chat", userId, fileId);
};
const cacheDir = (f: ChatFile) => path.join(/* turbopackIgnore: true */ fileDir(f.userId, f.id), "cache");
const extOf = (storagePath: string) => path.extname(storagePath).toLowerCase();

export const conflict = (msg: string) => new AppError(409, "conflict", msg);

let thumbTools: { ffmpeg: boolean; pdftoppm: boolean } | null = null;
async function tools() {
  thumbTools ??= { ffmpeg: Boolean(await toolPath("ffmpeg")), pdftoppm: Boolean(await toolPath("pdftoppm")) };
  return thumbTools;
}

const BROWSER_IMAGES = /^image\/(png|jpeg|webp|gif)$/;

export async function toChatFileDTO(f: ChatFile): Promise<ChatFileDTO> {
  const t = await tools();
  const kind = f.kind as FileKind;
  return {
    id: f.id,
    name: f.name,
    kind,
    mimeType: f.mimeType,
    sizeBytes: f.sizeBytes,
    version: f.version,
    pageCount: f.pageCount,
    warning: f.warning,
    editMode: editModeOf(kind),
    hasThumbnail: kind === "PDF" ? t.pdftoppm : kind === "IMAGE" ? t.ffmpeg || BROWSER_IMAGES.test(f.mimeType) : kind === "VIDEO" ? t.ffmpeg : false,
    sent: f.conversationId !== null,
    updatedAt: f.updatedAt.toISOString(),
  };
}

function htmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|tr)\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

type Extracted = { text: string; warning: string | null; pageCount: number | null };

/** Texte transmis au modèle, selon le format. Lève une erreur lisible si le fichier est illisible ou corrompu. */
async function extractText(file: string, kind: FileKind, signal?: AbortSignal): Promise<Extracted> {
  const warnings: string[] = [];
  let text = "";
  let pageCount: number | null = null;
  switch (kind) {
    case "PDF": {
      const info = await pdfInfo(file, signal);
      pageCount = info.pages;
      const units = await extractPdfPages(file, 1, Math.min(info.pages, MAX_PDF_PAGES), signal);
      text = units.map((u) => `## Page ${u.number}\n${u.text || "[Page sans texte exploitable]"}`).join("\n\n");
      if (info.pages > MAX_PDF_PAGES) warnings.push(`PDF tronqué pour cette conversation : ${MAX_PDF_PAGES} pages sur ${info.pages}. Pour le document complet, utilisez un projet.`);
      break;
    }
    case "DOCX": {
      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml({ buffer: await readFile(/* turbopackIgnore: true */ file) });
      text = htmlToText(result.value);
      if (result.messages.length) warnings.push("Certaines mises en forme Word n’ont pas pu être converties pour l’IA.");
      break;
    }
    case "IMAGE": {
      const settings = await getDocumentSettings();
      const ocr = await ocrImage(file, settings.ocrLanguages, signal);
      text = cleanOcrText(ocr.text);
      if (ocr.engine === "tesseract.js") warnings.push("Texte extrait avec OCR logiciel.");
      break;
    }
    case "TEXT":
    case "MARKDOWN":
    case "JSON":
    case "CSV":
      text = decodeText(await readFile(/* turbopackIgnore: true */ file));
      break;
    case "XLSX": {
      const r = extractXlsx(new Uint8Array(await readFile(/* turbopackIgnore: true */ file)), 5000);
      text = r.units.map((u) => u.text).join("\n\n");
      warnings.push(...r.warnings);
      break;
    }
    case "PPTX":
      text = extractPptx(new Uint8Array(await readFile(/* turbopackIgnore: true */ file))).units.map((u) => u.text).join("\n\n");
      break;
    case "AUDIO":
    case "VIDEO":
      warnings.push("Contenu audio non transcrit dans le chat : importez le fichier dans un projet pour obtenir sa transcription.");
      break;
    default:
      throw badRequest("Format non pris en charge dans le chat.");
  }
  if (!text.trim() && kind !== "AUDIO" && kind !== "VIDEO") warnings.push("Aucun texte exploitable n’a été trouvé : l’IA ne recevra que le nom du fichier.");
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    warnings.push("Le contenu a été limité à 42 000 caractères pour préserver le contexte du modèle.");
  }
  return { text, warning: warnings.join(" ") || null, pageCount };
}

/** Erreur d'un outil ou d'une archive → message utilisateur (fichier corrompu ou illisible). */
function unreadable(err: unknown): never {
  if (err instanceof AppError) throw err;
  if (err instanceof ZipLimitError) throw badRequest(err.message, "unreadable_file");
  if (err instanceof ToolError && err.code === "missing") throw new AppError(503, "tool_missing", err.message);
  if (err instanceof ToolError || err instanceof Error) throw badRequest("Le fichier est illisible ou corrompu.", "unreadable_file");
  throw err;
}

export async function importChatFile(userId: string, input: { name: string; body: ReadableStream<Uint8Array> | Readable }, signal?: AbortSignal): Promise<ChatFileUpload> {
  const name = safeDisplayName(input.name);
  const received = await receiveStream(input.body, CHAT_FILE_MAX_BYTES);
  try {
    const detected = detectFormat(name, received.head);
    if ("error" in detected) throw badRequest(detected.error, "unsupported_format");
    const kind = detected.kind as FileKind;
    if (!CHAT_FILE_KINDS.includes(kind)) throw badRequest("Ce format n’est pas accepté dans le chat. Importez-le dans un projet.", "unsupported_format");
    const extracted = await extractText(received.tempPath, kind, signal).catch(unreadable);
    const id = randomUUID().replace(/-/g, "");
    const storagePath = path.join(/* turbopackIgnore: true */ fileDir(userId, id), `original-v1${detected.ext}`);
    await moveIntoPlace(received.tempPath, storagePath);
    try {
      const row = await db.chatFile.create({
        data: { id, userId, name, kind, mimeType: detected.mime, sizeBytes: received.size, checksum: received.checksum, storagePath, pageCount: extracted.pageCount, text: extracted.text, warning: extracted.warning },
      });
      return { ...(await toChatFileDTO(row)), text: row.text };
    } catch (err) {
      await rm(/* turbopackIgnore: true */ resolveStored(fileDir(userId, id)), { recursive: true, force: true });
      throw err;
    }
  } finally {
    await discardTemp(received.tempPath).catch(() => {});
  }
}

export async function getOwnedChatFile(userId: string, id: string): Promise<ChatFile> {
  if (!ID.test(id)) throw notFound("Fichier introuvable.");
  const f = await db.chatFile.findFirst({ where: { id, userId } });
  if (!f) throw notFound("Fichier introuvable.");
  return f;
}

/** Enregistre une nouvelle version (verrou optimiste sur `version`), réextrait le texte, invalide les aperçus. */
async function writeVersion(f: ChatFile, baseVersion: number, bytes: Uint8Array): Promise<ChatFileUpload> {
  if (baseVersion !== f.version) throw conflict("Ce fichier a été modifié entre-temps (autre onglet ?). Rechargez-le avant d’enregistrer.");
  if (bytes.byteLength > CHAT_FILE_MAX_BYTES) throw badRequest(`Fichier trop volumineux (maximum ${CHAT_FILE_MAX_BYTES / 1024 / 1024} Mo).`, "file_too_large");
  const version = f.version + 1;
  const storagePath = path.join(/* turbopackIgnore: true */ fileDir(f.userId, f.id), `original-v${version}${extOf(f.storagePath)}`);
  const full = resolveStored(storagePath);
  await writeFile(/* turbopackIgnore: true */ full, bytes, { mode: 0o600 });
  try {
    const extracted = await extractText(full, f.kind as FileKind).catch(unreadable);
    const res = await db.chatFile.updateMany({
      where: { id: f.id, version: f.version },
      data: { version, storagePath, sizeBytes: bytes.byteLength, checksum: createHash("sha256").update(bytes).digest("hex"), text: extracted.text, warning: extracted.warning, pageCount: extracted.pageCount },
    });
    if (res.count === 0) throw conflict("Ce fichier a été modifié entre-temps (autre onglet ?). Rechargez-le avant d’enregistrer.");
  } catch (err) {
    await rm(/* turbopackIgnore: true */ full, { force: true });
    throw err;
  }
  // Aperçus à régénérer ; la version précédente est gardée (secours), les plus anciennes sont supprimées.
  await rm(/* turbopackIgnore: true */ resolveStored(cacheDir(f)), { recursive: true, force: true });
  if (version > 2) await rm(/* turbopackIgnore: true */ resolveStored(path.join(/* turbopackIgnore: true */ fileDir(f.userId, f.id), `original-v${version - 2}${extOf(f.storagePath)}`)), { force: true });
  const row = await db.chatFile.findUniqueOrThrow({ where: { id: f.id } });
  return { ...(await toChatFileDTO(row)), text: row.text };
}

export async function saveChatFileText(userId: string, id: string, baseVersion: number, text: string) {
  const f = await getOwnedChatFile(userId, id);
  const mode = editModeOf(f.kind as FileKind);
  if (mode !== "text" && mode !== "markdown" && mode !== "json" && mode !== "csv") throw badRequest("Ce fichier ne se modifie pas comme du texte.");
  if (mode === "json") {
    try {
      JSON.parse(text);
    } catch (err) {
      throw badRequest(`JSON invalide : ${err instanceof Error ? err.message : "syntaxe incorrecte"}.`, "invalid_json");
    }
  }
  return writeVersion(f, baseVersion, new TextEncoder().encode(text));
}

export async function saveChatFileDocx(userId: string, id: string, baseVersion: number, edits: DocxEdit[]) {
  const f = await getOwnedChatFile(userId, id);
  if (f.kind !== "DOCX") throw badRequest("Ce fichier n’est pas un document Word.");
  let bytes: Uint8Array;
  try {
    bytes = rewriteDocx(new Uint8Array(await readFile(/* turbopackIgnore: true */ resolveStored(f.storagePath))), edits);
  } catch (err) {
    if (err instanceof DocxEditError || err instanceof ZipLimitError) throw badRequest(err.message, "docx_edit");
    throw err;
  }
  return writeVersion(f, baseVersion, bytes);
}

export type ChatFilePreview =
  | { type: "docx"; version: number; blocks: DocxBlock[] }
  | { type: "xlsx"; version: number; sheets: Array<{ name: string; rows: Array<{ number: number; values: string[] }>; truncated: boolean; width: number }> }
  | { type: "pptx"; version: number; slides: Array<{ number: number; text: string }> };

const PREVIEW_ROWS = 1000;
const PREVIEW_COLS = 60;

/** Données structurées d'aperçu pour les formats que le navigateur ne lit pas seul. */
export async function chatFilePreview(f: ChatFile): Promise<ChatFilePreview> {
  const data = new Uint8Array(await readFile(/* turbopackIgnore: true */ resolveStored(f.storagePath)));
  try {
    if (f.kind === "DOCX") return { type: "docx", version: f.version, blocks: readDocxBlocks(data) };
    if (f.kind === "XLSX") {
      const sheets = readXlsxSheets(data, PREVIEW_ROWS).map((s) => ({
        name: s.name,
        truncated: s.truncated || s.rows.some((r) => r.values.length > PREVIEW_COLS),
        rows: s.rows.map((r) => ({ number: r.number, values: r.values.slice(0, PREVIEW_COLS).map((v) => v.slice(0, 500)) })),
        width: Math.min(PREVIEW_COLS, Math.max(0, ...s.rows.map((r) => r.values.length))),
      }));
      return { type: "xlsx", version: f.version, sheets };
    }
    if (f.kind === "PPTX") return { type: "pptx", version: f.version, slides: extractPptx(data).units.map((u) => ({ number: u.number, text: u.text })) };
  } catch (err) {
    unreadable(err);
  }
  throw badRequest("Aucun aperçu structuré pour ce format.");
}

const inflight = new Map<string, Promise<string | null>>();

/** Génère une seule fois une image dérivée (miniature, page rendue), même si plusieurs requêtes arrivent ensemble. */
function once(key: string, make: () => Promise<string | null>) {
  let p = inflight.get(key);
  if (!p) {
    p = make().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function exists(relative: string) {
  return stat(/* turbopackIgnore: true */ resolveStored(relative)).then(() => true, () => false);
}

/** Miniature (chemin relatif + type), ou null si le format ne s'y prête pas. */
export async function chatFileThumbnail(f: ChatFile): Promise<{ path: string; mime: string } | null> {
  const t = await tools();
  const src = resolveStored(f.storagePath);
  const dir = cacheDir(f);
  if (f.kind === "PDF" && t.pdftoppm) {
    const rel = path.join(/* turbopackIgnore: true */ dir, `thumb-v${f.version}.jpg`);
    const ok = await once(rel, async () => {
      if (await exists(rel)) return rel;
      await mkdir(/* turbopackIgnore: true */ resolveStored(dir), { recursive: true });
      await runTool("pdftoppm", ["-f", "1", "-l", "1", "-scale-to", "480", "-jpeg", "-singlefile", src, resolveStored(rel).replace(/\.jpg$/, "")], { timeoutMs: 60_000 });
      return rel;
    }).catch(() => null);
    return ok ? { path: ok, mime: "image/jpeg" } : null;
  }
  if ((f.kind === "IMAGE" || f.kind === "VIDEO") && t.ffmpeg) {
    // PNG pour les images (transparence conservée), JPEG pour les vidéos.
    const rel = path.join(/* turbopackIgnore: true */ dir, f.kind === "IMAGE" ? `thumb-v${f.version}.png` : `thumb-v${f.version}.jpg`);
    const ok = await once(rel, async () => {
      if (await exists(rel)) return rel;
      await mkdir(/* turbopackIgnore: true */ resolveStored(dir), { recursive: true });
      const out = resolveStored(rel);
      const scale = "scale='min(480,iw)':-2";
      const seek = f.kind === "VIDEO" ? ["-ss", "1"] : [];
      await runTool("ffmpeg", ["-v", "error", "-y", ...seek, "-i", src, "-frames:v", "1", "-vf", scale, out], { timeoutMs: 60_000 }).catch(async (err) => {
        if (f.kind !== "VIDEO") throw err;
        await runTool("ffmpeg", ["-v", "error", "-y", "-i", src, "-frames:v", "1", "-vf", scale, out], { timeoutMs: 60_000 });
      });
      return (await exists(rel)) ? rel : null;
    }).catch(() => null);
    if (ok) return { path: ok, mime: f.kind === "IMAGE" ? "image/png" : "image/jpeg" };
  }
  // Sans ffmpeg : une image que le navigateur sait afficher sert de miniature (redimensionnée côté client).
  if (f.kind === "IMAGE" && BROWSER_IMAGES.test(f.mimeType)) return { path: f.storagePath, mime: f.mimeType };
  return null;
}

export const PDF_PAGE_DPI = { 1: 96, 2: 160, 3: 240 } as const;

/** Page de PDF rendue en PNG couleur (mise en cache), pour la visionneuse intégrée. */
export async function chatFilePdfPage(f: ChatFile, page: number, scale: keyof typeof PDF_PAGE_DPI): Promise<string> {
  if (f.kind !== "PDF") throw badRequest("Ce fichier n’est pas un PDF.");
  if (!Number.isInteger(page) || page < 1 || (f.pageCount && page > f.pageCount)) throw notFound("Page introuvable.");
  const dpi = PDF_PAGE_DPI[scale];
  const dir = cacheDir(f);
  const rel = path.join(/* turbopackIgnore: true */ dir, `page-v${f.version}-${page}-${dpi}.png`);
  const out = await once(rel, async () => {
    if (await exists(rel)) return rel;
    await mkdir(/* turbopackIgnore: true */ resolveStored(dir), { recursive: true });
    await runTool("pdftoppm", ["-f", String(page), "-l", String(page), "-r", String(dpi), "-scale-to", "3200", "-png", "-singlefile", resolveStored(f.storagePath), resolveStored(rel).replace(/\.png$/, "")], { timeoutMs: 120_000 });
    return rel;
  }).catch(unreadable);
  if (!out) throw notFound("Page introuvable.");
  return out;
}

/** Rattache à la conversation les fichiers cités par un message envoyé (seulement ceux de l'utilisateur). */
export async function claimChatFiles(userId: string, conversationId: string, content: string) {
  const ids = attachmentIds(content);
  if (!ids.length) return;
  await db.chatFile.updateMany({
    where: { id: { in: ids }, userId, OR: [{ conversationId: null }, { conversationId }] },
    data: { conversationId, sentAt: new Date() },
  });
}

/** Retrait d'un fichier de la zone de saisie : supprimé seulement s'il n'a jamais été envoyé. */
export async function discardUnsentChatFile(userId: string, id: string) {
  const f = await getOwnedChatFile(userId, id);
  if (f.conversationId) return;
  await db.chatFile.deleteMany({ where: { id: f.id, conversationId: null } });
  await rm(/* turbopackIgnore: true */ resolveStored(fileDir(userId, f.id)), { recursive: true, force: true });
}

/** Fichiers d'une conversation (relevés avant sa suppression, pour effacer leurs dossiers ensuite). */
export async function conversationFileDirs(userId: string, conversationId: string) {
  const rows = await db.chatFile.findMany({ where: { userId, conversationId }, select: { id: true } });
  return rows.map((r) => fileDir(userId, r.id));
}

export async function removeFileDirs(dirs: string[]) {
  for (const d of dirs) await rm(/* turbopackIgnore: true */ resolveStored(d), { recursive: true, force: true }).catch(() => {});
}

/**
 * Ménage : fichiers jamais envoyés depuis plus de 24 h, et dossiers sans ligne en base (conversation ou compte
 * supprimé). Un dossier récent (< 1 h) est épargné : un envoi peut être en cours d'enregistrement.
 */
export async function sweepChatFiles(now = Date.now()) {
  const stale = await db.chatFile.findMany({ where: { conversationId: null, createdAt: { lt: new Date(now - UNSENT_TTL_MS) } }, select: { id: true, userId: true } });
  if (stale.length) {
    await db.chatFile.deleteMany({ where: { id: { in: stale.map((s) => s.id) }, conversationId: null } });
    await removeFileDirs(stale.map((s) => fileDir(s.userId, s.id)));
  }
  const root = path.join(/* turbopackIgnore: true */ storageRoot(), "chat");
  const users = await readdir(/* turbopackIgnore: true */ root).catch(() => [] as string[]);
  let orphans = 0;
  for (const userId of users.filter((u) => ID.test(u))) {
    const ids = (await readdir(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ root, userId)).catch(() => [] as string[])).filter((d) => ID.test(d));
    if (!ids.length) continue;
    const known = new Set((await db.chatFile.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id));
    for (const id of ids) {
      if (known.has(id)) continue;
      const info = await stat(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ root, userId, id)).catch(() => null);
      if (info && now - info.mtimeMs > 3600_000) {
        await rm(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ root, userId, id), { recursive: true, force: true });
        orphans++;
      }
    }
  }
  return { unsent: stale.length, orphans };
}

const g = globalThis as unknown as { __iatranoChatFileSweeper?: NodeJS.Timeout };

export function startChatFileSweeper() {
  if (g.__iatranoChatFileSweeper) return;
  const run = () => void sweepChatFiles().catch((err) => logEvent("WARN", "chat-files", "Ménage des fichiers joints impossible", errorDetails(err)));
  g.__iatranoChatFileSweeper = setInterval(run, 3600_000);
  g.__iatranoChatFileSweeper.unref?.();
  setTimeout(run, 120_000).unref?.();
}
