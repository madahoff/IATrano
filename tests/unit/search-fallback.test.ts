// Secours Brave quand SearXNG échoue ou ne renvoie rien, et signalement dans le pipeline de recherche.
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@prisma/client";
import { FallbackSearchProvider } from "@/lib/search/providers/fallback";
import { BraveProvider } from "@/lib/search/providers/brave";
import { SearxngProvider } from "@/lib/search/providers/searxng";
import { createSearchProvider, hasSearchFallback, type SearchConfig } from "@/lib/search/providers";
import { SearchError, type SearchProvider, type SearchResult } from "@/lib/search/providers/types";
import { buildDocumentsBlock } from "@/lib/search/rag-prompt";
import type { LlmProvider } from "@/lib/llm/types";

vi.mock("@/lib/search/safe-fetch", async (orig) => {
  const actual = await orig<typeof import("@/lib/search/safe-fetch")>();
  return { ...actual, safeFetch: async () => { throw new actual.FetchBlockedError("Le site a répondu 404.", "status"); } };
});
const { runResearch } = await import("@/lib/search/pipeline");

const result = (n: number, host = "ex.com"): SearchResult => ({ url: `https://${host}/article-${n}`, title: `Article ${n}`, snippet: `Le prix de l'électricité verte cette semaine atteint 0,1${n} € le kWh selon le comparatif publié par le fournisseur numéro ${n}.`, publishedAt: null });

function fake(kind: SearchProvider["kind"], label: string, impl: () => Promise<SearchResult[]>): SearchProvider & { calls: number } {
  const p = { kind, label, calls: 0, search: async () => { p.calls++; return impl(); } };
  return p;
}

const opts = { count: 5, timeoutMs: 1000 };

describe("FallbackSearchProvider", () => {
  it("utilise SearXNG quand il répond", async () => {
    const searx = fake("SEARXNG", "SearXNG", async () => [result(1)]);
    const brave = fake("BRAVE", "Brave Search", async () => [result(2)]);
    const r = await new FallbackSearchProvider(searx, brave).search("q", opts);
    expect(r).toEqual([result(1)]);
    expect(brave.calls).toBe(0);
  });

  it("bascule sur Brave quand SearXNG est injoignable, en indiquant pourquoi", async () => {
    const searx = fake("SEARXNG", "SearXNG", async () => { throw new SearchError("SearXNG refuse la connexion.", "unreachable"); });
    const brave = fake("BRAVE", "Brave Search", async () => [result(2)]);
    const r = await new FallbackSearchProvider(searx, brave).search("q", opts);
    expect(r).toEqual([{ ...result(2), via: "BRAVE", fallbackReason: "SearXNG : SearXNG refuse la connexion." }]);
  });

  it("bascule sur Brave quand SearXNG ne renvoie aucun résultat (moteurs amont bloqués)", async () => {
    const searx = fake("SEARXNG", "SearXNG", async () => []);
    const brave = fake("BRAVE", "Brave Search", async () => [result(3)]);
    const r = await new FallbackSearchProvider(searx, brave).search("q", opts);
    expect(r[0]).toMatchObject({ via: "BRAVE", fallbackReason: "SearXNG : aucun résultat" });
  });

  it("les deux moteurs en échec : erreur combinée", async () => {
    const searx = fake("SEARXNG", "SearXNG", async () => { throw new SearchError("délai dépassé", "timeout"); });
    const brave = fake("BRAVE", "Brave Search", async () => { throw new SearchError("Quota Brave Search atteint (429).", "rate_limited", "Patientez."); });
    await expect(new FallbackSearchProvider(searx, brave).search("q", opts)).rejects.toMatchObject({
      message: "SearXNG : délai dépassé ; Brave Search (secours) : Quota Brave Search atteint (429).",
      code: "rate_limited",
      hint: "Patientez.",
    });
  });

  it("une annulation ne déclenche pas le secours", async () => {
    const searx = fake("SEARXNG", "SearXNG", async () => { throw new SearchError("Recherche annulée.", "aborted"); });
    const brave = fake("BRAVE", "Brave Search", async () => [result(2)]);
    await expect(new FallbackSearchProvider(searx, brave).search("q", opts)).rejects.toMatchObject({ code: "aborted" });
    expect(brave.calls).toBe(0);
  });
});

