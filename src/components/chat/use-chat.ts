"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { readApiError } from "@/lib/client/api";
import { createEventDecoder, type ChatRequestBody, type ContextStreamEvent, type MessageDTO, type StreamEvent } from "@/lib/chat/protocol";
import type { ResearchDTO } from "@/lib/search/research-types";
import type { ArtifactRef } from "@/lib/artifacts/types";

export type Notice = { code: string; message: string };
export type UIMessage = MessageDTO & {
  notices: Notice[];
  hint?: string;
  /** Page interactive en cours de création (mode interactif). */
  artifactBuilding?: { title: string; chars: number } | null;
};

let tempSeq = 0;
const tempId = (p: string) => `temp-${p}-${Date.now()}-${tempSeq++}`;

function emptyAssistant(model: string, thinking: boolean): UIMessage {
  return {
    id: tempId("a"),
    role: "ASSISTANT",
    content: "",
    thinking: null,
    thinkingEnabled: thinking,
    clarification: null,
    model,
    status: "STREAMING",
    error: null,
    durationMs: null,
    createdAt: new Date().toISOString(),
    notices: [],
    research: null,
    routing: null,
    artifacts: [],
  };
}

/** Recherche interrompue côté client : plus aucune étape « en cours » affichée. */
function closeResearch(r: ResearchDTO | null, status: ResearchDTO["status"], detail: string): ResearchDTO | null {
  if (!r) return r;
  return {
    ...r,
    status: r.status === "running" ? status : r.status,
    steps: r.steps.map((s) => (s.status === "running" || s.status === "pending" ? { ...s, status: "failed", detail } : s)),
  };
}

type Callbacks = {
  onConversationCreated?: (id: string, title: string) => void;
  onTitle?: (id: string, title: string) => void;
  onActivity?: (id: string) => void;
  /** Contexte, compaction automatique et mémoire (compteur de contexte). */
  onContextEvent?: (event: ContextStreamEvent) => void;
  /** Fin du flux, post-traitements compris (titre, mémoire, compaction). */
  onStreamEnd?: () => void;
  /** Nouvelle page interactive enregistrée (ouverture automatique du panneau). */
  onArtifact?: (artifact: ArtifactRef, messageId: string) => void;
};

