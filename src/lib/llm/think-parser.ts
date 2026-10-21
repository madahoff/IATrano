import { TagSplitter } from "./tag-splitter";
import type { ProviderChunk } from "./types";

/**
 * Certains serveurs (llama.cpp sans --reasoning-format, LM Studio selon la configuration, anciens Ollama)
 * renvoient le raisonnement de Qwen3/DeepSeek-R1 directement dans le contenu, entre <think> et </think>.
 * On le redirige vers le canal « thinking » : c'est bien du raisonnement produit par le modèle, pas une simulation.
 */
export function createThinkTagRouter() {
  const splitter = new TagSplitter("think");
  return {
    push(delta: string): ProviderChunk[] {
      return splitter.push(delta).map((p) => ({ type: p.inside ? "thinking" : "text", delta: p.text }) as ProviderChunk);
    },
    flush(): ProviderChunk[] {
      return splitter.flush().map((p) => ({ type: p.inside ? "thinking" : "text", delta: p.text }) as ProviderChunk);
    },
  };
}
