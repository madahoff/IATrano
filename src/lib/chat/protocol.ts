// Protocole de streaming entre /api/chat et le navigateur : une ligne JSON par événement (NDJSON).
// Partagé client/serveur — ne doit importer aucun module serveur.

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
  | { type: "notice"; code: "thinking_unsupported" | "thinking_not_returned" | "clarification_invalid" | "empty_response"; message: string }
  | { type: "done"; status: "COMPLETE" | "CANCELLED"; durationMs: number }
  | { type: "error"; code: string; message: string; hint?: string }
  | { type: "title"; conversationId: string; title: string };

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
          events.push(JSON.parse(line) as StreamEvent);
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
};

export type ConversationSummary = {
  id: string;
  title: string;
  model: string | null;
  archived: boolean;
  updatedAt: string;
  snippet?: string;
};
