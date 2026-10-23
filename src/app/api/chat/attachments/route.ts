import { Readable } from "node:stream";
import { readFile, rm } from "node:fs/promises";
import { route, json } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { badRequest } from "@/lib/errors";
import { receiveStream, discardTemp } from "@/lib/documents/storage";
import { detectFormat } from "@/lib/documents/formats";
import { extractPdfPages, pdfInfo } from "@/lib/documents/extract/pdf";
import { ocrImage, cleanOcrText } from "@/lib/documents/ocr";
import { getDocumentSettings } from "@/lib/documents/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_CHARS = 42_000;
const MAX_PDF_PAGES = 60;

function htmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function extract(file: string, kind: string, settings: Awaited<ReturnType<typeof getDocumentSettings>>, signal: AbortSignal) {
  if (kind === "PDF") {
    const info = await pdfInfo(file, signal);
    const total = Math.min(info.pages, MAX_PDF_PAGES);
    const units = await extractPdfPages(file, 1, total, signal);
    const text = units.map((u) => `## Page ${u.number}\n${u.text || "[Page sans texte exploitable]"}`).join("\n\n");
    return { text, warning: info.pages > MAX_PDF_PAGES ? `PDF tronqué pour cette conversation : ${MAX_PDF_PAGES} pages sur ${info.pages}. Pour le document complet, utilisez un projet.` : null };
  }
  if (kind === "DOCX") {
    const mammoth = await import("mammoth");
    const result = await mammoth.convertToHtml({ buffer: await readFile(file) });
    return { text: htmlToText(result.value), warning: result.messages.length ? "Certaines mises en forme Word n’ont pas pu être converties." : null };
  }
  const result = await ocrImage(file, settings.ocrLanguages, signal);
  return { text: cleanOcrText(result.text), warning: result.engine === "tesseract.js" ? "Texte extrait avec OCR logiciel." : null };
}

// Réponse à une requête abandonnée par le navigateur (bouton « Annuler ») : personne ne la lira,
// et ce n'est pas une erreur serveur à journaliser.
const aborted = () => new Response(null, { status: 499 });

export const POST = route(async (req) => {
  await requireApiUser("chat:use");
  const type = req.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data")) throw badRequest("Envoyez un formulaire multipart.");
  // Refus immédiat d'un envoi trop gros, avant d'en lire le moindre octet (marge pour l'enveloppe multipart).
  const length = Number(req.headers.get("content-length"));
  if (length > MAX_BYTES + 64 * 1024) throw badRequest(`Fichier trop volumineux (maximum ${MAX_BYTES / 1024 / 1024} Mo).`, "file_too_large");
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    if (req.signal.aborted) return aborted();
    throw err;
  }
  const file = form.get("file");
  if (!(typeof File !== "undefined" && file instanceof File)) throw badRequest("Fichier manquant.");
  const name = file.name || "document";
  const received = await receiveStream(Readable.fromWeb(file.stream() as never), MAX_BYTES);
  try {
    const detected = detectFormat(name, received.head);
    if (!("kind" in detected) || !["PDF", "DOCX", "IMAGE"].includes(detected.kind)) throw badRequest("Les conversations acceptent uniquement les fichiers PDF, DOCX et images.");
    const settings = await getDocumentSettings();
    // L'annulation côté navigateur interrompt pdfinfo / pdftotext / tesseract en cours.
    const extracted = await extract(received.tempPath, detected.kind, settings, req.signal);
    if (req.signal.aborted) return aborted();
    if (!extracted.text.trim()) throw badRequest("Aucun texte exploitable n’a été trouvé dans ce fichier.");
    const text = extracted.text.slice(0, MAX_CHARS);
    const warning = extracted.warning ?? (extracted.text.length > MAX_CHARS ? "Le contenu a été limité à 42 000 caractères pour préserver le contexte du modèle." : null);
    return json({ name, kind: detected.kind, text, warning });
  } catch (err) {
    if (req.signal.aborted) return aborted();
    throw err;
  } finally {
    await discardTemp(received.tempPath).catch(() => rm(received.tempPath, { force: true }));
  }
});
