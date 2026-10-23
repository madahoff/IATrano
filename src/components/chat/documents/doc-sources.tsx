"use client";

import { useState } from "react";
import { AlertTriangle, BookOpen, ChevronDown, ExternalLink, FileSearch, Loader2, Sparkles } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PageViewer } from "@/components/documents/page-viewer";
import { locationLabel, originalHref } from "@/components/documents/format";
import type { CitationCheckDTO, DocSourceDTO, DocumentRetrievalDTO } from "@/lib/documents/types";
import { cn } from "@/lib/utils";

type Open = { projectId: string; documentId: string; page: number; term?: string | null } | null;

function SourceCard({ source, check, onOpen }: { source: DocSourceDTO; check?: CitationCheckDTO; onOpen: (o: Open) => void }) {
  const loc = locationLabel(source.kind, source);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-5 min-w-6 shrink-0 items-center justify-center rounded-full bg-background px-1 text-[0.7rem] font-semibold tabular-nums">D{source.n}</span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{source.name}</p>
          <p className="text-xs text-muted-foreground">{[loc, source.section].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
      {source.derived && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3.5 shrink-0" /> Synthèse produite par l&apos;IA, pas un passage original.
        </p>
      )}
      {check && !check.supported && (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Ce passage ne semble pas soutenir pleinement la phrase qui le cite : vérifiez l&apos;original.
        </p>
      )}
      <p className="line-clamp-6 text-xs leading-5 whitespace-pre-wrap text-muted-foreground">{source.excerpt}</p>
      <div className="flex flex-wrap gap-2">
        {source.page != null && !source.derived && (
          <button type="button" onClick={() => onOpen({ projectId: source.projectId, documentId: source.documentId, page: source.page! })} className="inline-flex items-center gap-1 rounded-full bg-background px-2.5 py-1 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50">
            <FileSearch className="size-3.5" /> Voir le passage
          </button>
        )}
        <a href={originalHref(source.projectId, source.documentId, source.kind, source)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-full bg-background px-2.5 py-1 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50">
          <ExternalLink className="size-3.5" /> Original{loc ? ` (${loc})` : ""}
        </a>
      </div>
    </div>
  );
}

/** Marqueur [Dn] cliquable dans la réponse. */
export function DocCitationChip({ source, check }: { source: DocSourceDTO; check?: CitationCheckDTO }) {
  const [open, setOpen] = useState<Open>(null);
  const weak = check && !check.supported;
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Source D${source.n} : ${source.name}${source.page != null ? `, ${locationLabel(source.kind, source)}` : ""}${weak ? " (faiblement étayée)" : ""}`}
            className={cn(
              "mx-0.5 inline-flex h-[1.15rem] min-w-[1.6rem] -translate-y-px items-center justify-center gap-0.5 rounded-full px-1 align-middle text-[0.68rem] leading-none font-semibold tabular-nums transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              weak ? "bg-amber-500/20 text-amber-800 hover:bg-amber-500/40 dark:text-amber-300" : "bg-muted text-muted-foreground hover:bg-primary hover:text-primary-foreground",
            )}
          >
            <BookOpen className="size-2.5" aria-hidden />
            {source.n}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] rounded-2xl" align="start">
          <SourceCard source={source} check={check} onOpen={setOpen} />
        </PopoverContent>
      </Popover>
      {open && <PageViewer projectId={open.projectId} documentId={open.documentId} page={open.page} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Étape en cours pendant la recherche dans les documents du projet. */
export function DocumentsProgress({ step }: { step: string }) {
  return (
    <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
      <Loader2 className="size-3.5 animate-spin" /> Documents du projet : {step}
    </p>
  );
}

/** Sources documentaires de la réponse : citées d'abord, puis consultées ; limites de la recherche. */
export function DocSourcesSummary({ documents }: { documents: DocumentRetrievalDTO }) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const cited = new Set(documents.cited ?? []);
  const checks = new Map(documents.checks.map((c) => [c.n, c]));
  const list = documents.cited ? [...documents.sources.filter((s) => cited.has(s.n)), ...documents.sources.filter((s) => !cited.has(s.n))] : documents.sources;
  if (!documents.sources.length && !documents.limitations.length) return null;
  return (
    <div className="mt-3 rounded-2xl bg-muted/60 px-3 py-2">
      <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="flex w-full items-center gap-2 rounded-lg text-left text-xs font-medium text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <BookOpen className="size-3.5" />
        <span className="flex-1">
          {documents.sources.length
            ? `Documents : ${documents.cited ? `${documents.cited.length} passage(s) cité(s) sur ${documents.sources.length} consulté(s)` : `${documents.sources.length} passage(s) consulté(s)`}`
            : "Documents : aucun passage pertinent retrouvé"}
          {documents.checks.some((c) => !c.supported) ? " · à vérifier" : ""}
        </span>
        <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <div className="mt-2 flex flex-col gap-3 pb-1">
          {list.map((s) => (
            <div key={s.n} className={cn(documents.cited && !cited.has(s.n) && "opacity-70")}>
              <SourceCard source={s} check={checks.get(s.n)} onOpen={setOpen} />
            </div>
          ))}
          {documents.limitations.length > 0 && (
            <ul className="flex flex-col gap-1 text-xs text-amber-700 dark:text-amber-400">
              {documents.limitations.map((l, i) => (
                <li key={i} className="flex gap-1.5">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {l}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {open && <PageViewer projectId={open.projectId} documentId={open.documentId} page={open.page} onClose={() => setOpen(null)} />}
    </div>
  );
}
