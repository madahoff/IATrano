import { describe, expect, it } from "vitest";
import { countMessagesTokens, countTextTokens, MESSAGE_OVERHEAD_TOKENS, REPLY_PRIMER_TOKENS } from "@/lib/llm/tokens";
import { resolveWindow } from "@/lib/context/window";
import { contextState } from "@/lib/context/types";
import { assembleContext, finalizeContext, MEMORY_HEADER, SUMMARY_HEADER } from "@/lib/context/assemble";
import { splitForCompaction } from "@/lib/context/policy";
import { compactCodeBlocks, extractReferences, mergeRequests, renderSummary, userRequests, validateSummary, EMPTY_SECTIONS } from "@/lib/context/summary";
import { createEventDecoder, encodeEvent } from "@/lib/chat/protocol";
import { withContextWindow } from "@/lib/llm/with-window";
import type { GenerateRequest, LlmProvider } from "@/lib/llm/types";

const long = (n: number) => Array.from({ length: n }, (_, i) => `mot${i % 50} phrase de test numéro`).join(" ");

describe("comptage des tokens", () => {
  it("ajoute les marqueurs de gabarit par message et l'amorce de réponse", () => {
    const msgs = [{ content: "Bonjour" }, { content: "Salut" }];
    expect(countMessagesTokens(msgs)).toBe(countTextTokens("Bonjour") + countTextTokens("Salut") + 2 * MESSAGE_OVERHEAD_TOKENS + REPLY_PRIMER_TOKENS);
  });
  it("compte les nombres chiffre par chiffre (tokenizer Qwen)", () => {
    expect(countTextTokens("1234567")).toBe(7);
  });
  it("reproduit le comptage d'Ollama pour qwen2.5:3b sur du texte français (mesuré : 30 tokens de contenu)", () => {
    expect(countTextTokens("Bonjour, comment ça va aujourd'hui ? Je voudrais comprendre le fonctionnement de la mémoire contextuelle d'un modèle de langage.")).toBe(30);
  });
  it("ne plante pas sur des marqueurs spéciaux présents dans le texte", () => {
    expect(countTextTokens("<|endoftext|> <|im_start|>")).toBeGreaterThan(0);
  });
});

describe("fenêtre effective", () => {
  const base = { appDefaultWindow: 8192, appReserve: 1024 };
  it("Ollama : fenêtre par défaut imposée (num_ctx), plafonnée au maximum du modèle", () => {
    const w = resolveWindow({ ...base, providerKind: "OLLAMA", providerMax: 32768, override: null });
    expect(w).toMatchObject({ window: 8192, reserve: 1024, capacity: 7168, source: "app-default", numCtx: 8192 });
    expect(resolveWindow({ ...base, providerKind: "OLLAMA", providerMax: 4096, override: null }).window).toBe(4096);
  });
  it("réglage manuel prioritaire, avec sa propre réserve", () => {
    const w = resolveWindow({ ...base, providerKind: "OLLAMA", providerMax: 32768, override: { contextWindow: 16384, responseReserve: 2048 } });
    expect(w).toMatchObject({ window: 16384, reserve: 2048, capacity: 14336, source: "manual", numCtx: 16384 });
  });
  it("compatible OpenAI : fenêtre annoncée, sinon supposée ; jamais de num_ctx envoyé", () => {
    expect(resolveWindow({ ...base, providerKind: "OPENAI_COMPATIBLE", providerMax: 32000, override: null })).toMatchObject({ window: 32000, source: "provider", numCtx: undefined });
    expect(resolveWindow({ ...base, providerKind: "OPENAI_COMPATIBLE", providerMax: undefined, override: null })).toMatchObject({ window: 8192, source: "assumed" });
  });
  it("la réserve ne dépasse jamais la moitié de la fenêtre", () => {
    expect(resolveWindow({ appDefaultWindow: 2048, appReserve: 4000, providerKind: "OLLAMA", providerMax: null, override: null }).reserve).toBe(1024);
  });
});

describe("seuils", () => {
  const t = { warn: 70, high: 85, autoCompact: 90 };
  it("classe la consommation", () => {
    expect(contextState(10, t)).toBe("normal");
    expect(contextState(70, t)).toBe("warn");
    expect(contextState(85.5, t)).toBe("high");
    expect(contextState(100, t)).toBe("critical");
  });
});

