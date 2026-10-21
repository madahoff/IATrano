"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowUp, Brain, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Capability } from "@/lib/llm/types";
import { cn } from "@/lib/utils";

export type ComposerHandle = { focus: () => void; setValue: (v: string) => void };

const MAX_HEIGHT = 240;

export const Composer = forwardRef<
  ComposerHandle,
  {
    onSubmit: (text: string) => void;
    onStop: () => void;
    isStreaming: boolean;
    blockedReason?: string | null;
    thinking: boolean;
    thinkingCapability: Capability | null;
    onThinkingChange: (v: boolean) => void;
    placeholder?: string;
  }
>(function Composer({ onSubmit, onStop, isStreaming, blockedReason, thinking, thinkingCapability, onThinkingChange, placeholder }, ref) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [coarse, setCoarse] = useState(false);

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

  const canSend = value.trim().length > 0 && !isStreaming && !blockedReason;

  function submit() {
    if (!canSend) return;
    onSubmit(value.trim());
    setValue("");
  }

  const thinkingDisabled = thinkingCapability === "no" || thinkingCapability === null;
  const thinkingTip =
    thinkingCapability === "no"
      ? "Ce modèle ne prend pas en charge le mode Thinking"
      : thinkingCapability === "unknown"
        ? "Le serveur ne déclare pas cette capacité : le raisonnement sera demandé mais pourrait ne pas être renvoyé"
        : thinking
          ? "Thinking activé : le modèle réfléchit avant de répondre"
          : "Activer le Thinking";

  return (
    <div className="w-full">
      {blockedReason && <p className="mb-2 px-4 text-center text-xs text-warning-foreground">{blockedReason}</p>}
      <form
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
        <div className="flex items-center justify-between gap-2 pt-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={thinkingDisabled ? 0 : -1} className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={thinkingDisabled}
                  aria-pressed={thinking && !thinkingDisabled}
                  onClick={() => onThinkingChange(!thinking)}
                  className={cn(
                    "h-9 gap-1.5 px-3 text-muted-foreground hover:bg-accent",
                    thinking && !thinkingDisabled && "bg-primary text-primary-foreground hover:bg-primary/85 hover:text-primary-foreground",
                  )}
                >
                  <Brain />
                  <span className="hidden sm:inline">Thinking</span>
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{thinkingTip}</TooltipContent>
          </Tooltip>

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
