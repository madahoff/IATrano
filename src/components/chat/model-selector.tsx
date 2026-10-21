"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Brain, Check, ChevronDown, Loader2, RefreshCw, Server, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useApp } from "@/components/layout/app-context";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ModelSelector({ value, onChange, disabled }: { value: string | null; onChange: (id: string) => void; disabled?: boolean }) {
  const { models, modelsLoading, refreshModels, user } = useApp();
  const [open, setOpen] = useState(false);
  const reachable = models?.provider.reachable ?? false;
  const current = models?.models.find((m) => m.id === value);
  const unavailable = Boolean(models && value && !current);

  let label: React.ReactNode = value ?? "Choisir un modèle";
  if (!models && modelsLoading) label = "Chargement…";
  else if (models && !reachable) label = "Serveur IA injoignable";
  else if (models && models.models.length === 0) label = "Aucun modèle";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          disabled={disabled}
          className={cn("h-9 max-w-[min(60vw,22rem)] gap-1.5 px-3 text-[0.95rem] font-semibold", (unavailable || (models && !reachable)) && "text-warning-foreground")}
          aria-label="Sélectionner le modèle"
        >
          {(unavailable || (models && !reachable)) && <AlertTriangle className="text-warning" />}
          <span className="truncate">{label}</span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,24rem)] p-1.5">
        <div className="flex items-center justify-between px-2.5 pt-1.5 pb-2">
          <span className="text-xs font-medium text-muted-foreground">Modèles détectés sur le serveur IA</span>
          <Button variant="ghost" size="icon-xs" onClick={() => refreshModels(true)} disabled={modelsLoading} aria-label="Actualiser la liste des modèles">
            {modelsLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>

        {models && !reachable && (
          <div className="mx-1 mb-1 rounded-xl bg-warning/15 px-3 py-2.5 text-sm">
            <p className="flex items-start gap-2 font-medium text-warning-foreground">
              <Server className="mt-0.5 size-4 shrink-0" /> {models.provider.error ?? "Serveur IA injoignable."}
            </p>
            {models.provider.hint && <p className="mt-1 pl-6 text-xs text-muted-foreground">{models.provider.hint}</p>}
            {user.isAdmin && (
              <Link href="/admin/ai" className="mt-2 ml-6 inline-block text-xs font-medium underline underline-offset-4">
                Configurer le serveur IA
              </Link>
            )}
          </div>
        )}

        {unavailable && reachable && (
          <p className="mx-1 mb-1 rounded-xl bg-warning/15 px-3 py-2 text-xs text-warning-foreground">
            « {value} » n&apos;est plus disponible sur le serveur. Choisissez un autre modèle.
          </p>
        )}

        {models && reachable && models.models.length === 0 && (
          <p className="px-2.5 py-4 text-center text-sm text-muted-foreground">
            Le serveur répond mais n&apos;expose aucun modèle.
            <br />
            <span className="text-xs">Installez-en un (ex. <code>ollama pull qwen2.5:3b</code>) puis actualisez.</span>
          </p>
        )}

        <ul className="max-h-[50vh] overflow-y-auto" role="listbox" aria-label="Modèles">
          {models?.models.map((m) => {
            const selected = m.id === value;
            const meta = [m.parameterSize, m.quantization, formatBytes(m.sizeBytes)].filter(Boolean).join(" · ");
            return (
              <li key={m.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                  className={cn("flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent", selected && "bg-accent")}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{m.name}</span>
                      {models.defaultModel === m.id && <Star className="size-3 shrink-0 fill-current text-muted-foreground" aria-label="Modèle par défaut" />}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {meta && <span>{meta}</span>}
                      {m.capabilities.thinking === "yes" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-background px-1.5 py-0.5">
                          <Brain className="size-3" /> Thinking
                        </span>
                      )}
                      {m.capabilities.thinking === "unknown" && <span className="rounded-full bg-background px-1.5 py-0.5">capacités non déclarées</span>}
                    </span>
                  </span>
                  {selected && <Check className="mt-0.5 size-4 shrink-0" />}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
