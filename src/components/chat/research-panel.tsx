"use client";

import { useState } from "react";
import { Ban, CheckCircle2, ChevronDown, Circle, Globe, Info, Loader2, XCircle } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ResearchDTO, ResearchStep, StepStatus } from "@/lib/search/research-types";
import { cn } from "@/lib/utils";
import { SourceFavicon } from "./source-favicon";

function headline(r: ResearchDTO): string {
  if (r.status === "cancelled") return "Recherche annulée";
  const running = r.steps.findLast((s) => s.status === "running");
  if (r.status === "running" || running) {
    switch (running?.kind) {
      case "fetch":
        return "Consultation des pages…";
      case "select":
      case "context":
        return "Analyse des sources…";
      case "generate":
        return "Préparation de la réponse…";
      default:
        return "Recherche sur le Web…";
    }
  }
  if (r.status === "failed") return "Recherche impossible";
  const pages = r.steps.find((s) => s.id === "fetch")?.count ?? 0;
  const parts = ["Recherche terminée"];
  if (pages) parts.push(`${pages} page${pages > 1 ? "s" : ""} lue${pages > 1 ? "s" : ""}`);
  if (r.sources.length) parts.push(`${r.sources.length} source${r.sources.length > 1 ? "s" : ""} retenue${r.sources.length > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

function StatusIcon({ status, className }: { status: StepStatus; className?: string }) {
  if (status === "running") return <Loader2 className={cn("animate-spin text-foreground", className)} aria-label="En cours" />;
  if (status === "done") return <CheckCircle2 className={cn("text-success", className)} aria-label="Terminé" />;
  if (status === "failed") return <XCircle className={cn("text-destructive", className)} aria-label="Échec" />;
  return <Circle className={cn("text-muted-foreground", className)} aria-label="En attente" />;
}

function Step({ step }: { step: ResearchStep }) {
  return (
    <li className="flex gap-2.5">
      <StatusIcon status={step.status} className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-[0.82rem] leading-5 font-medium text-foreground break-words">{step.label}</p>
        {step.detail && <p className="text-xs leading-5 text-muted-foreground break-words">{step.detail}</p>}
        {step.items && step.items.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-1">
            {step.items.map((it) => (
              <li key={it.url} className="flex min-w-0 items-center gap-2 rounded-xl bg-background px-2.5 py-1.5 text-xs">
                <SourceFavicon src={null} host={it.host} />
                <a href={it.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="min-w-0 flex-1 truncate text-foreground hover:underline">
                  {it.title || it.host}
                  <span className="ml-1.5 text-muted-foreground">{it.host}</span>
                </a>
                {it.note && <span className="hidden max-w-[45%] truncate text-muted-foreground sm:inline">{it.note}</span>}
                <StatusIcon status={it.status} className="size-3.5 shrink-0" />
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * Panneau de recherche intégré à la réponse : déplié pendant la recherche, replié dès que la réponse
 * commence (sauf choix explicite de l'utilisateur). Chaque ligne correspond à un événement réel du serveur.
 */
export function ResearchPanel({ research, answerStarted }: { research: ResearchDTO; answerStarted: boolean }) {
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const active = research.status === "running" || research.steps.some((s) => s.status === "running");
  const open = userChoice ?? (active && !answerStarted);
  const title = headline(research);

  return (
    <Collapsible open={open} onOpenChange={setUserChoice} className="mb-3">
      <CollapsibleTrigger
        className="group inline-flex max-w-full items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label={`${title} — ${open ? "masquer" : "afficher"} les étapes`}
      >
        {active ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        ) : research.status === "cancelled" ? (
          <Ban className="size-3.5 shrink-0" />
        ) : research.status === "failed" ? (
          <XCircle className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Globe className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{title}</span>
        <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 max-h-[min(55vh,30rem)] overflow-y-auto rounded-2xl bg-muted px-3.5 py-3 sm:px-4">
          {research.steps.length === 0 ? (
            <p className="text-xs text-muted-foreground">Démarrage de la recherche…</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {research.steps.map((s) => (
                <Step key={s.id} step={s} />
              ))}
            </ol>
          )}
          {research.limitations.length > 0 && (
            <div className="mt-3 flex flex-col gap-1 pt-1">
              {research.limitations.map((l, i) => (
                <p key={i} className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  {l}
                </p>
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
