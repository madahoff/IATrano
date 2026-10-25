// Blocs <attached_document> insérés dans le message utilisateur : le texte extrait d'un fichier joint, transmis au
// modèle. L'attribut `id` relie le bloc au fichier conservé (ChatFile) pour l'afficher et l'ouvrir dans l'interface.
// Module partagé client / serveur (aucune dépendance Node).

export type AttachmentRef = { id: string | null; name: string; kind: string };

const BLOCK = /<attached_document(?: id="([a-z0-9]{8,40})")? name="([^"]*)" kind="([A-Z]+)">[\s\S]*?<\/attached_document>(?:\n\[Limitation : [^\n]*\])?/g;

const attr = (s: string) => s.replace(/[<>"'&\n\r]/g, "").slice(0, 200);

/** Construit le bloc transmis au modèle. Le texte ne peut pas refermer le bloc prématurément. */
export function attachmentBlock(a: { id: string; name: string; kind: string; text: string; warning: string | null }) {
  const text = a.text.replace(/<\/?attached_document/gi, (m) => m.replace("_", "-"));
  return `<attached_document id="${a.id}" name="${attr(a.name)}" kind="${attr(a.kind)}">\n${text}\n</attached_document>${a.warning ? `\n[Limitation : ${a.warning.replace(/\n/g, " ")}]` : ""}`;
}

/** Sépare le texte saisi par l'utilisateur des blocs de fichiers joints (affichage et édition du message). */
export function splitAttachments(content: string): { text: string; attachments: AttachmentRef[]; blocks: string[] } {
  const attachments: AttachmentRef[] = [];
  const blocks: string[] = [];
  const text = content
    .replace(BLOCK, (block, id: string | undefined, name: string, kind: string) => {
      attachments.push({ id: id ?? null, name, kind });
      blocks.push(block);
      return "";
    })
    .trim();
  return { text, attachments, blocks };
}

/** Identifiants des fichiers cités par un message (rattachement à la conversation lors de l'envoi). */
export function attachmentIds(content: string): string[] {
  return [...new Set(splitAttachments(content).attachments.flatMap((a) => (a.id ? [a.id] : [])))].slice(0, 50);
}

/** Recompose un message : texte saisi puis blocs, séparés comme lors de l'envoi depuis la zone de saisie. */
export function joinAttachments(text: string, blocks: string[]) {
  return [text.trim(), blocks.join("\n\n")].filter(Boolean).join("\n\n");
}
