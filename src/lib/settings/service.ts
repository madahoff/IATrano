import "server-only";
import type { AppSettings, ProviderType } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { normalizeBaseUrl } from "@/lib/llm/url";
import { isSearchConfigured, searchConfigFrom } from "@/lib/search/providers";
import type { ProviderConfig } from "@/lib/llm/types";

const DEFAULT_URLS: Record<ProviderType, string> = {
  OLLAMA: "http://localhost:11434",
  OPENAI_COMPATIBLE: "http://localhost:1234/v1",
};

/** Lit (et crée au besoin) la configuration globale. Les valeurs initiales viennent de AI_PROVIDER / AI_BASE_URL. */
export async function getAppSettings(): Promise<AppSettings> {
  const existing = await db.appSettings.findUnique({ where: { id: 1 } });
  if (existing) return existing;
  const e = env();
  const providerType: ProviderType = e.AI_PROVIDER === "openai" ? "OPENAI_COMPATIBLE" : "OLLAMA";
  const check = normalizeBaseUrl(e.AI_BASE_URL ?? DEFAULT_URLS[providerType]);
  return db.appSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      providerType,
      baseUrl: check.ok ? check.url : DEFAULT_URLS[providerType],
      apiKey: e.AI_API_KEY || null,
      searchProvider: e.SEARCH_PROVIDER === "brave" ? "BRAVE" : "SEARXNG",
    },
  });
}

export function providerConfigFrom(settings: AppSettings): ProviderConfig {
  return {
    kind: settings.providerType,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    timeoutMs: settings.requestTimeoutMs,
  };
}

export type EffectivePreferences = {
  defaultModel: string | null;
  thinkingDefault: boolean;
  clarificationsEnabled: boolean;
  /** Valeur initiale du contrôle « Recherche Web automatique » des nouvelles conversations. */
  webSearchDefault: boolean;
};

export async function getEffectivePreferences(userId: string): Promise<EffectivePreferences & { app: AppSettings }> {
  const [app, user] = await Promise.all([getAppSettings(), db.userSettings.findUnique({ where: { userId } })]);
  return {
    app,
    defaultModel: user?.defaultModel ?? app.defaultModel ?? null,
    thinkingDefault: user?.thinkingDefault ?? app.thinkingDefault,
    clarificationsEnabled: user?.clarificationsEnabled ?? app.clarificationsEnabled,
    webSearchDefault: user?.webSearchDefault ?? app.webSearchAutoDefault,
  };
}

/** Vue publique de la configuration (sans clé d'API). */
export function publicAppSettings(s: AppSettings) {
  return {
    providerType: s.providerType,
    baseUrl: s.baseUrl,
    hasApiKey: Boolean(s.apiKey),
    defaultModel: s.defaultModel,
    thinkingDefault: s.thinkingDefault,
    clarificationsEnabled: s.clarificationsEnabled,
    systemPrompt: s.systemPrompt ?? "",
    requestTimeoutMs: s.requestTimeoutMs,
    webSearchEnabled: s.webSearchEnabled,
    webSearchAutoDefault: s.webSearchAutoDefault,
    searchProvider: s.searchProvider,
    searxngUrl: s.searxngUrl ?? "",
    // Valeur d'environnement utilisée quand le champ est vide (une URL interne n'est pas un secret).
    searxngUrlFromEnv: env().SEARXNG_URL ?? null,
    hasBraveApiKey: Boolean(s.braveApiKey),
    braveApiKeyFromEnv: Boolean(env().BRAVE_SEARCH_API_KEY),
    searchConfigured: isSearchConfigured(searchConfigFrom(s)),
    searchMaxResults: s.searchMaxResults,
    searchMaxPages: s.searchMaxPages,
    searchTimeoutMs: s.searchTimeoutMs,
    searchCacheTtlSec: s.searchCacheTtlSec,
    updatedAt: s.updatedAt.toISOString(),
  };
}
export type PublicAppSettings = ReturnType<typeof publicAppSettings>;
