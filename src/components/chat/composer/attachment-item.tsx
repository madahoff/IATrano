"use client";

import { AlertCircle, Check, FileText, Image as ImageIcon, LoaderCircle, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isActive, MAX_ATTACHMENT_BYTES, type AttachmentItem } from "./use-attachments";

const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

export function formatBytes(n: number) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${nf.format(n / 1024)} Ko`;
  return `${nf.format(n / 1024 / 1024)} Mo`;
}

/** Libellé d'état, aussi annoncé aux lecteurs d'écran. */
export function statusLabel(it: AttachmentItem) {
  switch (it.status) {
    case "preparing":
      return "Préparation…";
    case "uploading":
      return it.percent === null ? "Envoi en cours…" : `Envoi en cours — ${it.percent} %`;
    case "processing":
      return "Transféré · analyse du document…";
    case "ready":
      return it.result?.warning ?? "Prêt";
    case "canceled":
      return "Envoi annulé";
    case "error":
      return it.error ?? "Échec de l’envoi";
  }
}

export function AttachmentChip({ item, onCancel, onRetry, onRemove }: { item: AttachmentItem; onCancel: () => void; onRetry: () => void; onRemove: () => void }) {
  const { file, status } = item;
  const active = isActive(status);
  const failed = status === "error" || status === "canceled";
  const Icon = file.type.startsWith("image/") ? ImageIcon : FileText;
  const size = status === "uploading" && item.loaded > 0 ? `${formatBytes(item.loaded)} / ${formatBytes(file.size)}` : formatBytes(file.size);
  const label = statusLabel(item);

  if (status === "ready") {
    return (
      <li className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-background py-1 pr-1 pl-2.5 text-xs" title={item.result?.warning ?? undefined}>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="max-w-48 truncate">{file.name}</span>
        {item.result?.warning ? <AlertCircle className="size-3.5 shrink-0 text-warning-foreground" aria-label={item.result.warning} /> : <Check className="size-3.5 shrink-0 text-success" aria-hidden />}
        <Button type="button" variant="ghost" size="icon-xs" className="size-7 sm:size-6" onClick={onRemove} aria-label={`Retirer ${file.name}`}>
          <X />
        </Button>
      </li>
    );
  }

  return (
    <li className={cn("flex w-full min-w-0 flex-col gap-1 rounded-2xl bg-background px-2.5 py-1.5 text-xs sm:w-80", failed && "bg-background/60")}>
      <div className="flex min-w-0 items-center gap-2">
        {active ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
        ) : status === "error" ? (
          <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
        ) : (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={file.name}>
            {file.name}
          </p>
          <p className={cn("truncate text-muted-foreground tabular-nums", status === "error" && "text-destructive")} title={label}>
            {status === "error" ? label : `${label} · ${size}`}
          </p>
        </div>
        {active ? (
          <Button type="button" variant="ghost" size="icon-xs" className="size-7 sm:size-6" onClick={onCancel} aria-label={`Annuler l’envoi de ${file.name}`} title="Annuler l’envoi">
            <X />
          </Button>
        ) : (
          <>
            {file.size <= MAX_ATTACHMENT_BYTES && (
              <Button type="button" variant="ghost" size="icon-xs" className="size-7 sm:size-6" onClick={onRetry} aria-label={`Réessayer l’envoi de ${file.name}`} title="Réessayer">
                <RotateCcw />
              </Button>
            )}
            <Button type="button" variant="ghost" size="icon-xs" className="size-7 sm:size-6" onClick={onRemove} aria-label={`Retirer ${file.name}`} title="Retirer">
              <X />
            </Button>
          </>
        )}
      </div>
      {active && (
        // Barre déterminée pendant le transfert (octets réels), indéterminée pendant la préparation et l'analyse serveur.
        <div
          role="progressbar"
          aria-label={`Envoi de ${file.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={status === "uploading" && item.percent !== null ? item.percent : undefined}
          aria-valuetext={label}
          className="h-1 overflow-hidden rounded-full bg-muted"
        >
          {status === "uploading" && item.percent !== null ? (
            <div className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out" style={{ width: `${item.percent}%` }} />
          ) : (
            <div className={cn("h-full w-full animate-pulse rounded-full motion-reduce:animate-none", status === "processing" ? "bg-primary/60" : "bg-muted-foreground/25")} />
          )}
        </div>
      )}
    </li>
  );
}
