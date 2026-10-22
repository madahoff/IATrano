// Protocole de streaming entre /api/chat et le navigateur : une ligne JSON par événement (NDJSON).
// Partagé client/serveur — ne doit importer aucun module serveur.
import { researchEventSchema, type ResearchDTO, type ResearchEvent } from "@/lib/search/research-types";

export type Clarification = { questions: Array<{ question: string; options: string[] }> };

export type MessageStatus = "STREAMING" | "COMPLETE" | "CANCELLED" | "ERROR";

export type StreamEvent =
  | {
      type: "start";
      conversationId: string;
      userMessage: { id: string; content: string; createdAt: string } | null;
      assistantMessageId: string;
      model: string;
      thinking: boolean;
    }
  | { type: "thinking"; delta: string }
  | { type: "text"; delta: string }
  | { type: "clarification"; data: Clarification }
  | {
      type: "notice";
      code:
        | "thinking_unsupported"
        | "thinking_not_returned"
        | "clarification_invalid"
        | "empty_response"
        | "search_unavailable"
        | "citations_removed"
        | "context_truncated";
      message: string;
    }
  | ResearchEvent
  | { type: "done"; status: "COMPLETE" | "CANCELLED"; durationMs: number }
  | { type: "error"; code: string; message: string; hint?: string }
  | { type: "title"; conversationId: string; title: string }
  | ContextStreamEvent;

/** Événements de gestion du contexte et de la mémoire (voir src/lib/context, src/lib/memory). */
export type ContextStreamEvent =
  // Prompt réellement envoyé (estimation, avant génération) — alimente le compteur pendant le streaming.
  | { type: "context"; promptTokens: number; window: number; capacity: number; dropped: number; rag: number }
  // Mesure renvoyée par le fournisseur à la fin de la génération (null s'il ne la fournit pas).
  | { type: "context_measured"; promptTokens: number | null; completionTokens: number | null }
  | { type: "compaction"; status: "running" | "done" | "failed"; message?: string }
  | { type: "memory"; saved: string[]; updated: string[]; removed: number; rejected: string[] };

export function encodeEvent(event: StreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Décode un flux NDJSON en événements ; tolère les lignes coupées entre deux fragments réseau. */
export function createEventDecoder() {
  let buffer = "";
  return {
    push(chunk: string): StreamEvent[] {
      buffer += chunk;
      const events: StreamEvent[] = [];
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as StreamEvent;
          // Événements de recherche : validés par schéma (états affichés tels qu'émis par le serveur, jamais devinés).
          if (typeof ev.type === "string" && (ev.type.startsWith("research_") || ev.type === "citations")) {
            const parsed = researchEventSchema.safeParse(ev);
            if (parsed.success) events.push(parsed.data);
          } else events.push(ev);
        } catch {
          // ligne corrompue : ignorée plutôt que de casser la conversation
        }
      }
      return events;
    },
  };
}

export type ChatRequestBody = {
  action: "send" | "regenerate" | "edit";
  conversationId?: string;
  content?: string;
  messageId?: string;
  model: string;
  thinking: boolean;
  /** État du contrôle « Recherche Web » de la conversation au moment de l'envoi. */
  webSearch?: boolean;
  projectId?: string | null;
};

export type MessageDTO = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  thinking: string | null;
  thinkingEnabled: boolean;
  clarification: Clarification | null;
  model: string | null;
  status: MessageStatus;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  research: ResearchDTO | null;
};

export type ConversationSummary = {
  id: string;
  title: string;
  model: string | null;
  webSearch: boolean;
  projectId?: string | null;
  archived: boolean;
  updatedAt: string;
  snippet?: string;
};
