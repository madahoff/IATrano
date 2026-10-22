// Logique de routage par JEV : chaque mode d'autorisation, priorités (admin > utilisateur > JEV), repli, confirmation.
import { describe, expect, it } from "vitest";
import { DEFAULT_MODES, parseModesConfig, routingSettingsSchema, ROUTING_FACTORY_DEFAULTS, type ModesConfig, type RoutingMode } from "@/lib/routing/config";
import { applyConfirmation, autoAcceptAfter, decidedBy, decideRouting, finalModes, snapshotOf, type Availability, type DecideInput } from "@/lib/routing/decide";
import { buildJevState, JEV_STATE_TOKEN_BUDGET } from "@/lib/routing/jev-state";
import { countTextTokens } from "@/lib/llm/tokens";

const ALL: Availability = { thinking: { available: true }, research: { available: true }, interactive: { available: true } };
const P = (thinking: number, research: number, interactive: number) => ({ thinking, research, interactive });

function input(over: Partial<DecideInput> = {}): DecideInput {
  return {
    authMode: "AUTO",
    modes: DEFAULT_MODES,
    highThreshold: 0.85,
    probabilities: P(0.9, 0.7, 0.1),
    jevFailed: false,
    fallbackModes: [],
    overrides: {},
    autoAccept: [],
    availability: ALL,
    ...over,
  };
}
const states = (i: DecideInput) => {
  const { outcomes } = decideRouting(i);
  return Object.fromEntries(Object.values(outcomes).map((o) => [o.mode, o.state]));
};

describe("modes d'autorisation", () => {
  it("Automatique : tout mode au-dessus du seuil est activé sans confirmation", () => {
    const r = decideRouting(input({ authMode: "AUTO" }));
    expect(states(input({ authMode: "AUTO" }))).toEqual({ thinking: "on", research: "on", interactive: "off" });
    expect(r.needsConfirmation).toBe(false);
    expect(r.outcomes.thinking).toMatchObject({ source: "jev", reason: "Décidé par JEV (90 %)." });
    expect(r.outcomes.interactive.reason).toMatch(/10 % < seuil 60 %/);
  });

  it("Manuel : tout mode au-dessus du seuil est proposé (confirmation)", () => {
    const r = decideRouting(input({ authMode: "MANUAL" }));
    expect(states(input({ authMode: "MANUAL" }))).toEqual({ thinking: "ask", research: "ask", interactive: "off" });
    expect(r.needsConfirmation).toBe(true);
  });

  it("Hybride : direct au-dessus du seuil haut, confirmation dans la zone grise", () => {
    const r = decideRouting(input({ authMode: "HYBRID" }));
    expect(states(input({ authMode: "HYBRID" }))).toEqual({ thinking: "on", research: "ask", interactive: "off" });
    expect(r.outcomes.research.reason).toMatch(/entre 60 % et 85 %/);
    expect(decideRouting(input({ authMode: "HYBRID", probabilities: P(0.86, 0.2, 0) })).needsConfirmation).toBe(false);
  });

  it("Hybride : bornes incluses (seuil et seuil haut)", () => {
    expect(states(input({ authMode: "HYBRID", probabilities: P(0.85, 0.6, 0.59) }))).toEqual({ thinking: "on", research: "ask", interactive: "off" });
  });

  it("Désactivé : JEV ignoré, seuls les boutons de l'utilisateur comptent", () => {
    expect(states(input({ authMode: "OFF", probabilities: null }))).toEqual({ thinking: "off", research: "off", interactive: "off" });
    expect(states(input({ authMode: "OFF", probabilities: null, overrides: { research: "on" } }))).toEqual({ thinking: "off", research: "on", interactive: "off" });
  });
});

