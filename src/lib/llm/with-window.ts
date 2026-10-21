import type { GenerateRequest, LlmProvider } from "./types";

/**
 * Applique la même fenêtre de contexte (num_ctx) à tous les appels d'une génération : réponse, recherche Web,
 * titre, questions de précision, mémoire. Avec Ollama, une taille différente d'un appel à l'autre forcerait
 * le rechargement complet du modèle.
 */
export function withContextWindow(provider: LlmProvider, numCtx: number | undefined): LlmProvider {
  if (!numCtx) return provider;
  const fill = (req: GenerateRequest): GenerateRequest => (req.numCtx ? req : { ...req, numCtx });
  return {
    kind: provider.kind,
    label: provider.label,
    testConnection: () => provider.testConnection(),
    listModels: () => provider.listModels(),
    chatStream: (req) => provider.chatStream(fill(req)),
    complete: (req) => provider.complete(fill(req)),
    completeJson: (req, schema) => provider.completeJson(fill(req), schema),
  };
}