export function useChat(initial: { conversationId: string | null; messages: MessageDTO[] }, callbacks: Callbacks) {
  const [messages, setMessages] = useState<UIMessage[]>(() => initial.messages.map((m) => ({ ...m, notices: [] })));
  const [conversationId, setConversationId] = useState(initial.conversationId);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const cbRef = useRef(callbacks);
  useEffect(() => {
    cbRef.current = callbacks;
  });
  const convRef = useRef(conversationId);
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    async (body: ChatRequestBody, optimistic: (prev: UIMessage[]) => UIMessage[]): Promise<boolean> => {
      if (abortRef.current) return false;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setIsStreaming(true);

      const snapshot = messagesRef.current;
      const optimisticMessages = optimistic(snapshot);
      let assistantId = optimisticMessages.at(-1)!.id;
      messagesRef.current = optimisticMessages;
      setMessages(optimisticMessages);

      const patchAssistant = (fn: (m: UIMessage) => UIMessage) =>
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));
      const patchResearch = (fn: (r: ResearchDTO) => ResearchDTO) => patchAssistant((m) => (m.research ? { ...m, research: fn(m.research) } : m));

      // Regroupe les fragments reçus et les applique une fois par frame (fluidité sur les longues réponses).
      let pendingText = "";
      let pendingThinking = "";
      let frame: number | null = null;
      const flush = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        if (!pendingText && !pendingThinking) return;
        const t = pendingText;
        const th = pendingThinking;
        pendingText = "";
        pendingThinking = "";
        patchAssistant((m) => ({ ...m, content: m.content + t, thinking: th ? (m.thinking ?? "") + th : m.thinking }));
      };
      const schedule = () => {
        if (frame === null) frame = requestAnimationFrame(flush);
      };

      let started = false;
      let finished = false;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const err = await readApiError(res);
          // Rechargement complet volontaire : réinitialise tout l'état client lié à la session.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          if (res.status === 401) window.location.href = "/login";
          setMessages(snapshot);
          toast.error(err.message);
          return false;
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        const decoder = createEventDecoder();
        const handle = (ev: StreamEvent) => {
          switch (ev.type) {
            case "start": {
              started = true;
              const newConv = !convRef.current;
              setConversationId(ev.conversationId);
              convRef.current = ev.conversationId;
              const realId = ev.assistantMessageId;
              // L'updater peut s'exécuter plus tard : on fige l'identifiant temporaire.
              const tempAssistantId = assistantId;
              setMessages((prev) => {
                const next = prev.map((m) => {
                  if (m.id === tempAssistantId) return { ...m, id: realId, model: ev.model, thinkingEnabled: ev.thinking };
                  if (ev.userMessage && m.role === "USER" && m.id.startsWith("temp-")) {
                    return { ...m, id: ev.userMessage.id, createdAt: ev.userMessage.createdAt };
                  }
                  return m;
                });
                return next;
              });
              assistantId = realId;
              if (newConv) cbRef.current.onConversationCreated?.(ev.conversationId, body.content ?? "");
              break;
            }
            case "routing":
              patchAssistant((m) => ({ ...m, routing: ev.routing }));
              break;
            case "artifact_start":
              flush();
              patchAssistant((m) => ({ ...m, artifactBuilding: { title: ev.title, chars: 0 } }));
              break;
            case "artifact_progress":
              patchAssistant((m) => (m.artifactBuilding ? { ...m, artifactBuilding: { ...m.artifactBuilding, chars: ev.chars } } : m));
              break;
            case "artifact":
              flush();
              patchAssistant((m) => ({ ...m, content: ev.content, artifactBuilding: null, artifacts: [...m.artifacts.filter((a) => a.key !== ev.artifact.key), ev.artifact] }));
              cbRef.current.onArtifact?.(ev.artifact, assistantId);
              break;
            case "thinking":
              pendingThinking += ev.delta;
              schedule();
              break;
            case "text":
              pendingText += ev.delta;
              schedule();
              break;
            case "clarification":
              flush();
              patchAssistant((m) => ({ ...m, clarification: ev.data }));
              break;
            case "notice":
              flush();
              patchAssistant((m) => ({ ...m, notices: [...m.notices, { code: ev.code, message: ev.message }] }));
              if (ev.code === "empty_response") patchAssistant((m) => ({ ...m, status: "ERROR", error: ev.message }));
              break;
            case "done":
              flush();
              finished = true;
              patchAssistant((m) => ({
                ...m,
                status: m.status === "ERROR" ? "ERROR" : ev.status,
                durationMs: ev.durationMs,
                content: m.content.trim(),
                artifactBuilding: null,
                research: ev.status === "CANCELLED" ? closeResearch(m.research, "cancelled", "Annulé") : m.research,
              }));
              if (convRef.current) cbRef.current.onActivity?.(convRef.current);
              // Libère la saisie sans attendre l'éventuel titre automatique qui suit.
              abortRef.current = null;
              setIsStreaming(false);
              break;
            case "error":
              flush();
              finished = true;
              patchAssistant((m) => ({ ...m, status: "ERROR", error: ev.message, hint: ev.hint, research: closeResearch(m.research, "failed", "Interrompu") }));
              abortRef.current = null;
              setIsStreaming(false);
              break;
            case "title":
              cbRef.current.onTitle?.(ev.conversationId, ev.title);
              break;
            case "context":
            case "context_measured":
            case "compaction":
            case "memory":
              cbRef.current.onContextEvent?.(ev);
              break;
            // --- Recherche Web : l'interface reflète uniquement les étapes émises par le serveur.
            case "research_start":
              patchAssistant((m) => ({
                ...m,
                research: { mode: ev.mode, status: "running", queries: [], steps: [], sources: [], cited: null, limitations: [], error: null, durationMs: null },
              }));
              break;
            case "research_step":
              patchResearch((r) => {
                const i = r.steps.findIndex((s) => s.id === ev.step.id);
                const steps = i >= 0 ? r.steps.map((s, j) => (j === i ? ev.step : s)) : [...r.steps, ev.step];
                return { ...r, steps };
              });
              break;
            case "research_sources":
              patchResearch((r) => ({ ...r, sources: ev.sources }));
              break;
            case "research_end":
              patchResearch((r) => ({ ...r, status: ev.status, queries: ev.queries, limitations: ev.limitations, error: ev.error }));
              break;
            case "citations":
              flush();
              // Texte validé par le serveur (références invalides retirées) : il remplace le texte reçu en streaming.
              patchAssistant((m) => ({ ...m, content: ev.content, research: m.research ? { ...m.research, cited: ev.cited } : m.research }));
              break;
          }
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const ev of decoder.push(value)) handle(ev);
        }
        flush();
        if (!finished) {
          patchAssistant((m) => ({ ...m, status: "ERROR", error: "La réponse s'est terminée de façon inattendue.", research: closeResearch(m.research, "failed", "Interrompu") }));
        }
        return true;
      } catch {
        flush();
        if (ctrl.signal.aborted) {
          if (!started) setMessages(snapshot);
          else patchAssistant((m) => (m.status === "STREAMING" ? { ...m, status: "CANCELLED", research: closeResearch(m.research, "cancelled", "Annulé") } : m));
        } else if (!finished) {
          if (!started) {
            setMessages(snapshot);
            toast.error("Connexion au serveur impossible. Vérifiez votre réseau.");
          } else {
            // Interruption réseau : le serveur conserve la partie déjà générée.
            patchAssistant((m) => ({
              ...m,
              status: "ERROR",
              error: "Connexion interrompue pendant la génération. La partie reçue a été conservée.",
              research: closeResearch(m.research, "failed", "Connexion interrompue"),
            }));
          }
        }
        return started;
      } finally {
        if (frame !== null) cancelAnimationFrame(frame);
        if (abortRef.current === ctrl) abortRef.current = null;
        if (!abortRef.current) setIsStreaming(false);
        cbRef.current.onStreamEnd?.();
      }
    },
    [],
  );

  const send = useCallback(
    (content: string, model: string, thinking: boolean, webSearch: boolean, projectId?: string | null, routing?: ChatRequestBody["routing"], artifactKey?: string) =>
      run({ action: "send", conversationId: convRef.current ?? undefined, content, model, thinking, webSearch, projectId, routing, artifactKey }, (prev) => [
        ...prev,
        {
          id: tempId("u"),
          role: "USER",
          content,
          thinking: null,
          thinkingEnabled: false,
          clarification: null,
          model: null,
          status: "COMPLETE",
          error: null,
          durationMs: null,
          createdAt: new Date().toISOString(),
          notices: [],
          research: null,
          routing: null,
          artifacts: [],
        },
        emptyAssistant(model, thinking),
      ]),
    [run],
  );

  const regenerate = useCallback(
    (assistantMessageId: string | undefined, model: string, thinking: boolean, webSearch: boolean, projectId?: string | null, routing?: ChatRequestBody["routing"]) =>
      run({ action: "regenerate", conversationId: convRef.current ?? undefined, messageId: assistantMessageId, model, thinking, webSearch, projectId, routing }, (prev) => {
        const idx = assistantMessageId ? prev.findIndex((m) => m.id === assistantMessageId) : prev.findLastIndex((m) => m.role === "ASSISTANT");
        const kept = idx >= 0 ? prev.slice(0, idx) : prev;
        return [...kept, emptyAssistant(model, thinking)];
      }),
    [run],
  );

  const edit = useCallback(
    (userMessageId: string, content: string, model: string, thinking: boolean, webSearch: boolean, projectId?: string | null, routing?: ChatRequestBody["routing"], artifactKey?: string) =>
      run({ action: "edit", conversationId: convRef.current ?? undefined, messageId: userMessageId, content, model, thinking, webSearch, projectId, routing, artifactKey }, (prev) => {
        const idx = prev.findIndex((m) => m.id === userMessageId);
        const kept = prev.slice(0, idx + 1).map((m) => (m.id === userMessageId ? { ...m, content } : m));
        return [...kept, emptyAssistant(model, thinking)];
      }),
    [run],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  /** Identifiant de la conversation courante (lecture synchrone, à jour avant le prochain rendu). */
  const currentConversationId = useCallback(() => convRef.current, []);

  /** Remplace la carte d'un artifact (nouvelle version après correction) dans le message qui l'a produit. */
  const upsertArtifactRef = useCallback((messageId: string, ref: ArtifactRef) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, artifacts: [...m.artifacts.filter((a) => a.key !== ref.key), ref] } : m)));
  }, []);

  return { messages, conversationId, isStreaming, send, regenerate, edit, stop, currentConversationId, upsertArtifactRef };
}