describe("priorités", () => {
  it("le choix de l'utilisateur prime sur JEV, dans tous les modes", () => {
    for (const authMode of ["AUTO", "MANUAL", "HYBRID"] as const) {
      const r = decideRouting(input({ authMode, overrides: { thinking: "off", interactive: "on" } }));
      expect(r.outcomes.thinking).toMatchObject({ state: "off", source: "user" });
      expect(r.outcomes.interactive).toMatchObject({ state: "on", source: "user" });
    }
  });

  it("un mode interdit par l'administration n'est jamais activé, même forcé", () => {
    const modes: ModesConfig = { ...DEFAULT_MODES, research: { ...DEFAULT_MODES.research, rule: "FORBIDDEN" } };
    const r = decideRouting(input({ modes, overrides: { research: "on" } }));
    expect(r.outcomes.research).toMatchObject({ state: "off", source: "admin" });
  });

  it("« toujours confirmer » impose la carte même en automatique, sauf si l'utilisateur force", () => {
    const modes: ModesConfig = { ...DEFAULT_MODES, research: { ...DEFAULT_MODES.research, rule: "CONFIRM" } };
    expect(decideRouting(input({ authMode: "AUTO", modes })).outcomes.research.state).toBe("ask");
    expect(decideRouting(input({ authMode: "AUTO", modes, probabilities: P(0, 0.99, 0) })).outcomes.research.state).toBe("ask");
    expect(decideRouting(input({ authMode: "AUTO", modes, overrides: { research: "on" } })).outcomes.research.state).toBe("on");
    // « Toujours accepter pour cette conversation » ne contourne pas la règle d'administration.
    expect(decideRouting(input({ authMode: "AUTO", modes, autoAccept: ["research"] })).outcomes.research.state).toBe("ask");
  });

  it("un mode indisponible est désactivé avec la raison", () => {
    const availability: Availability = { ...ALL, research: { available: false, reason: "Aucun moteur de recherche n'est configuré." } };
    const r = decideRouting(input({ availability, overrides: { research: "on" } }));
    expect(r.outcomes.research).toMatchObject({ state: "off", source: "unavailable", reason: "Aucun moteur de recherche n'est configuré." });
  });

  it("« Toujours accepter pour cette conversation » transforme une proposition en activation", () => {
    const r = decideRouting(input({ authMode: "MANUAL", autoAccept: ["research"] }));
    expect(r.outcomes.research).toMatchObject({ state: "on", source: "conversation" });
    expect(r.outcomes.thinking.state).toBe("ask");
  });
});

describe("JEV injoignable", () => {
  it("réponse simple par défaut, sans confirmation", () => {
    const r = decideRouting(input({ authMode: "MANUAL", probabilities: null, jevFailed: true }));
    expect(finalModes(r.outcomes)).toEqual([]);
    expect(r.needsConfirmation).toBe(false);
    expect(r.outcomes.thinking).toMatchObject({ source: "fallback", reason: "JEV indisponible : réponse simple." });
    expect(snapshotOf("MANUAL", r.outcomes, true).jevUnavailable).toBe(true);
  });

  it("modes de repli configurés, choix de l'utilisateur conservé", () => {
    const r = decideRouting(input({ probabilities: null, jevFailed: true, fallbackModes: ["thinking"], overrides: { research: "on" } }));
    expect(finalModes(r.outcomes)).toEqual(["thinking", "research"]);
    expect(decidedBy(r.outcomes)).toBe("user");
  });
});

