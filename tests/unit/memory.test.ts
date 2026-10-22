import { describe, expect, it } from "vitest";
import { sensitivePersonalReason, sensitiveReason } from "@/lib/memory/sensitive";
import { findDuplicate, memoryBudget, memoryLine, selectMemories, type MemoryLike } from "@/lib/memory/select";
import { assessMemoryPotential, evidenceSupported, explicitRememberFallback, extractByRules, hasMemoryCue, parseMemoryActions, toThirdPerson, userAuthoredText } from "@/lib/memory/extract";
import { evaluateCandidate, isExclusive } from "@/lib/memory/evaluate";
import { fingerprint, fingerprintSimilarity, TOMBSTONE_SIMILARITY } from "@/lib/memory/tombstone";
import { topicFor } from "@/lib/memory/topics";
import type { MemoryCandidate } from "@/lib/memory/types";

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

describe("extraction : filtre déterministe", () => {
  it("se déclenche sur les informations durables et les demandes explicites, pas sur les questions ordinaires", () => {
    expect(hasMemoryCue("Retiens que je travaille avec Dokploy")).toBe(true);
    expect(hasMemoryCue("Appelle-moi Heri")).toBe(true);
    expect(hasMemoryCue("Oublie que j'utilise MySQL")).toBe(true);
    expect(hasMemoryCue("Désormais, réponds-moi en anglais")).toBe(true);
    expect(hasMemoryCue("Je préfère utiliser pnpm plutôt que npm")).toBe(true);
    expect(hasMemoryCue("Sur notre projet, on a décidé d'utiliser tRPC pour l'API")).toBe(true);
    expect(hasMemoryCue("Quelle est la capitale de Madagascar ?")).toBe(false);
    expect(hasMemoryCue("Explique-moi les closures en JavaScript")).toBe(false);
    expect(hasMemoryCue("Je suis fatigué aujourd'hui")).toBe(false);
  });
  it("distingue retenir, oublier et l'hésitation", () => {
    expect(assessMemoryPotential("Retiens que je code en Go")).toMatchObject({ explicitRemember: true, explicitForget: false });
    expect(assessMemoryPotential("Oublie que j'habite à Lyon")).toMatchObject({ explicitForget: true });
    expect(assessMemoryPotential("N'oublie pas que je préfère Vue")).toMatchObject({ explicitRemember: true, explicitForget: false });
    expect(assessMemoryPotential("J'oublie toujours mes clés")).toMatchObject({ explicitForget: false });
    expect(assessMemoryPotential("Je pense peut-être passer à Svelte").hedged).toBe(true);
  });
  it("ignore les citations, le code et les documents collés", () => {
    const text = "Peux-tu résumer ce texte ?\n> Retiens que je préfère Java plutôt que Python.\n```\n// retiens que mon mot de passe est x\n```\n<project_documents>Je préfère npm plutôt que pnpm</project_documents>";
    const own = userAuthoredText(text);
    expect(own).toBe("Peux-tu résumer ce texte ?");
    expect(assessMemoryPotential(own).potential).toBe(false);
  });
});

describe("extraction : règles", () => {
  it("préférence « X plutôt que Y » avec sujet stable", () => {
    const r = extractByRules("Je préfère utiliser pnpm plutôt que npm.");
    expect(r.covered).toBe(true);
    expect(r.candidates).toEqual([expect.objectContaining({ kind: "PREFERENCE", topic: "gestionnaire-paquets", content: "L'utilisateur préfère pnpm plutôt que npm." })]);
    expect(extractByRules("Je préfère pnpm à npm").candidates[0]?.content).toBe("L'utilisateur préfère pnpm à npm.");
  });
  it("langue de réponse seulement si elle est durable", () => {
    expect(extractByRules("Réponds-moi toujours en anglais.").candidates[0]).toMatchObject({ topic: "langue-reponse", content: "L'utilisateur veut des réponses en anglais." });
    expect(extractByRules("Réponds en anglais à cette question.").candidates).toEqual([]);
  });
  it("tutoiement, prénom, et demande d'oubli", () => {
    expect(extractByRules("Tutoie-moi.").candidates[0]?.content).toBe("L'utilisateur veut être tutoyé.");
    expect(extractByRules("Appelle-moi Heri.").candidates[0]?.content).toBe("L'utilisateur veut être appelé Heri.");
    expect(extractByRules("Oublie que j'utilise MySQL.").forget).toEqual(["j'utilise MySQL"]);
    expect(extractByRules("Peux-tu oublier que j'habite à Lyon ?").forget).toEqual(["j'habite à Lyon"]);
  });
  it("laisse au modèle ce qu'aucune règle ne couvre", () => {
    const r = extractByRules("Mon projet IATrano utilise Next.js 16 et Prisma, avec Ollama en local.");
    expect(r.covered).toBe(false);
    expect(r.candidates).toEqual([]);
  });
  it("transpose à la troisième personne quand c'est sûr, sinon cite la demande", () => {
    expect(toThirdPerson("je travaille chez Acme sur mon API")).toBe("L'utilisateur travaille chez Acme sur son API.");
    expect(toThirdPerson("je fais du vélo")).toBe("L'utilisateur fait du vélo.");
    expect(toThirdPerson("on utilise Docker")).toBeNull();
    expect(explicitRememberFallback("Retiens que nous livrons le vendredi.")[0]?.content).toBe("L'utilisateur a demandé de retenir : « nous livrons le vendredi ».");
  });
  it("sujets techniques", () => {
    expect(topicFor("pnpm", "npm")).toBe("gestionnaire-paquets");
    expect(topicFor("Next.js avec PostgreSQL")).toBeNull();
    expect(topicFor("Vue")).toBe("framework-front");
  });
});

