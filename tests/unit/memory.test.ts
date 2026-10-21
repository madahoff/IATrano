import { describe, expect, it } from "vitest";
import { sensitiveReason } from "@/lib/memory/sensitive";
import { findDuplicate, memoryBudget, selectMemories, type MemoryLike } from "@/lib/memory/select";
import { hasMemoryCue, parseMemoryActions } from "@/lib/memory/extract";

const mem = (id: string, kind: MemoryLike["kind"], content: string, project: string | null = null): MemoryLike => ({ id, kind, content, project, updatedAt: new Date() });

describe("données sensibles", () => {
  it("refuse mots de passe, clés, jetons et cartes bancaires", () => {
    expect(sensitiveReason("Mon mot de passe est hunter2")).not.toBeNull();
    expect(sensitiveReason("password: azerty123")).not.toBeNull();
    expect(sensitiveReason("Ma clé sk-proj-abcdefghijklmnopqrstuvwxyz123456")).not.toBeNull();
    expect(sensitiveReason("token ghp_abcdefghijklmnopqrstuvwxyz0123456789")).not.toBeNull();
    expect(sensitiveReason("Carte 4111 1111 1111 1111")).not.toBeNull();
    expect(sensitiveReason("jeton eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh")).not.toBeNull();
  });
  it("accepte les informations ordinaires", () => {
    expect(sensitiveReason("L'utilisateur préfère des réponses concises.")).toBeNull();
    expect(sensitiveReason("L'utilisateur déploie avec Dokploy sur un serveur local.")).toBeNull();
    expect(sensitiveReason("Il souhaite gérer les mots de passe de son application avec scrypt.")).toBeNull();
    expect(sensitiveReason("Secret professionnel : projet Atlas")).toBeNull();
    expect(sensitiveReason("Le token JWT expire après une heure.")).toBeNull();
  });
});

describe("sélection des souvenirs", () => {
  const all = [
    mem("p1", "PREFERENCE", "L'utilisateur préfère des réponses en français, concises."),
    mem("f1", "FACT", "L'utilisateur développe avec Next.js et PostgreSQL."),
    mem("f2", "FACT", "L'utilisateur fait du vélo le week-end."),
    mem("j1", "PROJECT", "Le projet utilise Ollama avec qwen2.5:3b.", "IATrano"),
  ];
  it("injecte toujours les préférences, et seulement les faits pertinents pour la demande", () => {
    const ids = selectMemories(all, "Comment optimiser une requête PostgreSQL ?", 500).map((m) => m.id);
    expect(ids).toContain("p1");
    expect(ids).toContain("f1");
    expect(ids).not.toContain("f2");
    expect(ids).not.toContain("j1");
  });
  it("reconnaît les formes fléchies d'un même mot", () => {
    const d = [mem("d1", "FACT", "L'utilisateur déploie toujours ses applications avec Dokploy sur son serveur local.")];
    expect(selectMemories(d, "Comment devrais-je déployer ma nouvelle API ?", 500).map((m) => m.id)).toEqual(["d1"]);
    expect(selectMemories(d, "Quelle est la capitale du Japon ?", 500)).toEqual([]);
  });
  it("le nom d'un projet suffit à rendre sa mémoire pertinente", () => {
    expect(selectMemories(all, "Où en est IATrano ?", 500).map((m) => m.id)).toContain("j1");
  });
  it("respecte le budget de tokens", () => {
    expect(selectMemories(all, "PostgreSQL Next.js vélo IATrano", 20).length).toBeLessThan(4);
    expect(memoryBudget(7168)).toBe(430);
    expect(memoryBudget(100_000)).toBe(600);
  });
  it("détecte les doublons proches", () => {
    expect(findDuplicate("L'utilisateur préfère les réponses en français et concises", all)?.id).toBe("p1");
    expect(findDuplicate("L'utilisateur a un chat", all)).toBeNull();
  });
});

describe("extraction automatique", () => {
  it("ne se déclenche que sur des formulations explicites", () => {
    expect(hasMemoryCue("Retiens que je travaille avec Dokploy")).toBe(true);
    expect(hasMemoryCue("Appelle-moi Heri")).toBe(true);
    expect(hasMemoryCue("Oublie que j'utilise MySQL")).toBe(true);
    expect(hasMemoryCue("Désormais, réponds-moi en anglais")).toBe(true);
    expect(hasMemoryCue("Quelle est la capitale de Madagascar ?")).toBe(false);
    expect(hasMemoryCue("Explique-moi les closures en JavaScript")).toBe(false);
  });
  it("valide la sortie du modèle et n'agit que sur des souvenirs réels de l'utilisateur", () => {
    const refs = new Map([["M1", "real-id-1"]]);
    const actions = parseMemoryActions(
      JSON.stringify({
        actions: [
          { action: "add", kind: "PREFERENCE", content: "L'utilisateur veut être tutoyé." },
          { action: "update", ref: "M1", content: "L'utilisateur utilise PostgreSQL 16." },
          { action: "delete", ref: "M9" },
          { action: "add", kind: "PROJECT", content: "Projet sans nom donné" },
          { action: "add", content: "x" },
        ],
      }),
      refs,
    );
    expect(actions).toEqual([
      { action: "add", kind: "PREFERENCE", project: null, content: "L'utilisateur veut être tutoyé." },
      { action: "update", id: "real-id-1", content: "L'utilisateur utilise PostgreSQL 16." },
    ]);
  });
  it("ignore une sortie invalide", () => {
    expect(parseMemoryActions("n'importe quoi", new Map())).toEqual([]);
    expect(parseMemoryActions('{"actions":"non"}', new Map())).toEqual([]);
  });
});
