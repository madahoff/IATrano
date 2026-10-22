"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowUp, FileUp, Square, X } from "lucide-react";
import { api, ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";

export type ComposerHandle = { focus: () => void; setValue: (v: string) => void };

const MAX_HEIGHT = 240;
type Attachment = { name: string; kind: string; text: string; warning: string | null };

export const Composer = forwardRef<
  ComposerHandle,
  {
    onSubmit: (text: string) => void;
    onStop: () => void;
    isStreaming: boolean;
    blockedReason?: string | null;
    /** Envoi impossible temporairement (analyse JEV ou confirmation en attente) sans afficher le bouton Arrêter. */
    busy?: boolean;
    /** Commandes affichées sous le champ (modes, mode d'autorisation, aide). */
    tools?: React.ReactNode;
    placeholder?: string;
  }
>(function Composer({ onSubmit, onStop, isStreaming, blockedReason, busy, tools, placeholder }, ref) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [coarse, setCoarse] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !isStreaming && !busy && !blockedReason && !uploading;

  function submit() {
    if (!canSend) return;
    const files = attachments.map((a) => `<attached_document name="${a.name.replace(/[<>"']/g, "")}" kind="${a.kind}">\n${a.text}\n</attached_document>${a.warning ? `\n[Limitation : ${a.warning}]` : ""}`).join("\n\n");
    onSubmit([value.trim(), files].filter(Boolean).join("\n\n"));
    setValue("");
    setAttachments([]);
  }

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of [...files]) {
        const form = new FormData(); form.append("file", file);
        const result = await api<Attachment>("/api/chat/attachments", { method: "POST", body: form });
        setAttachments((current) => [...current, result]);
      }
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : "Le fichier n’a pas pu être lu.");
    } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
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
        {attachments.length > 0 && <div className="flex flex-wrap gap-1 px-2 pb-1">{attachments.map((a, i) => <span key={`${a.name}-${i}`} className="inline-flex max-w-full items-center gap-1 rounded-full bg-background px-2 py-1 text-xs"><FileUp className="size-3" /><span className="max-w-48 truncate">{a.name}</span><button type="button" onClick={() => setAttachments((current) => current.filter((_, n) => n !== i))} aria-label={`Retirer ${a.name}`}><X className="size-3" /></button></span>)}</div>}
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*" className="hidden" onChange={(e) => void addFiles(e.target.files)} />
          <Button type="button" variant="ghost" size="icon" disabled={isStreaming || busy || uploading} onClick={() => fileRef.current?.click()} aria-label="Joindre un document"><FileUp /></Button>
          {uploading && <span className="px-2 text-xs text-muted-foreground">Lecture du fichier…</span>}
          {tools}
          <div className="flex-1" />

          {isStreaming ? (
            <Button type="button" size="icon" onClick={onStop} aria-label="Arrêter la génération" className="size-9">
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!canSend} aria-label="Envoyer le message" className="size-9">
              <ArrowUp className="size-5" />
            </Button>
          )}
        </div>
      </form>
      <p className="mt-2 hidden text-center text-xs text-muted-foreground sm:block">
        Entrée pour envoyer · Maj + Entrée pour un saut de ligne · Les réponses de l&apos;IA peuvent contenir des erreurs.
      </p>
    </div>
  );
});
