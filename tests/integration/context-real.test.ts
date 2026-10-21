// Contexte et mémoire contre un VRAI moteur Ollama (aucun mock). Exécutés seulement si LLM_TEST_URL est défini :
//   LLM_TEST_URL=http://localhost:11434 LLM_TEST_MODEL=qwen2.5:3b pnpm test:integration tests/integration/context-real.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { OllamaProvider } from "@/lib/llm/ollama";
import { countMessagesTokens } from "@/lib/llm/tokens";
import type { ChatMessage } from "@/lib/llm/types";
import { compactConversation } from "@/lib/context/compact";
import { buildActiveContext } from "@/lib/context/service";
import type { SummarySections } from "@/lib/context/types";
import { autoUpdateMemories } from "@/lib/memory/auto";
import { createUser, resetDb } from "../support/fixtures";

const url = process.env.LLM_TEST_URL;
const model = process.env.LLM_TEST_MODEL ?? "qwen2.5:3b";

const TRANSCRIPT: Array<[string, string]> = [
  [
    "Je déploie mon application Next.js 16 avec PostgreSQL sur Dokploy, sur mon serveur local, sans aucun service cloud. Propose une architecture.",
    "Architecture proposée : un conteneur pour l'application Next.js (sortie standalone), un conteneur PostgreSQL 16 séparé, un réseau Docker interne. Dokploy gère le reverse proxy et les certificats.",
  ],
  [
    "On part sur PostgreSQL 16 avec un volume nommé pgdata. Écris le compose.yaml.",
    "Voici le fichier compose.yaml :\n```yaml\nservices:\n  db:\n    image: postgres:16-alpine\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n  app:\n    build: .\n    depends_on:\n      - db\nvolumes:\n  pgdata:\n```",
  ],
  [
    "Ajoute un healthcheck sur la base et fais dépendre l'application de ce healthcheck.",
    "Ajoutez au service db : healthcheck avec la commande pg_isready -U iatrano, intervalle 5 s. Dans app, remplacez depends_on par db: condition: service_healthy.",
  ],
  [
    "Comment exécuter les migrations Prisma au démarrage, sans migrate dev ?",
    "Utilisez la commande prisma migrate deploy dans le script de démarrage du conteneur, avant node server.js. migrate dev est réservé au développement : il peut réinitialiser la base.",
  ],
  [
    "Le build échoue : Prisma Client could not locate the Query Engine for runtime linux-musl-openssl-3.0.x.",
    "Ajoutez binaryTargets = [\"native\", \"linux-musl-openssl-3.0.x\"] dans le generator client de prisma/schema.prisma, puis relancez prisma generate et le build.",
  ],
  ["Merci, ça fonctionne. Prochaine étape : les sauvegardes de la base.", "Pour les sauvegardes, planifiez pg_dump chaque nuit vers un dossier monté, avec une rotation de 7 jours."],
  ["Et pour restaurer ?", "Restaurez avec psql ou pg_restore selon le format du dump, sur une base vide, application arrêtée."],
];

