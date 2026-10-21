// Contrat commun à tous les fournisseurs de LLM.
// Ajouter un fournisseur = implémenter LlmProvider et l'enregistrer dans registry.ts.

export type ProviderKind = "OLLAMA" | "OPENAI_COMPATIBLE";

/** "yes" : déclaré par le fournisseur ; "no" : explicitement absent ; "unknown" : non vérifiable. */
export type Capability = "yes" | "no" | "unknown";

export type ModelInfo = {
  id: string;
  name: string;
  provider: ProviderKind;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  sizeBytes?: number;
  contextLength?: number;
  capabilities: {
    thinking: Capability;
    tools: Capability;
    vision: Capability;
  };
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ProviderConfig = {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string | null;
  timeoutMs: number;
};

export type GenerateRequest = {
  model: string;
  messages: ChatMessage[];
  /** true/false : demander/désactiver explicitement le raisonnement. undefined : ne rien envoyer. */
  think?: boolean;
  temperature?: number;
  signal?: AbortSignal;
};

/** Fragments bruts émis par un fournisseur pendant le streaming. */
export type ProviderChunk =
  | { type: "thinking"; delta: string }
  | { type: "text"; delta: string }
  | { type: "done"; reason?: string; evalCount?: number };

export type ConnectionTest = {
  ok: boolean;
  kind: ProviderKind;
  baseUrl: string;
  version?: string;
  latencyMs: number;
  modelCount?: number;
  error?: string;
  hint?: string;
};

export interface LlmProvider {
  readonly kind: ProviderKind;
  readonly label: string;
  testConnection(): Promise<ConnectionTest>;
  listModels(): Promise<ModelInfo[]>;
  chatStream(req: GenerateRequest): AsyncGenerator<ProviderChunk>;
  /** Génération courte non streamée (titres). */
  complete(req: GenerateRequest): Promise<string>;
  /** Génération contrainte par un schéma JSON (sorties structurées), renvoie le texte JSON brut. */
  completeJson(req: GenerateRequest, schema: Record<string, unknown>): Promise<string>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "unreachable"
      | "timeout"
      | "model_not_found"
      | "thinking_unsupported"
      | "bad_response"
      | "http_error"
      | "aborted",
    public readonly hint?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
