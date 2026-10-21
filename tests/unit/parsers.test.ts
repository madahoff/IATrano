import { describe, expect, it } from "vitest";
import { TagSplitter } from "@/lib/llm/tag-splitter";
import { createThinkTagRouter } from "@/lib/llm/think-parser";
import { createClarifyExtractor, looksLikeClarificationRequest, parseClarification } from "@/lib/llm/clarify";

function feed<T>(push: (s: string) => T[], chunks: string[]): T[] {
  return chunks.flatMap((c) => push(c));
}

describe("TagSplitter", () => {
  it("ne laisse jamais fuiter une balise coupée entre deux fragments", () => {
    const s = new TagSplitter("think");
    const parts = [...feed((c) => s.push(c), ["Bon", "jour <th", "ink>rai", "sonne</thi", "nk> fin"]), ...s.flush()];
    const outside = parts.filter((p) => !p.inside).map((p) => p.text).join("");
    const inside = parts.filter((p) => p.inside).map((p) => p.text).join("");
    expect(outside).toBe("Bonjour  fin");
    expect(inside).toBe("raisonne");
    expect(parts.some((p) => p.text.includes("<"))).toBe(false);
  });

  it("restitue un « < » ordinaire qui n'ouvre pas de balise", () => {
    const s = new TagSplitter("think");
    const text = [...s.push("a < b et a <= c"), ...s.flush()].map((p) => p.text).join("");
    expect(text).toBe("a < b et a <= c");
  });
});

describe("Routage du raisonnement <think>", () => {
  it("sépare le raisonnement de la réponse finale", () => {
    const r = createThinkTagRouter();
    const chunks = [...feed((c) => r.push(c), ["<think>Je ", "calcule.</think>", "Réponse : 84"]), ...r.flush()];
    expect(chunks.filter((c) => c.type === "thinking").map((c) => (c as { delta: string }).delta).join("")).toBe("Je calcule.");
    expect(chunks.filter((c) => c.type === "text").map((c) => (c as { delta: string }).delta).join("")).toBe("Réponse : 84");
  });
});

describe("Clarifications", () => {
  const block = '<clarify>{"questions":[{"question":"Quelle plateforme ?","options":["Web","Mobile","Desktop"]}]}</clarify>';

  it("retire le bloc du texte affiché et valide la structure", () => {
    const x = createClarifyExtractor();
    let visible = "";
    for (const c of ["Il me manque une info.\n", block.slice(0, 15), block.slice(15, 60), block.slice(60)]) visible += x.push(c);
    const end = x.finish();
    expect(visible + end.text).toBe("Il me manque une info.\n");
    expect(end.clarification?.questions[0]).toEqual({ question: "Quelle plateforme ?", options: ["Web", "Mobile", "Desktop"] });
    expect(end.malformed).toBe(false);
  });

  it("ignore un JSON invalide sans casser la réponse", () => {
    const x = createClarifyExtractor();
    const visible = x.push('Réponse principale.<clarify>{"questions": [ {"question": "Quoi ?", "opt');
    const end = x.finish();
    expect(visible + end.text).toBe("Réponse principale.");
    expect(end.clarification).toBeNull();
    expect(end.malformed).toBe(true);
  });

  it("sans bloc, ne signale rien", () => {
    const x = createClarifyExtractor();
    x.push("Tokyo.");
    expect(x.finish()).toEqual({ text: "", clarification: null, malformed: false });
  });

  it("tolère les écarts fréquents des petits modèles", () => {
    expect(parseClarification('```json\n{"questions":[{"question":"Langage ?","options":["Python","Go"]}]}\n```')?.questions).toHaveLength(1);
    expect(parseClarification('[{"question":"Langage ?","choices":["Python","Go"]}]')?.questions[0].options).toEqual(["Python", "Go"]);
    expect(parseClarification('{"question":"Langage ?","options":["Python"]}')?.questions).toHaveLength(1);
    // balise fermante mal formée observée avec qwen2.5:3b
    expect(parseClarification('{"questions":[{"question":"Durée ?","options":["1 semaine","2 semaines"]}]}<clarify>')?.questions[0].options).toHaveLength(2);
    expect(parseClarification("pas du json")).toBeNull();
    expect(parseClarification('{"questions":[]}')).toBeNull();
  });

  it("écarte les options génériques", () => {
    const c = parseClarification('{"questions":[{"question":"Destination ?","options":["Destination 1","Japon","Option 2","Italie"]}]}');
    expect(c?.questions[0].options).toEqual(["Japon", "Italie"]);
  });

  it("heuristique de repli : stricte et déterministe", () => {
    expect(looksLikeClarificationRequest("Pour vous aider :\n1. Quelle plateforme ?\n2. Quel budget ?")).toBe(true);
    expect(looksLikeClarificationRequest("Bien sûr ! Où voulez-vous aller ? Quand ? Quel budget avez-vous ?")).toBe(true);
    expect(looksLikeClarificationRequest("Bonjour ! Comment puis-je vous aider ?")).toBe(false);
    expect(looksLikeClarificationRequest("La capitale du Japon est Tokyo.")).toBe(false);
    const explication = "Une closure capture les variables de sa portée englobante. ".repeat(20) + "Pourquoi est-ce utile ? Pour l'encapsulation. Voulez-vous un exemple ?";
    expect(looksLikeClarificationRequest(explication)).toBe(false);
    expect(looksLikeClarificationRequest("```js\n// Quoi ?\n// Pourquoi ?\n```")).toBe(false);
  });
});
