"use client";

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Paperclip, SlidersHorizontal, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AttachmentChip } from "./composer/attachment-item";
import { isActive, useAttachments, type AttachmentItem } from "./composer/use-attachments";

export type ComposerHandle = { focus: () => void; setValue: (v: string) => void };

const MAX_HEIGHT = 240;

const ANNOUNCE: Record<AttachmentItem["status"], string> = {
  preparing: "préparation",
  uploading: "envoi en cours",
  processing: "transfert terminé, analyse en cours",
  ready: "prêt",
  error: "échec",
  canceled: "envoi annulé",
};

export const Composer = forwardRef<
  ComposerHandle,
  {
    onSubmit: (text: string) => void;
    onStop: () => void;
    isStreaming: boolean;
    blockedReason?: string | null;
    /** Envoi impossible temporairement (analyse JEV ou confirmation en attente) sans afficher le bouton Arrêter. */
    busy?: boolean;
    /** Commandes contextuelles toujours visibles dans la barre de saisie (ex. « Modifier la page »). */
    tools?: React.ReactNode;
    /** Options secondaires (modes, pilotage JEV…), regroupées dans un panneau repliable. */
    options?: React.ReactNode;
    /** Options actives, rappelées sur le bouton du panneau quand il est fermé. */
    activeOptions?: { count: number; description: string; indicator: React.ReactNode };
    placeholder?: string;
  }
>(function Composer({ onSubmit, onStop, isStreaming, blockedReason, busy, tools, options, activeOptions, placeholder }, ref) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [coarse, setCoarse] = useState(false);
  const attachments = useAttachments();
  const fileRef = useRef<HTMLInputElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsId = useId();
  const optionsToggleRef = useRef<HTMLButtonElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setValue: (v: string) => setValue(v),
  }));

  useEffect(() => {
    setCoarse(window.matchMedia("(pointer: coarse)").matches);
  }, []);

  // Hauteur automatique : compacte au départ, grandit avec le contenu jusqu'à MAX_HEIGHT puis défile.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);

  const ready = attachments.items.filter((a) => a.status === "ready" && a.result);
  const uploading = attachments.items.some((a) => isActive(a.status));
  const canSend = (value.trim().length > 0 || ready.length > 0) && !isStreaming && !busy && !blockedReason && !uploading;

  function submit() {
    if (!canSend) return;
    // Seuls les fichiers entièrement analysés partent au modèle ; les envois annulés ou en échec sont écartés.
    const files = ready
      .map(({ result: a }) => `<attached_document name="${a!.name.replace(/[<>"']/g, "")}" kind="${a!.kind}">\n${a!.text}\n</attached_document>${a!.warning ? `\n[Limitation : ${a!.warning}]` : ""}`)
      .join("\n\n");
    onSubmit([value.trim(), files].filter(Boolean).join("\n\n"));
    setValue("");
    attachments.clear();
  }

  function addFiles(files: FileList | null) {
    if (files?.length) attachments.add(files);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="w-full">
      {blockedReason && <p className="mb-2 px-4 text-center text-xs text-warning-foreground">{blockedReason}</p>}
      <form
        data-mascot-attention
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="rounded-[1.75rem] bg-muted p-2 transition-colors focus-within:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_4%)]"
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Entrée envoie, Maj+Entrée insère une ligne. Sur écran tactile, Entrée insère une ligne (envoi par le bouton).
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !coarse) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder ?? "Envoyer un message"}
          aria-label="Message"
          className="block max-h-[240px] min-h-11 w-full resize-none bg-transparent px-3 py-2.5 text-base leading-6 outline-none placeholder:text-muted-foreground md:text-[0.95rem]"
        />
        {attachments.items.length > 0 && (
          <ul aria-label="Fichiers joints" className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto px-1 pb-1">
            {attachments.items.map((it) => (
              <AttachmentChip key={it.id} item={it} onCancel={() => attachments.cancel(it.id)} onRetry={() => attachments.retry(it.id)} onRemove={() => attachments.remove(it.id)} />
            ))}
          </ul>
        )}
        <p className="sr-only" aria-live="polite">
          {attachments.items.map((it) => `${it.file.name} : ${ANNOUNCE[it.status]}.`).join(" ")}
        </p>
        {options && (
          // Panneau des options : replié par défaut ; l'ouverture anime la hauteur (grid 0fr → 1fr) sans saut.
          // Replié, il reste monté (l'état des options est conservé) mais inerte (ni focus ni lecteur d'écran).
          <div
            id={optionsId}
            className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none", optionsOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
            inert={!optionsOpen}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !e.defaultPrevented) {
                setOptionsOpen(false);
                optionsToggleRef.current?.focus();
              }
            }}
          >
            <div className="min-h-0 overflow-hidden">
              <div role="group" aria-label="Options du chat" className="mx-1 mt-1 max-h-[min(40dvh,22rem)] overflow-y-auto rounded-2xl bg-background px-3 py-2.5">
                {options}
              </div>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*" className="hidden" onChange={(e) => addFiles(e.target.files)} />
          <Button type="button" variant="ghost" size="icon" disabled={isStreaming || busy} onClick={() => fileRef.current?.click()} aria-label="Joindre un document" title="Joindre un document (PDF, DOCX, image)">
            <Paperclip />
          </Button>
          {options && (
            <Button
              ref={optionsToggleRef}
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={optionsOpen}
              aria-controls={optionsId}
              aria-label={`Options du chat${activeOptions?.count ? ` (${activeOptions.count} active${activeOptions.count > 1 ? "s" : ""} : ${activeOptions.description})` : ""}`}
              onClick={() => setOptionsOpen((o) => !o)}
              className="h-9 gap-1.5 px-3 text-muted-foreground"
            >
              <SlidersHorizontal />
              <span className="hidden sm:inline">Options</span>
              {!optionsOpen && activeOptions?.indicator}
              <ChevronDown className={cn("size-3.5 transition-transform duration-200 motion-reduce:transition-none", optionsOpen && "rotate-180")} />
            </Button>
          )}
          {tools}
          <div className="flex-1" />

          {isStreaming ? (
            <Button type="button" size="icon" onClick={onStop} aria-label="Arrêter la génération" className="size-9">
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!canSend} aria-label={uploading ? "Envoi impossible : fichiers en cours de transfert" : "Envoyer le message"} title={uploading ? "Attendez la fin de l’envoi des fichiers" : undefined} className="size-9">
              <ArrowUp className="size-5" />
            </Button>
          )}
        </div>
      </form>
      <p className="mt-1.5 hidden text-center text-xs text-muted-foreground sm:block">
        Entrée pour envoyer · Maj + Entrée pour un saut de ligne · Les réponses de l&apos;IA peuvent contenir des erreurs.
      </p>
    </div>
  );
});