describe.skipIf(!url)(`Contexte avec un vrai moteur (${url ?? "non configuré"})`, () => {
  let userId = "";
  beforeAll(async () => {
    await resetDb();
    await db.appSettings.upsert({ where: { id: 1 }, update: { providerType: "OLLAMA", baseUrl: url! }, create: { id: 1, providerType: "OLLAMA", baseUrl: url! } });
    userId = (await createUser()).id;
  });

  it("l'estimation du prompt correspond au comptage réel du moteur (écart < 5 %)", async () => {
    const provider = new OllamaProvider({ kind: "OLLAMA", baseUrl: url!, timeoutMs: 120_000 });
    const messages: ChatMessage[] = [{ role: "system", content: "Tu es un assistant technique. Réponds en français." }];
    for (const [q, a] of TRANSCRIPT) messages.push({ role: "user", content: q }, { role: "assistant", content: a });
    messages.push({ role: "user", content: "Résume en une phrase." });
    let measured = 0;
    for await (const c of provider.chatStream({ model, messages, numCtx: 8192, temperature: 0 })) if (c.type === "done") measured = c.promptTokens ?? 0;
    const estimated = countMessagesTokens(messages);
    console.info(`prompt : estimé ${estimated}, mesuré par Ollama ${measured}`);
    expect(measured).toBeGreaterThan(0);
    expect(Math.abs(estimated - measured) / measured).toBeLessThan(0.05);
  });

  it("compacte une vraie conversation : résumé validé, faits techniques conservés, contexte réduit, historique intact", async () => {
    const conv = await db.conversation.create({ data: { userId, title: "Déploiement", model } });
    const t0 = Date.now() - 1_000_000;
    let i = 0;
    for (const [q, a] of TRANSCRIPT) {
      await db.message.create({ data: { conversationId: conv.id, role: "USER", content: q, createdAt: new Date(t0 + i++ * 1000) } });
      const details = "\n\nPoints d'attention : vérifiez les journaux du conteneur avec docker compose logs, gardez les secrets dans les variables d'environnement de Dokploy, et testez chaque étape sur une copie de la base avant la production. ".repeat(3);
      await db.message.create({ data: { conversationId: conv.id, role: "ASSISTANT", content: a + details, createdAt: new Date(t0 + i++ * 1000) } });
    }
    const result = await compactConversation({ userId, conversationId: conv.id, modelId: model, trigger: "manual" });
    expect(result.status).toBe("compacted");
    const summary = await db.contextSummary.findFirstOrThrow({ where: { conversationId: conv.id, status: "ACTIVE" } });
    const s = summary.content as unknown as SummarySections;
    console.info(`tokens ${summary.tokensBefore} → ${summary.tokensAfter}\n${summary.text}`);
    expect(s.objective.length).toBeGreaterThan(8);
    expect(summary.tokensAfter!).toBeLessThan(summary.tokensBefore!);
    // Le bloc compose.yaml (court) est conservé tel quel, et le fichier est référencé.
    expect(summary.text).toContain("pgdata:/var/lib/postgresql/data");
    expect(s.references.some((r) => r.type === "file" && r.label === "compose.yaml")).toBe(true);
    // Les échanges récents (dont la correction de prisma/schema.prisma) restent transmis tels quels.
    expect(summary.coveredCount).toBeLessThan(TRANSCRIPT.length * 2);
    expect(await db.message.count({ where: { conversationId: conv.id } })).toBe(TRANSCRIPT.length * 2);

    const history = await db.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } });
    const ctx = await buildActiveContext({ userId, conversation: conv, history, modelId: model, query: "Et pour restaurer ?" });
    expect(ctx.assembled.messages[0].content).toContain("RÉSUMÉ DES ÉCHANGES PRÉCÉDENTS");
    expect(ctx.summarized).toBeGreaterThan(0);
  }, 300_000);

  it("enregistre une mémoire explicite et ignore le secret", async () => {
    const provider = new OllamaProvider({ kind: "OLLAMA", baseUrl: url!, timeoutMs: 120_000 });
    const update = await autoUpdateMemories({
      userId,
      conversationId: "conv-test",
      userMessage: "Retiens que je déploie toujours mes applications avec Dokploy sur mon serveur local.",
      answer: "C'est noté.",
      provider,
      model,
      think: undefined,
    });
    console.info("mémoire :", JSON.stringify(update));
    const memories = await db.memory.findMany({ where: { userId } });
    expect(memories.some((m) => /dokploy/i.test(m.content))).toBe(true);
    const secret = await autoUpdateMemories({ userId, conversationId: "conv-test", userMessage: "Mon mot de passe est azerty123, retiens-le.", answer: "", provider, model, think: undefined });
    expect(secret?.rejected.length).toBe(1);
    expect(await db.memory.count({ where: { userId, content: { contains: "azerty" } } })).toBe(0);
  }, 120_000);
});
