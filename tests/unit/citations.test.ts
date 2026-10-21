// Scénario 6 : validation serveur des références ; rendu progressif des marqueurs.
import { describe, expect, it } from "vitest";
import { hideIncompleteMarker, normalizeCitationMarkers, tokenizeCitations, validateCitations } from "@/lib/chat/citations";

const ids = new Set([1, 2, 3]);

describe("validateCitations", () => {
  it("conserve les références valides et liste les sources citées", () => {
    const r = validateCitations("Next.js 16 est sorti [1]. Turbopack est stable [2][3].", ids);
    expect(r.content).toBe("Next.js 16 est sorti [1]. Turbopack est stable [2][3].");
    expect(r.cited).toEqual([1, 2, 3]);
    expect(r.removed).toBe(0);
  });
  it("retire une référence qui ne correspond à aucune source récupérée", () => {
    const r = validateCitations("Affirmation inventée [7]. Vraie affirmation [2].", ids);
    expect(r.content).toBe("Affirmation inventée. Vraie affirmation [2].");
    expect(r.cited).toEqual([2]);
    expect(r.removed).toBe(1);
  });
  it("retire tout marqueur quand aucune source n'existe (moteur indisponible)", () => {
    const r = validateCitations("Selon Internet [1], c'est vrai [2].", new Set());
    expect(r.content).toBe("Selon Internet, c'est vrai.");
    expect(r.cited).toEqual([]);
    expect(r.removed).toBe(2);
  });
  it("uniformise les variantes des petits modèles", () => {
    expect(normalizeCitationMarkers("A [1, 2]. B【3】. C [source 1]. D [Source: 2]. E [^3]. F (source : 1).")).toBe("A [1][2]. B[3]. C [1]. D [2]. E [3]. F [1].");
    expect(validateCitations("Version 16.4 (source: [2], [3]).", ids).content).toBe("Version 16.4 [2][3].");
  });
  it("nettoie les restes vides et dédoublonne [1][1]", () => {
    expect(validateCitations("Texte (source: [9]).", ids).content).toBe("Texte.");
    expect(validateCitations("Texte [1][1].", ids).content).toBe("Texte [1].");
  });
  it("ne touche ni au code ni aux liens Markdown", () => {
    const md = "Tableau `arr[1]` et\n```js\nconst x = a[7];\n```\nVoir [la doc](https://x.dev) [1].";
    const r = validateCitations(md, ids);
    expect(r.content).toContain("`arr[1]`");
    expect(r.content).toContain("a[7]");
    expect(r.content).toContain("[la doc](https://x.dev) [1]");
    expect(r.removed).toBe(0);
  });
  it("supprime la liste « Sources » ajoutée en fin de réponse", () => {
    const r = validateCitations("Réponse [1].\n\nSources :\n- [1] Next.js Blog\n- [2] GitHub", ids);
    expect(r.content).toBe("Réponse [1].");
    expect(r.cited).toEqual([1]);
  });
});

describe("Streaming", () => {
  it.each([
    ["Texte [", "Texte "],
    ["Texte [1", "Texte "],
    ["Texte [1, ", "Texte "],
    ["Texte 【", "Texte "],
    ["Texte [1] fini", "Texte [1] fini"],
  ])("masque le marqueur incomplet de %j", (input, out) => {
    expect(hideIncompleteMarker(input)).toBe(out);
  });
  it("tokenize ne rend cliquables que les numéros connus", () => {
    expect(tokenizeCitations("A [1] B [9] C", ids)).toEqual([
      { type: "text", value: "A " },
      { type: "cite", n: 1 },
      { type: "text", value: " B " },
      { type: "text", value: " C" },
    ]);
  });
});
