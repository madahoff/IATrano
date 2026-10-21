"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { SourceDTO } from "@/lib/search/research-types";
import { cn } from "@/lib/utils";
import { SourceFavicon } from "./source-favicon";

const dateFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const fmtDate = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : dateFmt.format(d);
};

function SourceLink({ source, compact = false }: { source: SourceDTO; compact?: boolean }) {
  const published = fmtDate(source.publishedAt);
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      className="group/src flex min-w-0 gap-2.5 rounded-2xl bg-muted px-3 py-2.5 outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span className="mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-background px-1 text-[0.7rem] font-semibold text-foreground tabular-nums">{source.n}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <SourceFavicon src={source.favicon} host={source.host} />
          <span className="truncate">{source.siteName ?? source.host}</span>
          {published && <span className="shrink-0">· {published}</span>}
        </span>
        <span className="mt-0.5 line-clamp-2 text-[0.85rem] leading-5 font-medium text-foreground">{source.title}</span>
        {!compact && source.snippet && <span className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{source.snippet}</span>}
        {(source.content !== "full" || source.cached) && (
          <span className="mt-1 block text-[0.7rem] text-muted-foreground">
            {[source.content === "snippet" ? "Extrait du moteur de recherche uniquement" : source.content === "partial" ? "Page lue partiellement" : null, source.cached ? "contenu récupéré récemment (cache)" : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </span>
      <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/src:opacity-100" />
    </a>
  );
}

/** Marqueur [n] cliquable dans le texte : ouvre une fiche de la source (utilisable au tactile). */
export function CitationChip({ n, source }: { n: number; source: SourceDTO }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Source ${n} : ${source.title}`}
          className="mx-0.5 inline-flex h-[1.15rem] min-w-[1.15rem] -translate-y-px items-center justify-center rounded-full bg-muted px-1 align-middle text-[0.68rem] leading-none font-semibold text-muted-foreground tabular-nums transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {n}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] p-1.5" align="start">
        <SourceLink source={source} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Sources sous la réponse : rangée compacte (icônes + nombre réel de sources citées), dépliable en liste.
 * Si le modèle n'a cité aucune source valide, la liste est présentée comme « consultées », sans lien avec le texte.
 */
export function SourcesSummary({ sources, cited }: { sources: SourceDTO[]; cited: number[] | null }) {
  const [open, setOpen] = useState(false);
  if (sources.length === 0 || cited === null) return null;
  const citedSet = new Set(cited);
  const shown = cited.length ? sources.filter((s) => citedSet.has(s.n)) : sources;
  const label = cited.length
    ? `${shown.length} source${shown.length > 1 ? "s" : ""}`
    : `${shown.length} source${shown.length > 1 ? "s" : ""} consultée${shown.length > 1 ? "s" : ""}, non citée${shown.length > 1 ? "s" : ""} dans le texte`;

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-2 rounded-full bg-muted py-1 pr-3 pl-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="flex -space-x-1">
          {shown.slice(0, 4).map((s) => (
            <SourceFavicon key={s.n} src={s.favicon} host={s.host} className="size-5 ring-2 ring-muted" />
          ))}
        </span>
        <span className="truncate">{label}</span>
        <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {shown.map((s) => (
            <li key={s.n} className="min-w-0">
              <SourceLink source={s} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
