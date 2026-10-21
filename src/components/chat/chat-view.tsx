"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Menu, PanelLeftOpen, SquarePen } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp } from "@/components/layout/app-context";
import { useShell } from "@/components/layout/chat-shell";
import { Logo } from "@/components/common/logo";
import { api } from "@/lib/client/api";
import type { MessageDTO } from "@/lib/chat/protocol";
import { fallbackTitle } from "@/lib/llm/prompt";
import { AssistantMessage, UserMessage } from "./message-item";
import { ClarificationCard } from "./clarification-card";
import { Composer, type ComposerHandle } from "./composer";
import { ModelSelector } from "./model-selector";
import { useChat } from "./use-chat";

type InitialConversation = { id: string; title: string; model: string | null; messages: MessageDTO[] } | null;

export function ChatView({ conversation }: { conversation: InitialConversation }) {
  const { models, upsertConversation, startNewChat } = useApp();
  const { openMobileNav, desktopCollapsed, toggleDesktop } = useShell();
  const router = useRouter();
  const composerRef = useRef<ComposerHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

  const chat = useChat(
    { conversationId: conversation?.id ?? null, messages: conversation?.messages ?? [] },
    {
      onConversationCreated: (id, content) => {
        upsertConversation({ id, title: fallbackTitle(content), updatedAt: new Date().toISOString() });
        // Change l'URL sans recharger la vue : le flux en cours continue.
        window.history.replaceState(null, "", `/c/${id}`);
      },
      onTitle: (id, title) => upsertConversation({ id, title }),
      onActivity: (id) => upsertConversation({ id, updatedAt: new Date().toISOString() }),
    },
  );

  // --- Modèle actif : celui de la conversation, sinon le défaut effectif, sinon le premier détecté.
  const [selectedModel, setModel] = useState<string | null>(conversation?.model ?? null);
  const model = useMemo(() => {
    if (selectedModel) return selectedModel;
    if (!models?.provider.reachable || models.models.length === 0) return null;
    const preferred = [models.defaultModel, models.appDefaultModel].find((id) => id && models.models.some((m) => m.id === id));
    return preferred ?? models.models[0].id;
  }, [selectedModel, models]);
  const modelInfo = models?.models.find((m) => m.id === model) ?? null;

  // --- Thinking : valeur par défaut des préférences, puis contrôlé par l'utilisateur.
  const [thinkingTouched, setThinkingTouched] = useState(false);
  const [thinkingPref, setThinkingPref] = useState(false);
  const thinking = thinkingTouched ? thinkingPref : (models?.thinkingDefault ?? false);
  const thinkingCapability = modelInfo ? modelInfo.capabilities.thinking : null;
  const thinkingActive = thinking && thinkingCapability !== "no" && thinkingCapability !== null;

  const changeModel = useCallback(
    (id: string) => {
      setModel(id);
      if (chat.conversationId) {
        void api(`/api/conversations/${chat.conversationId}`, { method: "PATCH", json: { model: id } }).catch(() => {});
      }
    },
    [chat.conversationId],
  );

  let blockedReason: string | null = null;
  if (models && !models.provider.reachable) blockedReason = "Le serveur IA est injoignable : la génération est impossible pour le moment.";
  else if (models && models.models.length === 0) blockedReason = "Aucun modèle n'est disponible sur le serveur IA.";
  else if (models && model && !modelInfo) blockedReason = `Le modèle « ${model} » n'est pas disponible. Choisissez-en un autre.`;
  else if (!model) blockedReason = models ? "Sélectionnez un modèle." : null;

  const ensureReady = () => {
    if (blockedReason || !model) {
      toast.error(blockedReason ?? "Sélectionnez un modèle.");
      return false;
    }
    return true;
  };

  const send = useCallback(
    (text: string) => {
      if (!ensureReady()) return;
      setStick(true);
      void chat.send(text, model!, thinkingActive);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chat.send, model, thinkingActive, blockedReason],
  );
  const regenerate = useCallback(
    (id: string) => {
      if (!ensureReady()) return;
      setStick(true);
      void chat.regenerate(id, model!, thinkingActive);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chat.regenerate, model, thinkingActive, blockedReason],
  );
  const edit = useCallback(
    (id: string, content: string) => {
      if (!ensureReady()) return;
      setStick(true);
      void chat.edit(id, content, model!, thinkingActive);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chat.edit, model, thinkingActive, blockedReason],
  );

  // --- Défilement : reste collé en bas tant que l'utilisateur n'est pas remonté.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [chat.messages, stick]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  useEffect(() => {
    if (!conversation) composerRef.current?.focus();
  }, [conversation]);

  const lastIndex = chat.messages.length - 1;
  const last = chat.messages[lastIndex];
  const empty = chat.messages.length === 0;

  const items = useMemo(
    () =>
      chat.messages.map((m, i) =>
        m.role === "USER" ? (
          <UserMessage key={m.id} message={m} canEdit={!chat.isStreaming} onEdit={edit} />
        ) : (
          <AssistantMessage key={m.id} message={m} isLast={i === lastIndex} busy={chat.isStreaming} onRegenerate={regenerate}>
            {i === lastIndex && m.clarification && m.status === "COMPLETE" && (
              <ClarificationCard
                clarification={m.clarification}
                disabled={chat.isStreaming}
                onAnswer={send}
                onFreeAnswer={() => composerRef.current?.focus()}
              />
            )}
          </AssistantMessage>
        ),
      ),
    [chat.messages, chat.isStreaming, lastIndex, edit, regenerate, send],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 px-2 md:px-3">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={openMobileNav} aria-label="Ouvrir le menu">
          <Menu />
        </Button>
        {desktopCollapsed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="hidden md:inline-flex" onClick={toggleDesktop} aria-label="Afficher la barre latérale">
                <PanelLeftOpen />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Afficher la barre latérale</TooltipContent>
          </Tooltip>
        )}
        <ModelSelector value={model} onChange={changeModel} disabled={chat.isStreaming} />
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={desktopCollapsed ? "" : "md:hidden"}
              aria-label="Nouvelle conversation"
              onClick={() => {
                startNewChat();
                router.push("/");
              }}
            >
              <SquarePen />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Nouvelle conversation</TooltipContent>
        </Tooltip>
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {empty ? (
          <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center gap-4 px-4 pb-10 text-center">
            <Logo className="size-12" />
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Comment puis-je vous aider ?</h1>
            <p className="max-w-md text-sm text-muted-foreground">
              {modelInfo
                ? `Vous discutez avec ${modelInfo.name}, exécuté sur votre propre serveur.`
                : "Les réponses sont générées par votre serveur IA local."}
            </p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-4 pb-8 md:px-6">{items}</div>
        )}
      </div>

      <div className="relative shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6">
        {!stick && !empty && (
          <Button
            variant="secondary"
            size="icon"
            className="absolute -top-12 left-1/2 -translate-x-1/2 bg-popover"
            onClick={() => {
              setStick(true);
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
            }}
            aria-label="Aller au dernier message"
          >
            <ArrowDown />
          </Button>
        )}
        <div className="mx-auto w-full max-w-3xl">
          <Composer
            ref={composerRef}
            onSubmit={send}
            onStop={chat.stop}
            isStreaming={chat.isStreaming}
            blockedReason={blockedReason}
            thinking={thinkingActive}
            thinkingCapability={thinkingCapability}
            onThinkingChange={(v) => {
              setThinkingTouched(true);
              setThinkingPref(v);
            }}
            placeholder={last?.clarification && last.status === "COMPLETE" ? "Répondez ou précisez librement" : undefined}
          />
        </div>
      </div>
    </div>
  );
}