describe("assemblage du contexte actif", () => {
  const history = [
    { role: "USER" as const, content: "Première question" },
    { role: "ASSISTANT" as const, content: "Première réponse" },
    { role: "USER" as const, content: "Deuxième question" },
  ];

  it("injecte mémoire et résumé dans le system, et la somme des parties égale le total réel", () => {
    const a = assembleContext({ clarifications: false, history, capacity: 10_000, memoryLines: ["[Préférence] Répondre en français"], summaryText: "Objectif : tester" });
    expect(a.messages[0].content).toContain(MEMORY_HEADER);
    expect(a.messages[0].content).toContain(SUMMARY_HEADER);
    expect(a.messages).toHaveLength(4);
    const sum = Object.values(a.parts).reduce((x, y) => x + y, 0);
    expect(sum).toBe(a.total);
    expect(a.total).toBe(countMessagesTokens(a.messages));
    expect(a.parts.memory).toBeGreaterThan(0);
    expect(a.parts.summary).toBeGreaterThan(0);
  });

  it("écarte les plus anciens tours quand la capacité est dépassée, garde le dernier, commence par l'utilisateur", () => {
    const big = [
      { role: "USER" as const, content: long(200) },
      { role: "ASSISTANT" as const, content: long(200) },
      { role: "USER" as const, content: "Question finale" },
    ];
    const a = assembleContext({ clarifications: false, history: big, capacity: 800 });
    expect(a.droppedMessages).toBe(2);
    expect(a.messages.at(-1)?.content).toBe("Question finale");
    expect(a.messages[1].role).toBe("user");
    expect(a.total).toBeLessThanOrEqual(800);
  });

  it("ne transmet pas le Thinking (seul le contenu des réponses est envoyé)", () => {
    const a = assembleContext({ clarifications: false, history: [{ role: "USER", content: "q" }, { role: "ASSISTANT", content: "réponse" }, { role: "USER", content: "q2" }], capacity: 5000 });
    expect(a.messages.map((m) => m.content).join()).not.toContain("<think>");
  });

  it("finalize : attribue l'ajout des documents Web à la part RAG et recompte le prompt", () => {
    const a = assembleContext({ clarifications: false, history, capacity: 10_000 });
    const msgs = [...a.messages];
    msgs[msgs.length - 1] = { role: "user", content: `<documents>${long(100)}</documents>\nDeuxième question` };
    const f = finalizeContext(msgs, a, 10_000);
    expect(f.parts.rag).toBe(countMessagesTokens(msgs) - a.total);
    expect(f.total).toBe(countMessagesTokens(msgs));
  });

  it("finalize : en cas de débordement, retire des tours anciens mais jamais le system ni le dernier message", () => {
    const a = assembleContext({ clarifications: false, history, capacity: 10_000 });
    const msgs = [...a.messages];
    msgs[msgs.length - 1] = { role: "user", content: long(150) };
    const f = finalizeContext(msgs, a, countTextTokens(long(150)) + a.parts.system + 20);
    expect(f.messages[0].role).toBe("system");
    expect(f.messages.at(-1)?.content).toBe(long(150));
    expect(f.droppedMessages).toBeGreaterThan(0);
  });
});

describe("découpage pour la compaction", () => {
  const msgs = Array.from({ length: 12 }, (_, i) => ({ role: (i % 2 === 0 ? "USER" : "ASSISTANT") as "USER" | "ASSISTANT", content: `message ${i} ${long(20)}` }));
  it("garde les derniers échanges intacts et résume ce qui précède jusqu'à une réponse", () => {
    const { toSummarize, keep } = splitForCompaction(msgs, 100_000);
    expect(keep.length).toBeGreaterThanOrEqual(2);
    expect(keep.length).toBeLessThanOrEqual(7);
    expect(toSummarize.at(-1)?.role).toBe("ASSISTANT");
    expect(toSummarize.length + keep.length).toBe(12);
  });
  it("rien à compacter pour une conversation courte ou trop peu volumineuse", () => {
    expect(splitForCompaction(msgs.slice(0, 2), 100_000).toSummarize).toHaveLength(0);
    const tiny = msgs.map((m) => ({ ...m, content: "ok" }));
    expect(splitForCompaction(tiny, 100_000).toSummarize).toHaveLength(0);
  });
});