describe("création du moteur", () => {
  const base: SearchConfig = { kind: "SEARXNG", searxngUrl: "http://100.121.17.90:8888", braveApiKey: null, fallback: true };

  it("secours actif uniquement avec SearXNG principal, basculement activé ET clé Brave", () => {
    expect(hasSearchFallback(base)).toBe(false);
    expect(hasSearchFallback({ ...base, braveApiKey: "k" })).toBe(true);
    expect(hasSearchFallback({ ...base, braveApiKey: "k", fallback: false })).toBe(false);
    expect(hasSearchFallback({ ...base, kind: "BRAVE", braveApiKey: "k" })).toBe(false);
    expect(createSearchProvider(base)).toBeInstanceOf(SearxngProvider);
    expect(createSearchProvider({ ...base, braveApiKey: "k" })).toBeInstanceOf(FallbackSearchProvider);
    expect(createSearchProvider({ ...base, kind: "BRAVE", braveApiKey: "k" })).toBeInstanceOf(BraveProvider);
  });
});

describe("pipeline avec secours", () => {
  const llm: LlmProvider = {
    kind: "OLLAMA",
    label: "Fake",
    testConnection: async () => ({ ok: true, kind: "OLLAMA", baseUrl: "http://fake", latencyMs: 1 }),
    listModels: async () => [],
    chatStream: async function* () {},
    complete: async () => "",
    completeJson: async () => '{"queries":["prix électricité verte"]}',
  };
  const settings = { searchCacheTtlSec: 0, searchTimeoutMs: 10_000, searchMaxResults: 5, searchMaxPages: 2, searchProvider: "SEARXNG" } as AppSettings;

  it("signale le basculement dans l'étape de recherche et dans les limites", async () => {
    const searx = fake("SEARXNG", "SearXNG", async () => { throw new SearchError("SearXNG refuse la connexion.", "unreachable"); });
    const brave = fake("BRAVE", "Brave Search", async () => [result(1, "a.fr"), result(2, "b.fr")]);
    const events: Array<{ type: string; step?: { id: string; detail?: string } }> = [];
    const r = await runResearch({
      question: "Prix de l'électricité verte cette semaine ?",
      context: null,
      decision: { search: true, mode: "auto", reason: "Décidé par JEV (82 %).", timeSensitive: true },
      settings,
      llm,
      model: "qwen3:32b",
      utilityThink: false,
      signal: new AbortController().signal,
      emit: (e) => events.push(e as (typeof events)[number]),
      searchProvider: new FallbackSearchProvider(searx, brave),
    });
    expect(r.status).toBe("done");
    expect(r.rag.length).toBeGreaterThan(0);
    expect(r.limitations).toContain("SearXNG : SearXNG refuse la connexion. : résultats fournis par Brave Search (secours).");
    const searchStep = events.filter((e) => e.type === "research_step" && e.step?.id === "search-0").at(-1);
    expect(searchStep?.step?.detail).toMatch(/via Brave Search \(secours\)/);
  });
});

describe("documents transmis à Qwen", () => {
  it("chaque source porte son numéro, son titre, son adresse et ses extraits", () => {
    const block = buildDocumentsBlock([{ n: 1, title: "Tarifs 2026", host: "ex.fr", url: "https://ex.fr/tarifs", publishedAt: "2026-10-01T00:00:00Z", passages: ["Le kWh coûte 0,18 €."], content: "full" }]);
    expect(block).toBe("<documents>\n[1] Tarifs 2026 (ex.fr · publié le 2026-10-01)\nAdresse : https://ex.fr/tarifs\nLe kWh coûte 0,18 €.\n</documents>");
  });
});
