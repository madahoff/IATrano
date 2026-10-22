// Mémoire automatique contre un VRAI moteur (aucun mock du modèle). Exécutés seulement si LLM_TEST_URL est défini :
//   LLM_TEST_URL=http://100.121.17.90:11434 LLM_TEST_MODEL=qwen3:32b pnpm test:integration tests/integration/memory-real.test.ts
//   LLM_TEST_URL=http://localhost:11434 LLM_TEST_MODEL=qwen2.5:3b pnpm test:integration tests/integration/memory-real.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { OllamaProvider } from "@/lib/llm/ollama";
import { analyzeMessage } from "@/lib/memory/auto";
import { createUser, resetDb } from "../support/fixtures";

const url = process.env.LLM_TEST_URL;
const model = process.env.LLM_TEST_MODEL ?? "qwen2.5:3b";

describe.skipIf(!url)(`Mémoire automatique avec ${model}`, () => {
  const provider = new OllamaProvider({ kind: "OLLAMA", baseUrl: url ?? "", timeoutMs: 180_000 });
  let userId = "";
  let think: boolean | undefined;

  beforeEach(async () => {
    await resetDb();
    userId = (await createUser()).id;
    const info = (await provider.listModels()).find((m) => m.id === model);
    // Raisonnement coupé pour l'extraction (comme en production) quand le modèle le permet.
    think = info?.capabilities.thinking === "no" ? undefined : false;
  });

  const analyze = (text: string, projectId: string | null = null) =>
    analyzeMessage({ userId, conversationId: null, projectId, text, sourceCreatedAt: new Date(), provider, model, think }).then((u) => {
      console.info(`[${model}] « ${text.slice(0, 60)} » →`, JSON.stringify(u));
      return u;
    });
  const active = () => db.memory.findMany({ where: { userId, status: "ACTIVE" } });

  it("retient l'architecture d'un projet décrite en passant", async () => {
    await analyze("Mon projet IATrano utilise Next.js 16 avec Prisma et PostgreSQL, et on a décidé de le déployer avec Dokploy sur mon serveur local.");
    const all = await active();
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((m) => /dokploy|next|prisma|postgres/i.test(m.content))).toBe(true);
  }, 240_000);

  it("ignore une information ponctuelle", async () => {
    await analyze("Ce soir je travaille sur un bug CSS : pourquoi mon flex ne s'aligne pas verticalement ?");
    expect(await active()).toHaveLength(0);
  }, 240_000);

  it("met à jour une information contredite", async () => {
    await db.memory.create({ data: { userId, kind: "FACT", content: "L'utilisateur utilise MySQL pour ses projets.", topic: "base-de-donnees", source: "AUTO", certainty: "STATED" } });
    await analyze("Finalement je suis passé à PostgreSQL pour tous mes projets, je n'utilise plus MySQL.");
    const all = await active();
    expect(all.some((m) => /postgres/i.test(m.content))).toBe(true);
    expect(all.some((m) => /mysql/i.test(m.content) && !/postgres/i.test(m.content))).toBe(false);
  }, 240_000);

  it("refuse un secret même sur demande, sans appeler le modèle", async () => {
    const u = await analyze("Retiens que mon mot de passe est azerty123.");
    expect(u.rejected).toHaveLength(1);
    expect(await active()).toHaveLength(0);
  }, 60_000);
});
