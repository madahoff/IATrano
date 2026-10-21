import { describe, expect, it } from "vitest";
import { createEventDecoder, encodeEvent } from "@/lib/chat/protocol";
import { buildMessages, fallbackTitle, sanitizeTitle } from "@/lib/llm/prompt";

describe("Protocole NDJSON", () => {
  it("reconstitue des événements coupés entre fragments réseau et ignore les lignes corrompues", () => {
    const line = encodeEvent({ type: "text", delta: "Bonjour\nle monde" }) + "{corrompu\n" + encodeEvent({ type: "done", status: "COMPLETE", durationMs: 5 });
    const d = createEventDecoder();
    const events = [...d.push(line.slice(0, 10)), ...d.push(line.slice(10, 40)), ...d.push(line.slice(40))];
    expect(events).toEqual([
      { type: "text", delta: "Bonjour\nle monde" },
      { type: "done", status: "COMPLETE", durationMs: 5 },
    ]);
  });
});

describe("Construction du contexte", () => {
  it("inclut les consignes de clarification seulement si activées", () => {
    const withC = buildMessages({ clarifications: true, history: [{ role: "USER", content: "Salut" }] });
    const without = buildMessages({ clarifications: false, history: [{ role: "USER", content: "Salut" }] });
    expect(withC[0].content).toContain("<clarify>");
    expect(without[0].content).not.toContain("<clarify>");
    expect(withC.at(-1)).toEqual({ role: "user", content: "Salut" });
  });

  it("rappelle au modèle les questions posées et tronque l'historique trop long", () => {
    const history = [
      { role: "USER" as const, content: "x".repeat(5000) },
      { role: "ASSISTANT" as const, content: "y".repeat(5000) },
      { role: "USER" as const, content: "Conçois une app" },
      { role: "ASSISTANT" as const, content: "Précisions ?", clarification: { questions: [{ question: "Plateforme ?", options: ["Web"] }] } },
      { role: "USER" as const, content: "Web" },
    ];
    const msgs = buildMessages({ clarifications: true, history, charBudget: 6000 });
    expect(msgs[1].role).toBe("user");
    expect(msgs.some((m) => m.content.includes("x".repeat(5000)))).toBe(false);
    expect(msgs.find((m) => m.role === "assistant")?.content).toContain("Plateforme ?");
    expect(msgs.at(-1)?.content).toBe("Web");
  });

  it("utilise les instructions système personnalisées", () => {
    expect(buildMessages({ systemPrompt: "Sois bref.", clarifications: false, history: [] })[0].content).toMatch(/^Sois bref\./);
  });
});

describe("Titres", () => {
  it("nettoie les titres générés et rejette les titres sans mots", () => {
    expect(sanitizeTitle('Titre : "Planifier un voyage".')).toBe("Planifier un voyage");
    expect(sanitizeTitle("<think>hmm</think>\n**Recette de crêpes**")).toBe("Recette de crêpes");
    expect(sanitizeTitle("84")).toBeNull();
    expect(sanitizeTitle("")).toBeNull();
  });
  it("titre de repli à partir du message", () => {
    expect(fallbackTitle("  Bonjour   le monde ")).toBe("Bonjour le monde");
    expect(fallbackTitle("a".repeat(100))).toHaveLength(58);
  });
});
