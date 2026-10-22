import "server-only";
import { db } from "@/lib/db";
import { getModels } from "@/lib/llm/discovery";
import { getAppSettings } from "@/lib/settings/service";
import { resolveWindow } from "./window";
import type { WindowSource } from "./types";

export type ContextAdminView = {
  settings: {
    providerType: "OLLAMA" | "OPENAI_COMPATIBLE";
    contextDefaultWindow: number;
    contextResponseReserve: number;
    contextWarnPct: number;
    contextHighPct: number;
    contextAutoCompactPct: number;
    memoryFeatureEnabled: boolean;
    /** Modèle de l'analyse automatique de la mémoire ("" = celui de la conversation). */
    memoryModel: string;
  };
  models: Array<{
    model: string;
    installed: boolean;
    providerMax: number | null;
    manual: { contextWindow: number; responseReserve: number | null } | null;
    effective: { window: number; reserve: number; capacity: number; source: WindowSource };
  }>;
  reachable: boolean;
};

export async function getContextAdminView(): Promise<ContextAdminView> {
  const [app, snapshot, overrides] = await Promise.all([getAppSettings(), getModels(), db.modelContextConfig.findMany()]);
  const byModel = new Map(overrides.map((o) => [o.model, o]));
  const ids = [...new Set([...snapshot.models.map((m) => m.id), ...overrides.map((o) => o.model)])].sort();
  return {
    settings: {
      providerType: app.providerType,
      contextDefaultWindow: app.contextDefaultWindow,
      contextResponseReserve: app.contextResponseReserve,
      contextWarnPct: app.contextWarnPct,
      contextHighPct: app.contextHighPct,
      contextAutoCompactPct: app.contextAutoCompactPct,
      memoryFeatureEnabled: app.memoryFeatureEnabled,
      memoryModel: app.memoryModel ?? "",
    },
    reachable: snapshot.provider.reachable,
    models: ids.map((id) => {
      const info = snapshot.models.find((m) => m.id === id);
      const o = byModel.get(id);
      const manual = o ? { contextWindow: o.contextWindow, responseReserve: o.responseReserve } : null;
      const w = resolveWindow({
        providerKind: app.providerType,
        providerMax: info?.contextLength,
        override: manual,
        appDefaultWindow: app.contextDefaultWindow,
        appReserve: app.contextResponseReserve,
      });
      return {
        model: id,
        installed: Boolean(info),
        providerMax: info?.contextLength ?? null,
        manual,
        effective: { window: w.window, reserve: w.reserve, capacity: w.capacity, source: w.source },
      };
    }),
  };
}
