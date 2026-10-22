import type { ChatMessage } from "@/lib/llm/types";

// Consignes données à Qwen pour le mode interactif (artifacts).

export const ARTIFACT_INSTRUCTIONS = `MODE INTERACTIF — en plus de ta réponse écrite, produis UNE page HTML autonome qui explique le sujet visuellement (schéma, animation, simulation avec curseurs, calculateur, frise, explication pas à pas : choisis ce qui aide le plus).

Format obligatoire :
1. D'abord ta réponse écrite habituelle, complète et compréhensible sans la page ; mentionne en une phrase que la page interactive l'accompagne.
2. Puis, à la fin, le bloc suivant, sans balises Markdown autour :
<artifact title="Titre court en français">
<!doctype html>
<html lang="fr">… page complète …</html>
</artifact>

Règles de la page :
- Un seul fichier : HTML, CSS (<style>) et JavaScript (<script>) intégrés. AUCUNE ressource externe : pas de CDN, de bibliothèque, de police, d'image ou d'icône en ligne, pas de fetch ni de requête réseau, pas de localStorage ni de cookies. Les graphiques sont dessinés en SVG ou <canvas> à la main.
- Lisible et responsive : <meta name="viewport" content="width=device-width, initial-scale=1">, mise en page fluide (flex/grid, max-width), lisible de 320 px à un grand écran, polices système, contrastes suffisants, thème clair.
- En français simple. Accessible : <label> associés aux champs, boutons en <button>, utilisable au clavier, textes alternatifs, pas d'information portée uniquement par la couleur.
- Aucune donnée inventée : n'utilise que les chiffres de la conversation, des sources fournies ou des faits établis. Pour une démonstration, utilise des valeurs d'exemple clairement présentées comme telles (« exemple »), et laisse l'utilisateur les modifier.
- Code robuste et sans erreur : pas d'alert/prompt, pas de dépendance au réseau, initialisation au chargement de la page.`;

export const ARTIFACT_EDIT_INSTRUCTIONS = `MODIFICATION DE LA PAGE INTERACTIVE — l'utilisateur demande une modification de la page actuelle, fournie entre <current_artifact> et </current_artifact>.
- Réponds brièvement (une ou deux phrases) en décrivant ce qui change.
- Puis renvoie la page COMPLÈTE modifiée dans un bloc <artifact title="…">…</artifact> (même titre sauf si le sujet change), en conservant tout ce qui n'est pas concerné par la demande.
- Mêmes règles que précédemment : un seul fichier, aucune ressource externe, responsive, en français, accessible, sans données inventées.`;

const MAX_CONTEXT_CODE = 60_000;

/** Bloc du code actuel placé devant la demande de modification. */
export function buildCurrentArtifactBlock(a: { title: string; version: number; code: string }): string {
  const code = a.code.length > MAX_CONTEXT_CODE ? `${a.code.slice(0, MAX_CONTEXT_CODE)}\n<!-- … code tronqué … -->` : a.code;
  return `<current_artifact title="${a.title.replace(/"/g, "'")}" version="${a.version}">\n${code}\n</current_artifact>`;
}

/** Réparation : le code et l'erreur sont renvoyés à Qwen, qui doit rendre la page complète corrigée. */
export function buildRepairPrompt(a: { title: string; code: string }, problem: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: `${ARTIFACT_INSTRUCTIONS}\n\nTu corriges une page interactive existante. Réponds UNIQUEMENT par le bloc <artifact title="…">…</artifact> contenant la page complète corrigée, sans aucun autre texte.`,
    },
    {
      role: "user",
      content: `${buildCurrentArtifactBlock({ ...a, version: 0 })}\n\nProblème constaté dans l'aperçu :\n${problem.slice(0, 2000)}\n\nCorrige la cause de ce problème en gardant le même contenu et le même comportement attendu, puis renvoie la page complète.`,
    },
  ];
}
