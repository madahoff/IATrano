"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/client/api";
import type { ContextStreamEvent } from "@/lib/chat/protocol";
import { contextState, type ContextState, type ContextUsageDTO } from "@/lib/context/types";

// État client du compteur de contexte.
// - Hors génération : valeur calculée par le serveur pour le PROCHAIN prompt (GET /api/context).
// - Pendant une génération : prompt réellement envoyé (événement « context ») + sortie en cours,
//   estimée ici à ~3,6 caractères par token (affichée comme estimation).

export type LiveContext = { promptTokens: number; window: number; capacity: number; rag: number; dropped: number };

export type CompactionResultView = { before: number; after: number } | { nothing: string } | null;

export function useContextUsage(opts: { conversationId: string | null; model: string | null }) {
  const [usage, setUsage] = useState<ContextUsageDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState<LiveContext | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [lastResult, setLastResult] = useState<CompactionResultView>(null);
  const reqRef = useRef(0);
  const key = `${opts.conversationId ?? ""}|${opts.model ?? ""}`;

  const refresh = useCallback(async () => {
    if (!opts.model) return;
    const id = ++reqRef.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ model: opts.model });
      if (opts.conversationId) qs.set("conversationId", opts.conversationId);
      const data = await api<{ usage: ContextUsageDTO }>(`/api/context?${qs}`);
      if (id !== reqRef.current) return;
      setUsage(data.usage);
      setError(null);
      setCompacting(data.usage.compaction.status === "RUNNING");
    } catch (err) {
      if (id === reqRef.current) setError(err instanceof ApiError ? err.message : "Consommation du contexte indisponible.");
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  }, [opts.conversationId, opts.model]);

  // Recalcul à chaque changement de conversation ou de modèle (la fenêtre dépend du modèle).
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setLastResult(null);
  }
  useEffect(() => {
    const t = setTimeout(() => void refresh(), 150);
    return () => clearTimeout(t);
  }, [refresh]);

  const onStreamEvent = useCallback(
    (ev: ContextStreamEvent) => {
      switch (ev.type) {
        case "context":
          setLive({ promptTokens: ev.promptTokens, window: ev.window, capacity: ev.capacity, rag: ev.rag, dropped: ev.dropped });
          break;
        case "context_measured":
          if (ev.promptTokens) setLive((l) => (l ? { ...l, promptTokens: ev.promptTokens! } : l));
          break;
        case "compaction":
          if (ev.status === "running") {
            setCompacting(true);
            toast.message(ev.message ?? "Compaction automatique du contexte…");
          } else {
            setCompacting(false);
            if (ev.status === "done") toast.success(ev.message ?? "Contexte compacté.");
            else toast.error(ev.message ?? "Compaction automatique impossible : le contexte précédent est conservé.");
          }
          break;
        case "memory": {
          // Retour discret : émis seulement quand la mémoire change réellement (jamais pour une information déjà connue).
          const parts = [
            ev.saved.length ? `${ev.saved.length} nouveau(x) souvenir(s)` : "",
            ev.updated.length ? `${ev.updated.length} mis à jour` : "",
            ev.removed ? `${ev.removed} oublié(s)` : "",
          ].filter(Boolean);
          if (parts.length) {
            toast.message(`Mémoire : ${parts.join(", ")}`, {
              id: "memory-update",
              description: [...ev.updated, ...ev.saved].slice(0, 2).join(" · ") || undefined,
              duration: 5000,
              action: { label: "Gérer", onClick: () => window.open("/settings/memory", "_blank", "noopener") },
            });
          }
          else if (ev.rejected.length) toast.message(ev.rejected[0], { id: "memory-update", duration: 5000 });
          break;
        }
      }
    },
    [],
  );

  const onStreamEnd = useCallback(() => {
    setLive(null);
    void refresh();
  }, [refresh]);

  const compact = useCallback(async () => {
    if (!opts.conversationId || !opts.model || compacting) return;
    setCompacting(true);
    setLastResult(null);
    try {
      const data = await api<{
        result: { status: "compacted"; tokensBefore: number; tokensAfter: number } | { status: "nothing"; reason: string };
        usage: ContextUsageDTO;
      }>(`/api/conversations/${opts.conversationId}/compact`, { method: "POST", json: { model: opts.model } });
      setUsage(data.usage);
      if (data.result.status === "compacted") {
        setLastResult({ before: data.result.tokensBefore, after: data.result.tokensAfter });
        toast.success("Contexte réduit. L'historique complet reste consultable.");
      } else {
        setLastResult({ nothing: data.result.reason });
        toast.message(data.result.reason);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "La réduction du contexte a échoué : le contexte précédent est conservé.");
      void refresh();
    } finally {
      setCompacting(false);
    }
  }, [opts.conversationId, opts.model, compacting, refresh]);

  return { usage, error, loading, live, compacting, lastResult, refresh, compact, onStreamEvent, onStreamEnd };
}

export type ContextView = {
  percent: number;
  used: number;
  capacity: number;
  state: ContextState;
  live: boolean;
};

/** Valeurs affichées par l'indicateur : prompt en cours pendant la génération, sinon prochain prompt. */
export function contextView(usage: ContextUsageDTO | null, live: LiveContext | null, streamingChars: number): ContextView | null {
  if (live) {
    const used = live.promptTokens + Math.round(streamingChars / 3.6);
    const percent = Math.round((used / live.capacity) * 1000) / 10;
    return { percent, used, capacity: live.capacity, state: usage ? contextState(percent, usage.thresholds) : percent >= 100 ? "critical" : "normal", live: true };
  }
  if (!usage) return null;
  return { percent: usage.percent, used: usage.used, capacity: usage.capacity, state: usage.state, live: false };
}

export const fmt = (n: number) => Math.round(n).toLocaleString("fr-FR");