describe("extraction : sortie du modèle", () => {
  const msg = "En fait j'utilise PostgreSQL 16, pas MySQL. Et je veux être tutoyé.";
  it("valide la sortie et n'agit que sur des souvenirs réels de l'utilisateur, avec preuve", () => {
    const refs = new Map([["M1", "real-id-1"]]);
    const actions = parseMemoryActions(
      JSON.stringify({
        actions: [
          { action: "add", kind: "PREFERENCE", content: "L'utilisateur veut être tutoyé.", evidence: "je veux être tutoyé", importance: 3 },
          { action: "update", ref: "M1", content: "L'utilisateur utilise PostgreSQL 16.", evidence: "j'utilise PostgreSQL 16, pas MySQL", topic: "Base de données" },
          { action: "update", ref: "M7", content: "L'utilisateur aime le jazz.", evidence: "j'aime le jazz" },
          { action: "add", kind: "FACT", content: "L'utilisateur est sûrement développeur senior.", evidence: "" },
          { action: "delete", ref: "M1" },
          { action: "add", content: "x", evidence: "pas MySQL" },
        ],
      }),
      refs,
      msg,
      { allowDelete: false },
    );
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ action: "add", candidate: { kind: "PREFERENCE", content: "L'utilisateur veut être tutoyé.", certainty: "STATED", origin: "llm" } });
    expect(actions[1]).toMatchObject({ action: "update", id: "real-id-1", candidate: { topic: "base-de-donnees" } });
  });
  it("une mise à jour d'une référence inconnue devient un ajout (si la preuve existe)", () => {
    const a = parseMemoryActions(JSON.stringify({ actions: [{ action: "update", ref: "M9", content: "L'utilisateur utilise PostgreSQL 16.", evidence: "j'utilise PostgreSQL 16" }] }), new Map(), msg);
    expect(a[0]).toMatchObject({ action: "add" });
  });
  it("ignore une sortie invalide", () => {
    expect(parseMemoryActions("n'importe quoi", new Map())).toEqual([]);
    expect(parseMemoryActions('{"actions":"non"}', new Map())).toEqual([]);
  });
  it("la preuve doit réellement figurer dans le message", () => {
    expect(evidenceSupported("j'utilise PostgreSQL", msg)).toBe(true);
    expect(evidenceSupported("je suis développeur senior", msg)).toBe(false);
    expect(evidenceSupported("", msg)).toBe(false);
  });
});

