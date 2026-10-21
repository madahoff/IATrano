import { OllamaProvider } from "./ollama";
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { LlmProvider, ProviderConfig, ProviderKind } from "./types";

// Point d'extension unique : pour ajouter un fournisseur, implémenter LlmProvider et l'ajouter ici
// (ainsi qu'à l'enum ProviderType du schéma Prisma).
const FACTORIES: Record<ProviderKind, (config: ProviderConfig) => LlmProvider> = {
  OLLAMA: (c) => new OllamaProvider(c),
  OPENAI_COMPATIBLE: (c) => new OpenAICompatibleProvider(c),
};

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  OLLAMA: "Ollama",
  OPENAI_COMPATIBLE: "Compatible OpenAI (LM Studio, llama.cpp, vLLM…)",
};

const instances = new Map<string, LlmProvider>();

export function createProvider(config: ProviderConfig): LlmProvider {
  const key = `${config.kind}|${config.baseUrl}|${config.apiKey ?? ""}|${config.timeoutMs}`;
  let p = instances.get(key);
  if (!p) {
    p = FACTORIES[config.kind](config);
    instances.clear(); // une seule configuration active à la fois ; libère les caches précédents
    instances.set(key, p);
  }
  return p;
}

/** Instance éphémère, non mise en cache (tests de connexion et détection automatique). */
export function buildProvider(config: ProviderConfig): LlmProvider {
  return FACTORIES[config.kind](config);
}