describe("validation du résumé", () => {
  const ok = JSON.stringify({
    objective: "Configurer le déploiement Dokploy de IATrano",
    constraints: ["Tout en français"],
    decisions: ["Utiliser PostgreSQL 16"],
    facts: ["Ollama écoute sur 127.0.0.1:11434"],
    state: ["Migration créée"],
    nextSteps: ["Tester le build Docker"],
  });
  it("accepte un résumé structuré correct", () => {
    const v = validateSummary(ok, { sourceTokens: 2000, previous: null });
    expect(v.ok).toBe(true);
  });
  it("rejette le JSON invalide, le résumé vide, sans objectif ou qui recopie les consignes", () => {
    expect(validateSummary("pas du json", { sourceTokens: 500, previous: null }).ok).toBe(false);
    expect(validateSummary(JSON.stringify({ objective: "Objectif clair ici", constraints: [], decisions: [], facts: [], state: [], nextSteps: [] }), { sourceTokens: 500, previous: null }).ok).toBe(false);
    expect(validateSummary(JSON.stringify({ objective: "", constraints: ["a b c"], decisions: [], facts: [], state: [], nextSteps: [] }), { sourceTokens: 500, previous: null }).ok).toBe(false);
    expect(validateSummary(JSON.stringify({ objective: "Produis le JSON avec objective", constraints: ["x y z"], decisions: [], facts: [], state: [], nextSteps: [] }), { sourceTokens: 500, previous: null }).ok).toBe(false);
  });
  it("rejette un résumé plus long que les échanges d'origine", () => {
    const item = (k: string) => Array.from({ length: 60 }, (_, i) => `${k}${i}`).join(" ");
    const big = { objective: item("o"), constraints: [item("c")], decisions: [item("d")], facts: [item("f")], state: [item("s")], nextSteps: [item("n")] };
    expect(validateSummary(JSON.stringify(big), { sourceTokens: 320, previous: null }).ok).toBe(false);
  });
  it("supprime les répétitions d'une section à l'autre", () => {
    const v = validateSummary(
      JSON.stringify({ objective: "Déployer l'application", constraints: [], decisions: ["Utiliser PostgreSQL 16 avec le volume pgdata"], facts: ["Utiliser PostgreSQL 16 avec le volume pgdata."], state: ["Fichier compose écrit"], nextSteps: [] }),
      { sourceTokens: 2000, previous: null },
    );
    expect(v.ok && v.sections.facts).toEqual([]);
  });
  it("réintègre les décisions et faits anciens oubliés par le modèle", () => {
    const previous = { ...EMPTY_SECTIONS, objective: "Projet X", decisions: ["Choix de la base PostgreSQL"], facts: ["Le port 5442 est utilisé"] };
    const v = validateSummary(ok, { sourceTokens: 2000, previous });
    expect(v.ok && v.sections.decisions).toContain("Choix de la base PostgreSQL");
    expect(v.ok && v.sections.facts).toContain("Le port 5442 est utilisé");
  });
});

describe("ancrage de l'objectif", () => {
  it("remplace un objectif sans rapport avec la première demande", () => {
    const raw = JSON.stringify({ objective: "Corriger une erreur OpenSSL de Prisma", constraints: [], decisions: ["Ajouter binaryTargets linux-musl-openssl-3.0.x dans le generator du schéma Prisma"], facts: ["Le build Docker utilise une image Alpine"], state: [], nextSteps: [] });
    const v = validateSummary(raw, { sourceTokens: 2000, previous: null, firstRequest: "Je déploie mon application Next.js sur Dokploy sans cloud." });
    expect(v.ok && v.sections.objective).toBe("Demande initiale : Je déploie mon application Next.js sur Dokploy sans cloud.");
    const good = JSON.stringify({ objective: "Déployer l'application Next.js sur Dokploy", constraints: [], decisions: ["Utiliser PostgreSQL 16 dans un conteneur séparé avec le volume pgdata"], facts: [], state: [], nextSteps: [] });
    expect(validateSummary(good, { sourceTokens: 2000, previous: null, firstRequest: "Je déploie mon application Next.js sur Dokploy sans cloud." }).ok).toBe(true);
  });
});