describe("confirmation", () => {
  const base = decideRouting(input({ authMode: "MANUAL" })).outcomes;

  it("Valider : seuls les modes cochés sont activés", () => {
    const out = applyConfirmation(base, "accept", ["research"]);
    expect(finalModes(out)).toEqual(["research"]);
    expect(out.research).toMatchObject({ source: "confirmed", reason: "Confirmé par vous (JEV 70 %)." });
    expect(out.thinking).toMatchObject({ state: "off", source: "refused" });
  });

  it("Répondre sans ces modes : tout est refusé", () => {
    expect(finalModes(applyConfirmation(base, "reject", ["thinking", "research"]))).toEqual([]);
  });

  it("Toujours accepter : modes cochés activés et mémorisés pour la conversation", () => {
    const out = applyConfirmation(base, "always", ["thinking"]);
    expect(finalModes(out)).toEqual(["thinking"]);
    expect(autoAcceptAfter(base, "always", ["thinking"], ["research"])).toEqual(["research", "thinking"]);
    expect(autoAcceptAfter(base, "accept", ["thinking"], [])).toEqual([]);
  });

  it("ne modifie pas les modes déjà décidés", () => {
    const hybrid = decideRouting(input({ authMode: "HYBRID" })).outcomes;
    const out = applyConfirmation(hybrid, "reject", []);
    expect(out.thinking).toEqual(hybrid.thinking);
    expect(finalModes(out)).toEqual(["thinking"]);
  });

  it("origine pour le journal", () => {
    expect(decidedBy(decideRouting(input()).outcomes)).toBe("jev");
    expect(decidedBy(applyConfirmation(base, "accept", ["thinking"]))).toBe("user");
    expect(decidedBy(decideRouting(input({ probabilities: null, jevFailed: true })).outcomes)).toBe("fallback");
  });
});

describe("configuration", () => {
  it("valeurs par défaut : questions du cahier des charges, seuil 0,6, hybride 0,85", () => {
    expect(ROUTING_FACTORY_DEFAULTS.defaultAuthMode).toBe("HYBRID");
    expect(ROUTING_FACTORY_DEFAULTS.highThreshold).toBe(0.85);
    for (const m of ["thinking", "research", "interactive"] as RoutingMode[]) expect(DEFAULT_MODES[m].threshold).toBe(0.6);
    expect(DEFAULT_MODES.research.question).toMatch(/^Does answering this request require recent or external information/);
  });

  it("lecture tolérante de la colonne JSON", () => {
    const parsed = parseModesConfig({ thinking: { question: "Is this a hard math problem?", threshold: 0.7, rule: "CONFIRM" }, research: { threshold: 3 } });
    expect(parsed.thinking).toEqual({ question: "Is this a hard math problem?", threshold: 0.7, rule: "CONFIRM" });
    expect(parsed.research).toEqual(DEFAULT_MODES.research);
    expect(parseModesConfig(null)).toEqual(DEFAULT_MODES);
  });

  it("le seuil haut doit dépasser les seuils des modes", () => {
    const bad = { ...ROUTING_FACTORY_DEFAULTS, highThreshold: 0.5 };
    const r = routingSettingsSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toMatch(/seuil haut/);
  });
});

describe("état envoyé à JEV", () => {
  it("message seul, ou précédé de l'échange précédent", () => {
    expect(buildJevState("Et en 2025 ?", [], true)).toBe("Et en 2025 ?");
    const s = buildJevState("Et en 2025 ?", [{ role: "USER", content: "Population de Madagascar en 2020 ?" }, { role: "ASSISTANT", content: "Environ 27,7 millions." }], true);
    expect(s).toBe("Previous exchange (context only):\nUser: Population de Madagascar en 2020 ?\nAssistant: Environ 27,7 millions.\n\nCurrent user request:\nEt en 2025 ?");
    expect(buildJevState("Et en 2025 ?", [{ role: "USER", content: "x" }], false)).toBe("Et en 2025 ?");
  });

  it("reste sous la limite de contexte de JEV (8 192 tokens) pour un très long message", () => {
    const long = `Début de la consigne. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(4000)} Question finale : que faire ?`;
    const s = buildJevState(long, [{ role: "ASSISTANT", content: "réponse ".repeat(500) }], true);
    expect(countTextTokens(s)).toBeLessThanOrEqual(JEV_STATE_TOKEN_BUDGET);
    expect(s).toContain("Début de la consigne");
    expect(s).toContain("Question finale : que faire ?");
  });
});
