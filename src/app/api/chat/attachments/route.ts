import { Readable } from "node:stream";
import { route, json } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { badRequest } from "@/lib/errors";
import { importChatFile } from "@/lib/files/chat-files";
import { CHAT_FILE_MAX_BYTES } from "@/lib/files/types";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

// Réponse à une requête abandonnée par le navigateur (bouton « Annuler ») : personne ne la lira,
// et ce n'est pas une erreur serveur à journaliser.
const aborted = () => new Response(null, { status: 499 });

/**
 * Pièce jointe du chat : le fichier est conservé (aperçu, édition) et son texte extrait est renvoyé pour être
 * transmis au modèle avec le message.
 */
export const POST = route(async (req) => {
  const user = await requireApiUser("chat:use");
  const type = req.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data")) throw badRequest("Envoyez un formulaire multipart.");
  // Refus immédiat d'un envoi trop gros, avant d'en lire le moindre octet (marge pour l'enveloppe multipart).
  const length = Number(req.headers.get("content-length"));
  if (length > CHAT_FILE_MAX_BYTES + 64 * 1024) throw badRequest(`Fichier trop volumineux (maximum ${CHAT_FILE_MAX_BYTES / 1024 / 1024} Mo).`, "file_too_large");
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    if (req.signal.aborted) return aborted();
    throw err;
  }
  const file = form.get("file");
  if (!(typeof File !== "undefined" && file instanceof File)) throw badRequest("Fichier manquant.");
  try {
    // L'annulation côté navigateur interrompt pdfinfo / pdftotext / tesseract en cours.
    const result = await importChatFile(user.id, { name: file.name || "document", body: Readable.fromWeb(file.stream() as never) }, req.signal);
    if (req.signal.aborted) return aborted();
    return json(result);
  } catch (err) {
    if (req.signal.aborted) return aborted();
    throw err;
  }
});
