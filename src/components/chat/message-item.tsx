"use client";

import { memo, useEffect, useRef, useState } from "react";
import { AlertTriangle, Ban, Info, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/common/copy-button";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { ThinkingBlock } from "./thinking-block";
import { ResearchPanel } from "./research-panel";
import { SourcesSummary } from "./sources";
import { DocSourcesSummary, DocumentsProgress } from "./documents/doc-sources";
import { RoutingTags } from "./routing/routing-tags";
import { ArtifactBuilding, ArtifactCard } from "./artifacts/artifact-card";
import type { UIMessage } from "./use-chat";

export const UserMessage = memo(function UserMessage({
  message,
  canEdit,
  onEdit,
}: {
  message: UIMessage;
  canEdit: boolean;
  onEdit: (id: string, content: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing || !ref.current) return;
    const el = ref.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  if (editing) {
    return (
      <div className="ml-auto w-full max-w-[85%] rounded-3xl bg-bubble p-3">
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 320)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && draft.trim()) {
              e.preventDefault();
              setEditing(false);
              onEdit(message.id, draft.trim());
            }
          }}
          aria-label="Modifier le message"
          className="max-h-80 min-h-12 w-full resize-none bg-transparent px-2 py-1 text-[0.95rem] leading-7 outline-none"
        />
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => { setDraft(message.content); setEditing(false); }}>
            Annuler
          </Button>
          <Button size="sm" disabled={!draft.trim()} onClick={() => { setEditing(false); onEdit(message.id, draft.trim()); }}>
            Envoyer
          </Button>
        </div>
        <p className="mt-2 px-2 text-xs text-muted-foreground">Les réponses suivantes seront remplacées par une nouvelle génération.</p>
      </div>
    );
  }

  return (
    <div className="group/msg flex flex-col items-end">
      <div className="max-w-[85%] rounded-3xl bg-bubble px-4 py-2.5 text-[0.95rem] leading-7 break-words whitespace-pre-wrap">
        {message.content}
      </div>
      <div className="mt-1 flex gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover/msg:opacity-100 md:focus-within:opacity-100">
        <CopyButton text={message.content} label="Copier le message" />
        {canEdit && !message.id.startsWith("temp-") && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Modifier le message" onClick={() => { setDraft(message.content); setEditing(true); }}>
                <Pencil />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Modifier et régénérer</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
});

export const AssistantMessage = memo(function AssistantMessage({
  message,
  isLast,
  busy,
  onRegenerate,
  onOpenArtifact,
  openArtifactKey,
  children,
}: {
  message: UIMessage;
  isLast: boolean;
  busy: boolean;
  onRegenerate: (id: string) => void;
  onOpenArtifact?: (id: string) => void;
  /** Clé de l'artifact affiché dans le panneau (carte mise en évidence). */
  openArtifactKey?: string | null;
  children?: React.ReactNode;
}) {
  const streaming = message.status === "STREAMING";
  const hasText = message.content.length > 0;
  const showThinking = Boolean(message.thinking);
  const research = message.research;
  // Une recherche sans source (échec, aucun résultat) n'active pas les citations : tout [n] serait faux.
  const citeSources = research && research.sources.length > 0 ? research.sources : research ? [] : undefined;

  return (
    <div className="group/msg flex flex-col">
      {message.routing && <RoutingTags routing={message.routing} />}
      {research && <ResearchPanel research={research} answerStarted={hasText} />}
      {streaming && message.documentStep && <DocumentsProgress step={message.documentStep} />}
      {showThinking && <ThinkingBlock thinking={message.thinking!} active={streaming} answerStarted={hasText} />}

      {hasText && <Markdown content={message.content} sources={citeSources} documents={message.documents} streaming={streaming} />}
      {streaming && hasText && !message.artifactBuilding && <span className="mt-1 inline-block h-4 w-1.5 animate-pulse rounded-full bg-foreground/50" aria-hidden />}
      {message.artifactBuilding && <ArtifactBuilding title={message.artifactBuilding.title} chars={message.artifactBuilding.chars} />}
      {onOpenArtifact && message.artifacts.map((a) => <ArtifactCard key={a.key} artifact={a} active={a.key === openArtifactKey} onOpen={onOpenArtifact} />)}

      {message.notices
        .filter((n) => n.code !== "empty_response")
        .map((n, i) => (
          <p key={i} className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            {n.message}
          </p>
        ))}

      {message.documents && !streaming && <DocSourcesSummary documents={message.documents} />}
      {research && !streaming && <SourcesSummary sources={research.sources} cited={research.cited ?? (message.status === "COMPLETE" ? null : [])} />}

      {message.status === "ERROR" && (
        <div role="alert" className="mt-3 rounded-2xl bg-destructive/10 px-4 py-3 text-sm">
          <p className="flex items-start gap-2 font-medium text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {message.error ?? "La génération a échoué."}
          </p>
          {message.hint && <p className="mt-1.5 pl-6 text-muted-foreground">{message.hint}</p>}
        </div>
      )}

      {message.status === "CANCELLED" && (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Ban className="size-3.5" /> {message.error ?? "Génération interrompue."}
        </p>
      )}

      {children}

      {!streaming && (
        <div className={cn("mt-2 flex items-center gap-0.5 text-xs text-muted-foreground", !isLast && "opacity-100 md:opacity-0 md:group-hover/msg:opacity-100 md:focus-within:opacity-100")}>
          {hasText && <CopyButton text={message.content} label="Copier la réponse" />}
          {isLast && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground" disabled={busy} aria-label="Régénérer la réponse" onClick={() => onRegenerate(message.id)}>
                  <RotateCcw />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Régénérer</TooltipContent>
            </Tooltip>
          )}
          <span className="ml-1.5 truncate">
            {[message.model, formatDuration(message.durationMs)].filter(Boolean).join(" · ")}
          </span>
        </div>
      )}
    </div>
  );
});
