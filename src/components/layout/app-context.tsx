"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Role } from "@prisma/client";
import { api } from "@/lib/client/api";
import type { ConversationSummary } from "@/lib/chat/protocol";
import type { ModelInfo, ProviderKind } from "@/lib/llm/types";

export type ClientUser = { id: string; email: string; name: string; role: Role; isAdmin: boolean };

export type ModelsState = {
  provider: { kind: ProviderKind; reachable: boolean; error?: string; hint?: string };
  models: ModelInfo[];
  fetchedAt: string;
  defaultModel: string | null;
  appDefaultModel: string | null;
  thinkingDefault: boolean;
  webSearch: { available: boolean; enabled: boolean; default: boolean };
};

type AppContextValue = {
  user: ClientUser;
  models: ModelsState | null;
  modelsLoading: boolean;
  refreshModels: (force?: boolean) => Promise<void>;
  conversations: ConversationSummary[];
  setConversations: React.Dispatch<React.SetStateAction<ConversationSummary[]>>;
  upsertConversation: (c: Partial<ConversationSummary> & { id: string }) => void;
  removeConversation: (id: string) => void;
  reloadConversations: () => Promise<void>;
  newChatKey: number;
  startNewChat: () => void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  user,
  initialConversations,
  children,
}: {
  user: ClientUser;
  initialConversations: ConversationSummary[];
  children: React.ReactNode;
}) {
  const [models, setModels] = useState<ModelsState | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [conversations, setConversations] = useState(initialConversations);
  const [newChatKey, setNewChatKey] = useState(0);
  const loadingRef = useRef(false);

  const refreshModels = useCallback(async (force = false) => {
    if (loadingRef.current && !force) return;
    loadingRef.current = true;
    setModelsLoading(true);
    try {
      setModels(await api<ModelsState>(`/api/models${force ? "?refresh=1" : ""}`));
    } catch (err) {
      setModels((prev) => ({
        provider: { kind: prev?.provider.kind ?? "OLLAMA", reachable: false, error: err instanceof Error ? err.message : "Erreur" },
        models: [],
        fetchedAt: new Date().toISOString(),
        defaultModel: prev?.defaultModel ?? null,
        appDefaultModel: prev?.appDefaultModel ?? null,
        thinkingDefault: prev?.thinkingDefault ?? false,
        webSearch: prev?.webSearch ?? { available: false, enabled: false, default: false },
      }));
    } finally {
      loadingRef.current = false;
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  const upsertConversation = useCallback((c: Partial<ConversationSummary> & { id: string }) => {
    setConversations((list) => {
      const existing = list.find((x) => x.id === c.id);
      const merged: ConversationSummary = {
        title: "Nouvelle conversation",
        model: null,
        webSearch: true,
        archived: false,
        updatedAt: new Date().toISOString(),
        ...existing,
        ...c,
      };
      const rest = list.filter((x) => x.id !== c.id);
      return [merged, ...rest].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }, []);

  const removeConversation = useCallback((id: string) => {
    setConversations((list) => list.filter((x) => x.id !== id));
  }, []);

  const reloadConversations = useCallback(async () => {
    const data = await api<{ conversations: ConversationSummary[] }>("/api/conversations");
    setConversations(data.conversations);
  }, []);

  const startNewChat = useCallback(() => setNewChatKey((k) => k + 1), []);

  const value = useMemo(
    () => ({
      user,
      models,
      modelsLoading,
      refreshModels,
      conversations,
      setConversations,
      upsertConversation,
      removeConversation,
      reloadConversations,
      newChatKey,
      startNewChat,
    }),
    [user, models, modelsLoading, refreshModels, conversations, upsertConversation, removeConversation, reloadConversations, newChatKey, startNewChat],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp doit être utilisé dans <AppProvider>");
  return ctx;
}
