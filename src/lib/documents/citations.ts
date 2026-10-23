// Références documentaires [D1], [D2]… dans les réponses. Partagé client/serveur (aucun import serveur).
// Le serveur supprime les références qui ne correspondent à aucun passage transmis au modèle, puis vérifie que
// chaque passage cité soutient réellement la phrase qui le cite (recouvrement du vocabulaire significatif).

const MAX_ID = 99;

function splitCode(text: string): Array<{ code: boolean; value: string }> {
  const parts: Array<{ code: boolean; value: string }> = [];
  let last = 0;
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g)) {
    if (m.index > last) parts.push({ code: false, value: text.slice(last, m.index) });
    parts.push({ code: true, value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ code: false, value: text.slice(last) });
  return parts;
}

// Variantes : [D 1], [D1, D2], [D1; D3], [D1-D2] (non : ambigu), (D1), 【D1】, [Doc 1] → [D1].
const GROUP = /[[(【]\s*(?:D|Doc\.?|Document)\s*(\d{1,2})((?:\s*[,;]\s*(?:D|Doc\.?|Document)?\s*\d{1,2})*)\s*[\])】]/gi;

export function normalizeDocMarkers(text: string): string {
  return splitCode(text)
    .map((p) =>
      p.code
        ? p.value
        : p.value.replace(GROUP, (_m, first: string, rest: string) => {
            const ns = [first, ...[...(rest ?? "").matchAll(/(\d{1,2})/g)].map((x) => x[1])];
            return ns.map((n) => `[D${Number(n)}]`).join("");
          }),
    )
    .join("");
}

export type DocCitationCheck = { content: string; cited: number[]; removed: number };

export function validateDocCitations(text: string, validIds: ReadonlySet<number>): DocCitationCheck {
  let removed = 0;
  const cited = new Set<number>();
  const content = splitCode(normalizeDocMarkers(text))
    .map((p) =>
      p.code
        ? p.value
        : p.value
            .replace(/\[D(\d{1,2})\]/g, (_m, d: string) => {
              const n = Number(d);
              if (n < 1 || n > MAX_ID || !validIds.has(n)) {
                removed++;
                return "";
              }
              cited.add(n);
              return `[D${n}]`;
            })
            .replace(/(\[D\d{1,2}\])(?:\1)+/g, "$1")
            .replace(/[ \t]+([.,;:!?])/g, "$1")
            .replace(/[ \t]{2,}/g, " "),
    )
    .join("")
    .trim();
  return { content, cited: [...cited].sort((a, b) => a - b), removed };
}

export function hideIncompleteDocMarker(text: string): string {
  return text.replace(/\[\s*D?\s*\d{0,2}$/i, "");
}

export type DocCitationToken = { type: "text"; value: string } | { type: "dcite"; n: number };

export function tokenizeDocCitations(text: string, known: ReadonlySet<number>): DocCitationToken[] {
  const out: DocCitationToken[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[D(\d{1,2})\]/g)) {
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    const n = Number(m[1]);
    if (known.has(n)) out.push({ type: "dcite", n });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

const STOP = new Set(
  "alors aussi autre avant avec avoir cela celle celui cette ceux chaque comme comment dans depuis donc elle elles entre être fait faire leur leurs mais même moins nous parce pendant peut plus pour quand quel quelle quels quelles sans selon sont sous tous tout toute toutes très vous ainsi document page pages section about after also been before being both could does each from have into more most only other such than that their them then there these they this those through very what when where which while with would should".split(" "),
);

/** Racines des mots significatifs (sans accents, 5 premiers caractères) : tolère flexions et pluriels. */
export function contentRoots(text: string): Set<string> {
  const words = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .match(/[a-z0-9]{4,}/g) ?? [];
  return new Set(words.filter((w) => !STOP.has(w)).map((w) => (/^\d+$/.test(w) ? w : w.slice(0, 5))));
}

export type SupportCheck = { n: number; supported: boolean; score: number };

/**
 * Pour chaque référence [Dn], compare la phrase qui la porte au passage cité. Score = part des racines
 * significatives de la phrase présentes dans le passage ; on retient le plus faible des usages (un passage cité
 * une seule fois à tort suffit à alerter). Les nombres de la phrase doivent figurer dans le passage : un chiffre
 * absent de la source rend la référence non étayée.
 */
export function checkCitationSupport(answer: string, passages: ReadonlyMap<number, string>): SupportCheck[] {
  const usage = new Map<number, number[]>();
  const sentences = answer.replace(/```[\s\S]*?```/g, " ").split(/(?<=[.!?])\s+|\n+/);
  let carry = "";
  for (const raw of sentences) {
    const markers = [...raw.matchAll(/\[D(\d{1,2})\]/g)].map((m) => Number(m[1]));
    const sentence = raw.replace(/\[D\d{1,2}\]/g, " ").trim();
    // Marqueur seul en début de ligne : il porte sur la phrase précédente.
    const claim = sentence.length < 12 ? carry : sentence;
    carry = sentence || carry;
    if (!markers.length) continue;
    const roots = contentRoots(claim);
    const numbers = claim.match(/\d+(?:[.,]\d+)?/g) ?? [];
    for (const n of new Set(markers)) {
      const passage = passages.get(n);
      if (!passage) continue;
      const passRoots = contentRoots(passage);
      let matched = 0;
      for (const r of roots) if (passRoots.has(r)) matched++;
      let score = roots.size ? matched / roots.size : 1;
      const folded = passage.replace(/\s/g, "");
      if (numbers.some((x) => !folded.includes(x.replace(/\s/g, "")) && !folded.includes(x.replace(",", ".")) && !folded.includes(x.replace(".", ",")))) score = Math.min(score, 0.15);
      usage.set(n, [...(usage.get(n) ?? []), matched >= 4 ? Math.max(score, 0.3) : score]);
    }
  }
  return [...usage].map(([n, scores]) => {
    const score = Math.round(Math.min(...scores) * 100) / 100;
    return { n, score, supported: score >= 0.25 };
  });
}
