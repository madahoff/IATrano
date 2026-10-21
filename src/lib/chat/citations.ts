// Marqueurs de citation [n] dans les réponses documentées. Partagé client/serveur (aucun import serveur).
// Le serveur valide les références (validateCitations) avant persistance ; le client ne fait que
// les afficher en s'appuyant sur la liste des sources reçue, jamais en devinant.

const MAX_ID = 99;

/** Découpe le texte en segments « code » (``` … ``` ou `…`) et « texte » pour ne jamais toucher au code. */
function splitCode(text: string): Array<{ code: boolean; value: string }> {
  const parts: Array<{ code: boolean; value: string }> = [];
  const re = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push({ code: false, value: text.slice(last, m.index) });
    parts.push({ code: true, value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ code: false, value: text.slice(last) });
  return parts;
}

// Variantes produites par les petits modèles : 【1】, [source 1], [Source : 2], [^3], [1, 2], [1-2] (non : ambigu).
const VARIANT = /【\s*(\d{1,2})\s*】|\[\s*(?:sources?|réf(?:érence)?s?|ref|document|doc)\s*:?\s*(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\s*\]|\[\^(\d{1,2})\]|\(\s*(?:sources?|réf(?:érence)?s?|ref|document|doc)\s*:?\s*\[?\s*(\d{1,2}(?:\s*\]?\s*[,;]?\s*\[?\s*\d{1,2})*)\s*\]?\s*\)/gi;
// Groupe [1] ou [1, 2] ; exclut les liens Markdown [texte](url) et les références [x][y] dont le second membre n'est pas numérique.
const MARKER = /\[(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\](?!\()/g;

/** Uniformise les variantes de marqueurs en [1][2]. */
export function normalizeCitationMarkers(text: string): string {
  return splitCode(text)
    .map((p) =>
      p.code
        ? p.value
        : p.value
            .replace(VARIANT, (_m, a?: string, b?: string, c?: string, d?: string) => toMarkers(a ?? b ?? c ?? d ?? ""))
            .replace(MARKER, (_m, list: string) => toMarkers(list)),
    )
    .join("");
}

function toMarkers(list: string): string {
  return list
    .replace(/[[\]]/g, ",")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((n) => `[${Number(n)}]`)
    .join("");
}

// Section « Sources » ajoutée à la fin par le modèle : redondante avec la liste vérifiée affichée sous la réponse.
const TRAILING_SOURCES = /\n+(?:#{1,6}\s*)?\**(?:sources?|références|references|bibliographie)\**\s*:?\**\s*\n(?:\s*(?:[-*•]|\d+[.)]|\[\d{1,2}\])[^\n]*\n?)+\s*$/i;

export type CitationCheck = { content: string; cited: number[]; removed: number };

/**
 * Valide les marqueurs d'une réponse terminée : seuls les numéros correspondant à une source réellement
 * transmise au modèle sont conservés ; les autres sont supprimés du texte (comptés dans `removed`).
 */
export function validateCitations(text: string, validIds: ReadonlySet<number>): CitationCheck {
  let removed = 0;
  const cited = new Set<number>();
  const body = normalizeCitationMarkers(text).replace(TRAILING_SOURCES, "\n");
  const content = splitCode(body)
    .map((p) => {
      if (p.code) return p.value;
      return p.value
        .replace(/\[(\d{1,2})\](?!\()/g, (_m, d: string) => {
          const n = Number(d);
          if (n < 1 || n > MAX_ID || !validIds.has(n)) {
            removed++;
            return "";
          }
          cited.add(n);
          return `[${n}]`;
        })
        // [1][1] → [1]
        .replace(/(\[\d{1,2}\])(?:\1)+/g, "$1")
        // Restes vides après retrait (« (source : ) », « () »).
        .replace(/\s*\(\s*(?:(?:sources?|réf(?:érence)?s?|ref|documents?|doc)\s*:?\s*)?[,;\s]*\)/gi, "")
        .replace(/[ \t]+([.,;:!?])/g, "$1")
        .replace(/[ \t]{2,}/g, " ");
    })
    .join("")
    .trim();
  return { content, cited: [...cited].sort((a, b) => a - b), removed };
}

/** Pendant le streaming : masque un marqueur encore incomplet en fin de texte (« [ », « [1 », « [1, »). */
export function hideIncompleteMarker(text: string): string {
  return text.replace(/(?:\[\s*(?:\d{1,2}\s*[,;]?\s*)*|【\s*\d{0,2}\s*)$/, "");
}

export type CitationToken = { type: "text"; value: string } | { type: "cite"; n: number };

/** Découpe un texte brut (hors code) en texte et marqueurs connus ; les inconnus sont retirés. */
export function tokenizeCitations(text: string, known: ReadonlySet<number>): CitationToken[] {
  const out: CitationToken[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[(\d{1,2})\](?!\()/g)) {
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    const n = Number(m[1]);
    if (known.has(n)) out.push({ type: "cite", n });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}