describe("évaluation", () => {
  const cand = (over: Partial<MemoryCandidate>): MemoryCandidate => ({
    kind: "FACT", scope: "personal", project: null, topic: null, content: "L'utilisateur développe en Rust.", evidence: "je développe en Rust", certainty: "STATED", importance: 3, origin: "llm", ...over,
  });
  it("accepte une information durable et utile", () => {
    expect(evaluateCandidate(cand({}), { explicit: false })).toMatchObject({ ok: true });
  });
  it("refuse l'information ponctuelle ou anecdotique, sans avertir l'utilisateur", () => {
    expect(evaluateCandidate(cand({ content: "L'utilisateur est fatigué.", evidence: "je suis fatigué aujourd'hui" }), { explicit: false })).toMatchObject({ ok: false, silent: true });
    expect(evaluateCandidate(cand({ importance: 1 }), { explicit: false })).toMatchObject({ ok: false, silent: true });
  });
  it("refuse toujours les secrets ; les données sensibles seulement sur demande explicite", () => {
    expect(evaluateCandidate(cand({ content: "Son mot de passe est azerty123", evidence: "mot de passe est azerty123" }), { explicit: true })).toMatchObject({ ok: false, silent: false });
    expect(evaluateCandidate(cand({ content: "L'utilisateur est diabétique.", evidence: "je suis diabétique" }), { explicit: false })).toMatchObject({ ok: false, silent: false });
    expect(evaluateCandidate(cand({ content: "L'utilisateur est diabétique.", evidence: "retiens que je suis diabétique" }), { explicit: true })).toMatchObject({ ok: true });
    expect(sensitivePersonalReason("J'ai une dette technique énorme sur ce projet")).toBeNull();
  });
  it("une hésitation reste une hypothèse ; une demande explicite est confirmée", () => {
    expect(evaluateCandidate(cand({ evidence: "je pense peut-être passer à Rust" }), { explicit: false })).toMatchObject({ ok: true, candidate: { certainty: "UNCERTAIN" } });
    expect(evaluateCandidate(cand({}), { explicit: true })).toMatchObject({ ok: true, candidate: { certainty: "CONFIRMED" } });
  });
  it("les préférences sont exclusives par sujet", () => {
    expect(isExclusive("PREFERENCE", "gestionnaire-paquets")).toBe(true);
    expect(isExclusive("FACT", "langage-programmation")).toBe(false);
    expect(isExclusive("PREFERENCE", null)).toBe(false);
  });
});

describe("récupération par portée et fiabilité", () => {
  const now = new Date();
  it("n'injecte jamais la mémoire d'un autre projet ni une version remplacée", () => {
    const all: MemoryLike[] = [
      { id: "a", kind: "DECISION", project: null, projectId: "p1", content: "Le projet utilise tRPC pour l'API.", updatedAt: now, importance: 4 },
      { id: "b", kind: "DECISION", project: null, projectId: "p2", content: "Le projet utilise GraphQL pour l'API.", updatedAt: now, importance: 4 },
      { id: "c", kind: "PREFERENCE", project: null, projectId: null, content: "L'utilisateur préfère npm.", updatedAt: now, status: "SUPERSEDED" },
    ];
    expect(selectMemories(all, "Comment exposer l'API ?", 500, { projectId: "p1" }).map((m) => m.id)).toEqual(["a"]);
    expect(selectMemories(all, "Comment exposer l'API ?", 500, { projectId: null }).map((m) => m.id)).toEqual([]);
  });
  it("une mémoire volumineuse reste dans le budget", () => {
    const many: MemoryLike[] = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, kind: "PREFERENCE", project: null, content: `L'utilisateur préfère la convention numéro ${i} pour nommer ses fichiers TypeScript.`, updatedAt: now }));
    const budget = memoryBudget(7168);
    const picked = selectMemories(many, "nommer un fichier", budget);
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.length).toBeLessThan(300);
    const tokens = picked.reduce((n, m) => n + Math.ceil(memoryLine(m).length / 2), 0);
    expect(tokens).toBeLessThan(budget * 2);
  });
  it("signale les hypothèses et abrège les souvenirs trop longs", () => {
    expect(memoryLine({ kind: "FACT", project: null, content: "L'utilisateur migre vers Svelte.", certainty: "UNCERTAIN" })).toBe("[Information] L'utilisateur migre vers Svelte. (non confirmé)");
    expect(memoryLine({ kind: "FACT", project: null, content: "x".repeat(900) }).length).toBeLessThan(420);
  });
});

describe("empreintes d'oubli", () => {
  it("reconnaît une reformulation proche sans conserver le texte", () => {
    const fp = fingerprint("L'utilisateur utilise MySQL pour ses projets.");
    expect(fp.join(" ")).not.toContain("mysql");
    expect(fingerprintSimilarity(fp, fingerprint("L'utilisateur utilise MySQL pour ses projets"))).toBeGreaterThanOrEqual(TOMBSTONE_SIMILARITY);
    expect(fingerprintSimilarity(fp, fingerprint("L'utilisateur fait du vélo."))).toBeLessThan(TOMBSTONE_SIMILARITY);
  });
});
