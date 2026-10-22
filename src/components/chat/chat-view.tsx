"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, FolderKanban, Menu, PanelLeftOpen, Sparkles, SquarePen, X } from "lucide-react";
import Link from "next/link";
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
import { ContextBanner, ContextIndicator } from "@/components/context/context-indicator";
import { contextView, useContextUsage } from "@/components/context/use-context-usage";
import { JevStatusPill } from "@/components/jev/jev-status-pill";
import { ArtifactPanel } from "./artifacts/artifact-panel";
import { toArtifactRef, type ArtifactDTO } from "@/lib/artifacts/types";
import { cn } from "@/lib/utils";
import { AuthModeSelector, ModeButtons, RoutingHelp } from "./routing/mode-controls";
import { RoutingConfirmationCard, RoutingProgress } from "./routing/confirmation-card";
import { useRouting, type Dispatch } from "./routing/use-routing";
import { ROUTING_MODES, type AuthMode, type RoutingMode } from "@/lib/routing/config";
import type { Availability, Overrides } from "@/lib/routing/decide";

type InitialConversation = { id?: string; title?: string; model?: string | null; webSearch?: boolean; projectId?: string | null; messages?: MessageDTO[] } | null;

export function ChatView({ conversation }: { conversation: InitialConversation }) {
  const { models, upsertConversation, startNewChat } = useApp();
  const { openMobileNav, desktopCollapsed, toggleDesktop } = useShell();
  const router = useRouter();
  const composerRef = useRef<ComposerHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  // Relais vers le compteur de contexte (créé plus bas, car il dépend de la conversation et du modèle).
  const contextEvents = useRef<Pick<ReturnType<typeof useContextUsage>, "onStreamEvent" | "onStreamEnd"> | null>(null);

  // --- Panneau des pages interactives (artifacts) : ouvert automatiquement à la création d'une page.
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  const [panelArtifact, setPanelArtifact] = useState<Pick<ArtifactDTO, "id" | "key" | "title" | "version"> | null>(null);
  const [panelExpanded, setPanelExpanded] = useState(false);
  // « Modifier cette page » : actif par défaut quand une page est ouverte ; la demande suivante la modifie.
  const [editArtifact, setEditArtifact] = useState(true);
  const openArtifact = useCallback((id: string) => {
    setOpenArtifactId(id);
    setEditArtifact(true);
  }, []);
  const closeArtifact = useCallback(() => {
    setOpenArtifactId(null);
    setPanelArtifact(null);
    setPanelExpanded(false);
  }, []);

  const chat = useChat(
    { conversationId: conversation?.id ?? null, messages: conversation?.messages ?? [] },
    {
      onConversationCreated: (id, content) => {
        upsertConversation({ id, title: fallbackTitle(content), updatedAt: new Date().toISOString(), projectId: conversation?.projectId ?? null });
        // Change l'URL sans recharger la vue : le flux en cours continue.
        window.history.replaceState(null, "", `/c/${id}`);
      },
      onTitle: (id, title) => upsertConversation({ id, title }),
      onActivity: (id) => upsertConversation({ id, updatedAt: new Date().toISOString() }),
      onContextEvent: (ev) => contextEvents.current?.onStreamEvent(ev),
      onStreamEnd: () => contextEvents.current?.onStreamEnd(),
      onArtifact: (artifact) => openArtifact(artifact.id),
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

  // --- Contexte : consommation réelle du prompt pour le modèle actif (recalculée au changement de modèle).
  const contextUsage = useContextUsage({ conversationId: chat.conversationId, model: modelInfo ? model : null });
  useEffect(() => {
    contextEvents.current = contextUsage;
  });
  const lastMessage = chat.messages.at(-1);
  const streamingChars = chat.isStreaming && lastMessage?.role === "ASSISTANT" ? lastMessage.content.length + (lastMessage.thinking?.length ?? 0) : 0;
  const ctxView = contextView(contextUsage.usage, chat.isStreaming ? contextUsage.live : null, streamingChars);
  const [bannerDismissed, setBannerDismissed] = useState<string | null>(null);

  // --- Routage JEV : mode d'autorisation (choix de l'utilisateur, sinon défaut de l'administration)
  // et boutons de modes. Hors mode « Désactivé », un bouton ne vaut que pour le prochain message.
  const [authModeChoice, setAuthModeChoice] = useState<AuthMode | null>(null);
  const authMode: AuthMode = authModeChoice ?? models?.routing.authMode ?? "HYBRID";
  const [overrides, setOverrides] = useState<Overrides>({});
  const changeAuthMode = useCallback((m: AuthMode) => {
    setAuthModeChoice(m);
    setOverrides({});
    void api("/api/me/settings", { method: "PATCH", json: { routingAuthMode: m } }).catch(() => toast.error("Le mode d'autorisation n'a pas pu être enregistré."));
  }, []);
  const availability: Availability = useMemo(
    () => ({
      thinking: modelInfo?.capabilities.thinking === "no" ? { available: false, reason: `Le modèle « ${modelInfo.name} » ne prend pas en charge la réflexion approfondie.` } : { available: true },
      research: !models
        ? { available: false, reason: "Chargement…" }
        : !models.webSearch.enabled
          ? { available: false, reason: "La recherche Web est désactivée par l'administration." }
          : !models.webSearch.available
            ? { available: false, reason: "Aucun moteur de recherche n'est configuré (Administration → Recherche Web)." }
            : { available: true },
      // Le mode artifacts est disponible dès que le chat est disponible ; il ne dépend
      // d'aucun service externe supplémentaire.
      interactive: { available: true },
    }),
    [models, modelInfo],
  );
  const forbidden = useMemo(() => Object.fromEntries(ROUTING_MODES.map((m) => [m, models?.routing.rules[m] === "FORBIDDEN"])) as Record<RoutingMode, boolean>, [models]);
  const visibleModes: RoutingMode[] = [...ROUTING_MODES];

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

  const projectId = conversation?.projectId ?? null;
  const [projectName, setProjectName] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api<{ project: { name: string } }>(`/api/projects/${projectId}`)
      .then((d) => !cancelled && setProjectName(d.project.name))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  const editingArtifact = openArtifactId && editArtifact && panelArtifact && !forbidden.interactive ? panelArtifact : null;

  // Les modes sont fixés (par JEV, l'utilisateur ou le repli) : appel de Qwen.
  const dispatch = useCallback<Dispatch>(
    (action, routing, outcomes) => {
      if (!model) return;
      // Sans décision de routage (analyse indisponible), les boutons forcés s'appliquent tels quels.
      const thinkingOn = outcomes ? outcomes.thinking.state === "on" : overrides.thinking === "on";
      const researchOn = outcomes ? outcomes.research.state === "on" : overrides.research === "on";
      const r = routing ?? undefined;
      setStick(true);
      if (action.kind === "send") void chat.send(action.content, model, thinkingOn, researchOn, projectId, r, action.artifactKey);
      else if (action.kind === "edit") void chat.edit(action.messageId, action.content, model, thinkingOn, researchOn, projectId, r, action.artifactKey);
      else void chat.regenerate(action.assistantMessageId, model, thinkingOn, researchOn, projectId, r);
      if (authMode !== "OFF") setOverrides({});
    },
    [model, overrides, chat, projectId, authMode],
  );
  const routingFlow = useRouting({
    getConversationId: chat.currentConversationId,
    model,
    authMode,
    // Modification de la page ouverte : le mode interactif est demandé explicitement.
    overrides: editingArtifact ? { ...overrides, interactive: "on" } : overrides,
    dispatch,
    onCancel: (action) => {
      if (action.kind === "send") composerRef.current?.setValue(action.content);
      composerRef.current?.focus();
    },
  });
  const busy = chat.isStreaming || routingFlow.pending !== null;

  const send = useCallback(
    (text: string) => {
      if (!ensureReady() || busy) return;
      setStick(true);
      void routingFlow.start({ kind: "send", content: text, artifactKey: editingArtifact?.key });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routingFlow.start, busy, model, blockedReason, editingArtifact],
  );
  const regenerate = useCallback(
    (id: string) => {
      if (!ensureReady() || busy) return;
      const idx = chat.messages.findIndex((m) => m.id === id);
      const userMsg = chat.messages.slice(0, idx < 0 ? undefined : idx).findLast((m) => m.role === "USER");
      if (!userMsg) return;
      setStick(true);
      void routingFlow.start({ kind: "regenerate", assistantMessageId: id, userMessageId: userMsg.id.startsWith("temp-") ? null : userMsg.id, content: userMsg.content });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routingFlow.start, busy, chat.messages, model, blockedReason],
  );
  const edit = useCallback(
    (id: string, content: string) => {
      if (!ensureReady() || busy) return;
      setStick(true);
      void routingFlow.start({ kind: "edit", messageId: id, content, artifactKey: editingArtifact?.key });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routingFlow.start, busy, model, blockedReason, editingArtifact],
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
  const pending = routingFlow.pending;
  const empty = chat.messages.length === 0 && !pending;

  const items = useMemo(
    () =>
      chat.messages.map((m, i) =>
        m.role === "USER" ? (
          <UserMessage key={m.id} message={m} canEdit={!busy} onEdit={edit} />
        ) : (
          <AssistantMessage key={m.id} message={m} isLast={i === lastIndex} busy={busy} onRegenerate={regenerate} onOpenArtifact={openArtifact} openArtifactKey={openArtifactId ? panelArtifact?.key : null}>
            {i === lastIndex && m.clarification && m.status === "COMPLETE" && (
              <ClarificationCard
                clarification={m.clarification}
                disabled={busy}
                onAnswer={send}
                onFreeAnswer={() => composerRef.current?.focus()}
              />
            )}
          </AssistantMessage>
        ),
      ),
    [chat.messages, busy, lastIndex, edit, regenerate, send, openArtifact, openArtifactId, panelArtifact?.key],
  );

  return (
    <div className="flex h-full min-h-0">
    <div className={cn("flex min-w-0 flex-1 flex-col", openArtifactId && panelExpanded && "md:hidden")}>
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
        {modelInfo && (
          <ContextIndicator
            view={ctxView}
            usage={contextUsage.usage}
            error={contextUsage.error}
            loading={contextUsage.loading}
            compacting={contextUsage.compacting}
            lastResult={contextUsage.lastResult}
            canCompact={Boolean(chat.conversationId)}
            busy={chat.isStreaming}
            onCompact={() => void contextUsage.compact()}
            onRefresh={() => void contextUsage.refresh()}
          />
        )}
        <ModelSelector value={model} onChange={changeModel} disabled={chat.isStreaming} />
        {projectId && (
          <Button variant="ghost" size="sm" asChild className="min-w-0 gap-1.5 text-muted-foreground">
            <Link href={`/projects/${projectId}`} title="Conversation du projet : instructions, documents et mémoire partagés">
              <FolderKanban />
              <span className="hidden max-w-40 truncate sm:inline">{projectName ?? "Projet"}</span>
            </Link>
          </Button>
        )}
        <div className="flex-1" />
        <JevStatusPill compact />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={desktopCollapsed ? "" : "md:hidden"}
              aria-label="Nouvelle conversation"
              onClick={() => {
                // Une nouvelle conversation ouverte depuis un projet reste dans ce projet.
                startNewChat();
                router.push(projectId ? `/?projectId=${encodeURIComponent(projectId)}` : "/");
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
            {projectId && (
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <FolderKanban className="size-4" /> Nouvelle conversation dans le projet « {projectName ?? "…"} »
              </p>
            )}
            <p className="max-w-md text-sm text-muted-foreground">
              {modelInfo
                ? `Vous discutez avec ${modelInfo.name}, exécuté sur votre propre serveur.`
                : "Les réponses sont générées par votre serveur IA local."}
            </p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-4 pb-8 md:px-6">
            {items}
            {pending && (
              <div className="flex flex-col gap-3">
                {pending.action.kind !== "regenerate" && (
                  <div className="ml-auto max-w-[85%] rounded-3xl bg-bubble px-4 py-2.5 text-[0.95rem] leading-7 break-words whitespace-pre-wrap opacity-80">
                    {pending.action.content}
                  </div>
                )}
                {pending.phase === "analyzing" ? (
                  <RoutingProgress />
                ) : (
                  <RoutingConfirmationCard outcomes={pending.proposal.outcomes} onConfirm={routingFlow.confirm} onCancel={routingFlow.cancel} />
                )}
              </div>
            )}
          </div>
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
          {chat.conversationId && bannerDismissed !== `${chat.conversationId}:${ctxView?.state}` && (
            <ContextBanner
              view={ctxView}
              usage={contextUsage.usage}
              compacting={contextUsage.compacting}
              busy={chat.isStreaming}
              onCompact={() => void contextUsage.compact()}
              onDismiss={() => setBannerDismissed(`${chat.conversationId}:${ctxView?.state}`)}
            />
          )}
          <Composer
            ref={composerRef}
            onSubmit={send}
            onStop={chat.stop}
            isStreaming={chat.isStreaming}
            busy={pending !== null}
            blockedReason={blockedReason}
            tools={
              <>
                {editingArtifact && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditArtifact(false)}
                    aria-label={`Ne plus modifier « ${editingArtifact.title} » ; la prochaine demande ne concernera pas cette page`}
                    title="Votre prochain message modifiera cette page. Cliquez pour annuler."
                    className="h-9 max-w-56 gap-1.5 bg-accent px-3"
                  >
                    <Sparkles />
                    <span className="truncate">Modifier « {editingArtifact.title} » v{editingArtifact.version}</span>
                    <X className="size-3.5" />
                  </Button>
                )}
                <ModeButtons
                  authMode={authMode}
                  overrides={overrides}
                  availability={availability}
                  forbidden={forbidden}
                  visible={visibleModes}
                  onChange={(m, v) => setOverrides((o) => ({ ...o, [m]: v }))}
                />
                <AuthModeSelector value={authMode} onChange={changeAuthMode} disabled={busy} />
                <RoutingHelp />
              </>
            }
            placeholder={
              editingArtifact
                ? "Décrivez la modification (ex. : agrandis le graphique)"
                : last?.clarification && last.status === "COMPLETE"
                  ? "Répondez ou précisez librement"
                  : undefined
            }
          />
        </div>
      </div>
    </div>
    {openArtifactId && (
      <div className={cn("fixed inset-0 z-40 md:static md:z-auto md:border-l md:border-border", panelExpanded ? "md:flex-1" : "md:w-[min(48vw,760px)] md:shrink-0")}>
        <ArtifactPanel
          artifactId={openArtifactId}
          expanded={panelExpanded}
          onToggleExpand={() => setPanelExpanded((v) => !v)}
          onClose={closeArtifact}
          onLoaded={(a) => setPanelArtifact({ id: a.id, key: a.key, title: a.title, version: a.version })}
          onNewVersion={(a) => {
            setPanelArtifact({ id: a.id, key: a.key, title: a.title, version: a.version });
            chat.upsertArtifactRef(a.messageId, toArtifactRef(a));
          }}
        />
      </div>
    )}
    </div>
  );
}
