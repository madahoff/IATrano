import "server-only";
import type { JevSettings } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { openSecret, sealSecret } from "@/lib/crypto/secret-box";
import { JEV_FACTORY_DEFAULTS, jevBaseUrl, type JevConnectionInput } from "./config";
import type { JevClientConfig } from "./client";

const KEY_CONTEXT = "jev-api-key";

/** Valeurs par défaut : variables JEV_* du .env, sinon valeurs d'usine. */
export function jevDefaults(): JevConnectionInput {
  const e = env();
  return {
    host: e.JEV_HOST || JEV_FACTORY_DEFAULTS.host,
    port: e.JEV_PORT,
    protocol: e.JEV_PROTOCOL === "https" ? "HTTPS" : "HTTP",
    timeoutSec: e.JEV_TIMEOUT_SEC,
    defaultThreshold: JEV_FACTORY_DEFAULTS.defaultThreshold,
  };
}

export async function getJevSettings(): Promise<JevSettings> {
  const existing = await db.jevSettings.findUnique({ where: { id: 1 } });
  if (existing) return existing;
  const d = jevDefaults();
  return db.jevSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, host: d.host, port: d.port, protocol: d.protocol, timeoutMs: Math.round(d.timeoutSec * 1000), defaultThreshold: d.defaultThreshold },
  });
}

export function sealJevKey(key: string): string {
  return sealSecret(key, env().authSecret, KEY_CONTEXT);
}

export type KeySource = "admin" | "env" | "none";

/** Clé effective : celle de l'administration (chiffrée), sinon JEV_API_KEY du .env. */
export function resolveJevKey(s: Pick<JevSettings, "apiKeyEnc">): { key: string | null; source: KeySource; unreadable: boolean } {
  if (s.apiKeyEnc) {
    const key = openSecret(s.apiKeyEnc, env().authSecret, KEY_CONTEXT);
    if (key) return { key, source: "admin", unreadable: false };
    // Chiffrée avec un autre AUTH_SECRET : on se rabat sur le .env et on le signale.
    const fallback = env().JEV_API_KEY || null;
    return { key: fallback, source: fallback ? "env" : "none", unreadable: true };
  }
  const fromEnv = env().JEV_API_KEY || null;
  return { key: fromEnv, source: fromEnv ? "env" : "none", unreadable: false };
}

export function clientConfigFrom(s: JevSettings): JevClientConfig {
  return { baseUrl: jevBaseUrl(s), apiKey: resolveJevKey(s).key, timeoutMs: s.timeoutMs };
}

// Configuration effective mise en cache quelques secondes ; invalidée à chaque enregistrement,
// ce qui applique immédiatement les changements sans redémarrer.
let cache: { at: number; settings: JevSettings } | null = null;
const CACHE_MS = 5_000;

export async function getCachedJevSettings(): Promise<JevSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.settings;
  const settings = await getJevSettings();
  cache = { at: Date.now(), settings };
  return settings;
}

export function invalidateJevSettings() {
  cache = null;
}

export function describeKey(source: KeySource, unreadable: boolean): string {
  const base = source === "admin" ? "configurée dans l'administration (masquée)" : source === "env" ? "lue depuis JEV_API_KEY du .env (masquée)" : "aucune";
  return unreadable ? `${base} — la clé enregistrée est illisible (AUTH_SECRET a changé), ressaisissez-la` : base;
}

/** Vue publique : la clé n'est jamais renvoyée, seulement sa présence et sa source. */
export function publicJevSettings(s: JevSettings) {
  const k = resolveJevKey(s);
  return {
    host: s.host,
    port: s.port,
    protocol: s.protocol,
    timeoutSec: s.timeoutMs / 1000,
    defaultThreshold: s.defaultThreshold,
    hasStoredKey: Boolean(s.apiKeyEnc),
    keySource: k.source,
    keyUnreadable: k.unreadable,
    envKeyAvailable: Boolean(env().JEV_API_KEY),
    baseUrl: jevBaseUrl(s),
    defaults: jevDefaults(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
export type PublicJevSettings = ReturnType<typeof publicJevSettings>;