describe("références techniques conservées", () => {
  const now = new Date("2026-10-21T10:00:00Z");
  it("conserve sources, URL, fichiers et blocs de code (courts en entier, longs par référence)", () => {
    const longCode = Array.from({ length: 30 }, (_, i) => `ligne ${i}`).join("\n");
    const refs = extractReferences(
      [
        { id: "m1", role: "USER", content: "Voir https://docs.dokploy.com/install, pas https://your-api-url.com/v1, et le fichier src/lib/env.ts", createdAt: now },
        { id: "m2", role: "ASSISTANT", content: "```bash\npnpm db:deploy\n```\n\n```ts\n" + longCode + "\n```", createdAt: now },
      ],
      [{ title: "Doc Prisma", url: "https://www.prisma.io/docs" }],
    );
    expect(refs).toContainEqual({ type: "source", label: "Doc Prisma", url: "https://www.prisma.io/docs" });
    expect(refs).toContainEqual({ type: "url", label: "https://docs.dokploy.com/install", url: "https://docs.dokploy.com/install" });
    expect(JSON.stringify(refs)).not.toContain("your-api-url");
    expect(refs).toContainEqual({ type: "file", label: "src/lib/env.ts" });
    const codes = refs.filter((r) => r.type === "code");
    expect(codes).toHaveLength(2);
    expect(codes[0]).toMatchObject({ code: "pnpm db:deploy", lang: "bash" });
    expect(codes[1]).toMatchObject({ code: null, lang: "ts", messageId: "m2" });
    const text = renderSummary({ ...EMPTY_SECTIONS, objective: "o", references: refs });
    expect(text).toContain("https://www.prisma.io/docs");
    expect(text).toContain("pnpm db:deploy");
  });
  it("remplace les longs blocs de code par une référence dans la transcription", () => {
    const out = compactCodeBlocks("Avant\n```py\n" + Array.from({ length: 20 }, (_, i) => `x${i} = ${i}`).join("\n") + "\n```");
    expect(out).toContain("bloc de code py de 20 lignes");
  });
});

describe("demandes de l'utilisateur conservées sans passer par le modèle", () => {
  const now = new Date();
  it("cite les messages de l'utilisateur (condensés) et ignore ceux de l'assistant", () => {
    const req = userRequests([
      { id: "1", role: "USER", content: "On part sur PostgreSQL 16 avec un volume nommé pgdata.", createdAt: now },
      { id: "2", role: "ASSISTANT", content: "D'accord.", createdAt: now },
      { id: "3", role: "USER", content: "x".repeat(500), createdAt: now },
    ]);
    expect(req[0]).toBe("On part sur PostgreSQL 16 avec un volume nommé pgdata.");
    expect(req).toHaveLength(2);
    expect(req[1].length).toBeLessThanOrEqual(280);
    expect(renderSummary({ ...EMPTY_SECTIONS, objective: "o", requests: req, references: [] })).toContain("« On part sur PostgreSQL 16 avec un volume nommé pgdata. »");
  });
  it("fusion bornée : garde la première demande et les plus récentes", () => {
    const many = Array.from({ length: 40 }, (_, i) => `Demande ${i} ${long(4)}`);
    const merged = mergeRequests(many.slice(0, 20), many.slice(20));
    expect(merged[0]).toBe(many[0]);
    expect(merged.at(-1)).toBe(many[39]);
    expect(merged.length).toBeLessThan(40);
  });
});

describe("protocole et fenêtre partagée", () => {
  it("transmet les événements de contexte au navigateur", () => {
    const d = createEventDecoder();
    const evs = d.push(encodeEvent({ type: "context", promptTokens: 120, window: 8192, capacity: 7168, dropped: 0, rag: 40 }) + encodeEvent({ type: "compaction", status: "done" }));
    expect(evs.map((e) => e.type)).toEqual(["context", "compaction"]);
  });
  it("applique le même num_ctx à tous les appels d'une génération", async () => {
    const seen: GenerateRequest[] = [];
    const p: LlmProvider = {
      kind: "OLLAMA",
      label: "f",
      testConnection: async () => ({ ok: true, kind: "OLLAMA", baseUrl: "", latencyMs: 0 }),
      listModels: async () => [],
      chatStream: async function* (req) {
        seen.push(req);
      },
      complete: async (req) => (seen.push(req), ""),
      completeJson: async (req) => (seen.push(req), "{}"),
    };
    const w = withContextWindow(p, 8192);
    await w.complete({ model: "m", messages: [] });
    await w.completeJson({ model: "m", messages: [] }, {});
    for await (const _ of w.chatStream({ model: "m", messages: [] })) void _;
    expect(seen.map((r) => r.numCtx)).toEqual([8192, 8192, 8192]);
  });
});
