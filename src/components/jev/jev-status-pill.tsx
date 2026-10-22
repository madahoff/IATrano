"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import type { JevHealthStatus } from "@/lib/jev/service";

export const JEV_AUTO_REFRESH_KEY = "iatrano.jev.autoRefresh";
const REFRESH_MS = 30_000;

const DOT: Record<JevHealthStatus["state"], string> = {
  green: "bg-success",
  orange: "bg-warning",
  red: "bg-destructive",
};

type Status = Partial<JevHealthStatus> & Pick<JevHealthStatus, "state" | "label">;

/** Rafraîchissement automatique (préférence du navigateur, activé par défaut). */
export function useJevAutoRefresh(): [boolean, (on: boolean) => void] {
  const [value, set] = useLocalStorage(JEV_AUTO_REFRESH_KEY);
  return [value !== "off", (on) => set(on ? "on" : "off")];
}

/** Pastille d'état de JEV (vert / orange / rouge), interrogée via /health toutes les 30 s. */
export function JevStatusPill({ href, className, compact }: { href?: string; className?: string; compact?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [autoRefresh] = useJevAutoRefresh();

  const refresh = useCallback(
    () =>
      api<Status>("/api/jev/health")
        .then(setStatus)
        .catch(() => setStatus({ state: "red", label: "État de JEV indisponible" })),
    [],
  );

  useEffect(() => {
    void refresh();
    if (!autoRefresh) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    // Rafraîchissement immédiat après un test ou un enregistrement sur la page Connexion JEV.
    window.addEventListener("jev:refresh", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("jev:refresh", onFocus);
    };
  }, [autoRefresh, refresh]);

  const label = status?.label ?? "Vérification de JEV…";
  const content = (
    <span className={cn("inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs text-muted-foreground transition-colors hover:bg-muted", className)}>
      <span className={cn("size-2.5 shrink-0 rounded-full", status ? DOT[status.state] : "bg-muted-foreground/40", status?.state === "green" && "shadow-[0_0_0_3px] shadow-success/20")} aria-hidden />
      <span className={cn(compact && "sr-only sm:not-sr-only")}>JEV</span>
      <span className="sr-only">{label}</span>
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {href ? (
          <Link href={href} aria-label={`${label} — ouvrir la page Connexion JEV`}>
            {content}
          </Link>
        ) : (
          <button type="button" onClick={() => void refresh()} aria-label={`${label} — actualiser`}>
            {content}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <p className="font-medium">{label}</p>
        {status?.detail && <p className="mt-0.5 opacity-80">{status.detail}</p>}
        {status?.latencyMs != null && <p className="mt-0.5 opacity-80">Réponse en {status.latencyMs} ms</p>}
        <p className="mt-0.5 opacity-70">{autoRefresh ? "Actualisé toutes les 30 s." : "Actualisation automatique désactivée."}</p>
      </TooltipContent>
    </Tooltip>
  );
}
