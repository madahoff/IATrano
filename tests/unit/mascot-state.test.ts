import { describe, expect, it } from "vitest";
import { deriveMascotState, searchPhase, shortModelName, type AssistantSignal, type MascotInput } from "@/lib/mascot/state";

const assistant = (over: Partial<AssistantSignal> = {}): AssistantSignal => ({
  started: true,
  status: "STREAMING",
  hasText: false,
  hasThinking: false,
  thinkingEnabled: false,
  hasClarification: false,
  buildingArtifact: false,
  research: null,
  ...over,
});

const input = (over: Partial<MascotInput> = {}): MascotInput => ({
  routing: null,
  isStreaming: false,
  assistant: null,
  requestFailed: false,
  justCompleted: false,
  modelName: "Qwen",
  ...over,
});

const state = (over: Partial<MascotInput>) => deriveMascotState(input(over)).state;

describe("deriveMascotState", () => {
  it("repos sans conversation ni activité", () => {
    expect(deriveMascotState(input())).toEqual({ state: "idle", label: "" });
  });

  it("écoute pendant l'analyse JEV, puis attend une confirmation", () => {
    expect(deriveMascotState(input({ routing: "analyzing" }))).toMatchObject({ state: "listening", label: "JEV analyse votre demande…" });
    expect(state({ routing: "confirm" })).toBe("asking");
  });

  it("écoute tant que le serveur n'a pas confirmé le démarrage", () => {
    expect(state({ isStreaming: true, assistant: assistant({ started: false }) })).toBe("listening");
  });

  it("réfléchit avant le premier jeton, avec ou sans thinking", () => {
    expect(deriveMascotState(input({ isStreaming: true, assistant: assistant() }))).toMatchObject({ state: "thinking", label: "Qwen prépare la réponse…" });
    expect(deriveMascotState(input({ isStreaming: true, assistant: assistant({ hasThinking: true }) }))).toMatchObject({ state: "thinking", label: "Qwen réfléchit…" });
  });

  it("recherche selon l'étape réellement en cours", () => {
    const research = (kind: "search" | "fetch" | "select") => ({ status: "running" as const, steps: [{ kind: "queries" as const, status: "done" as const }, { kind, status: "running" as const }] });
    expect(deriveMascotState(input({ isStreaming: true, assistant: assistant({ research: research("search") }) }))).toMatchObject({ state: "searching", phase: "scan" });
    expect(deriveMascotState(input({ isStreaming: true, assistant: assistant({ research: research("fetch") }) }))).toMatchObject({ state: "searching", phase: "read" });
    expect(deriveMascotState(input({ isStreaming: true, assistant: assistant({ research: research("select") }) }))).toMatchObject({ state: "searching", phase: "analyze" });
  });

  it("recherche terminée : la mascotte n'indique plus de recherche", () => {
    const research = { status: "done" as const, steps: [{ kind: "fetch" as const, status: "done" as const }] };
    expect(state({ isStreaming: true, assistant: assistant({ research }) })).toBe("thinking");
    expect(state({ isStreaming: true, assistant: assistant({ research, hasText: true }) })).toBe("generating");
  });

  it("rédige dès que le texte arrive, y compris pour une page interactive", () => {
    expect(state({ isStreaming: true, assistant: assistant({ hasText: true }) })).toBe("generating");
    expect(deriveMascotState(input({ isStreaming: true, assistant: assistant({ buildingArtifact: true }) }))).toMatchObject({ state: "generating", label: "Création de la page interactive…" });
  });

  it("satisfaction uniquement juste après une fin observée, sinon repos", () => {
    const done = assistant({ status: "COMPLETE", hasText: true });
    expect(state({ assistant: done, justCompleted: true })).toBe("completed");
    expect(state({ assistant: done })).toBe("idle");
  });

  it("erreurs : génération échouée ou requête refusée avant démarrage", () => {
    expect(state({ assistant: assistant({ status: "ERROR" }) })).toBe("error");
    expect(state({ requestFailed: true })).toBe("error");
  });

  it("une annulation ramène au repos (aucune activité affichée)", () => {
    expect(state({ assistant: assistant({ status: "CANCELLED", hasText: true }) })).toBe("idle");
  });

  it("question de précision de l'IA : attente de l'utilisateur", () => {
    expect(state({ assistant: assistant({ status: "COMPLETE", hasText: true, hasClarification: true }) })).toBe("asking");
  });

  it("le flux en cours prime sur un échec précédent", () => {
    expect(state({ isStreaming: true, requestFailed: true, assistant: assistant({ hasText: true }) })).toBe("generating");
  });
});

describe("searchPhase", () => {
  it("balayage par défaut quand aucune étape n'est en cours", () => {
    expect(searchPhase([])).toBe("scan");
  });
});

describe("shortModelName", () => {
  it.each([
    ["qwen3:32b", "Qwen"],
    ["qwen2.5:3b", "Qwen"],
    ["library/llama3.1:8b", "Llama"],
    ["", "L'IA"],
    [null, "L'IA"],
  ])("%s → %s", (model, expected) => {
    expect(shortModelName(model)).toBe(expected);
  });
});
