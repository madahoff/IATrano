"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2, Lock } from "lucide-react";
import { api, ApiError } from "@/lib/client/api";
import type { ChatFileDTO, ChatFileUpload } from "@/lib/files/types";
import { cn } from "@/lib/utils";

/** Propriétés communes à chaque visualiseur / éditeur de format. */
export type ViewerProps = {
  file: ChatFileDTO;
  /** Nouvelle version enregistrée (métadonnées et texte transmis au modèle mis à jour). */
  onSaved: (saved: ChatFileUpload) => void;
  /** Modifications non enregistrées : le panneau demande confirmation avant de fermer ou de changer de fichier. */
  onDirtyChange: (dirty: boolean) => void;
};

export const contentUrl = (file: Pick<ChatFileDTO, "id" | "version">, download = false) => `/api/chat/files/${file.id}/content?v=${file.version}${download ? "&download=1" : ""}`;

export function saveFile(id: string, body: { baseVersion: number; text: string } | { baseVersion: number; edits: Array<{ index: number; text: string }> }) {
  return api<ChatFileUpload>(`/api/chat/files/${id}/content`, { method: "PUT", json: body });
}

export function errorMessage(err: unknown, fallback = "Opération impossible.") {
  return err instanceof ApiError ? err.message : fallback;
}

/** Contenu texte d'un fichier (dernière version), rechargé quand la version change ou à la demande. */
export function useFileText(file: ChatFileDTO) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; text: string } | { key: string; error: string } | null>(null);
  const key = `${file.id}:${file.version}:${attempt}`;
  useEffect(() => {
    let cancelled = false;
    fetch(contentUrl(file))
      .then(async (res) => {
        if (!res.ok) throw new ApiError(res.status === 404 ? "Fichier introuvable." : `Lecture impossible (${res.status}).`, res.status);
        return res.text();
      })
      .then((text) => !cancelled && setState({ key, text }))
      .catch((err) => !cancelled && setState({ key, error: errorMessage(err, "Lecture du fichier impossible : vérifiez votre connexion.") }));
    return () => {
      cancelled = true;
    };
  }, [file, key]);
  return { state: state?.key === key ? state : null, reload: () => setAttempt((n) => n + 1) };
}

export function ViewerToolbar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1.5", className)}>{children}</div>;
}

export function Loading({ label = "Chargement…" }: { label?: string }) {
  return (
    <p className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> {label}
    </p>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-4 flex items-start gap-2 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p>{message}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="mt-1 text-xs font-medium underline underline-offset-2">
            Réessayer
          </button>
        )}
      </div>
    </div>
  );
}

export function ReadOnlyNote({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Lock className="size-3.5" aria-hidden /> {children}
    </span>
  );
}

/** Raccourci Ctrl/Cmd + S pour enregistrer, actif seulement dans le panneau. */
export function useSaveShortcut(save: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, enabled]);
}

/** État d'un enregistrement, affiché dans la barre d'outils. */
export type SaveState = { status: "idle" } | { status: "saving" } | { status: "saved" } | { status: "error"; message: string };

export function SaveStatus({ state, dirty }: { state: SaveState; dirty: boolean }) {
  const text =
    state.status === "saving" ? "Enregistrement…" : state.status === "error" ? state.message : dirty ? "Modifications non enregistrées" : state.status === "saved" ? "Enregistré" : null;
  if (!text) return null;
  return (
    <span role="status" className={cn("truncate text-xs", state.status === "error" ? "text-destructive" : dirty ? "text-warning-foreground" : "text-muted-foreground")}>
      {text}
    </span>
  );
}

/** Logique d'enregistrement commune : appel, état, propagation de la nouvelle version. */
export function useSaver(file: ChatFileDTO, onSaved: ViewerProps["onSaved"]) {
  const [state, setState] = useState<SaveState>({ status: "idle" });
  const save = useCallback(
    async (body: { text: string } | { edits: Array<{ index: number; text: string }> }) => {
      setState({ status: "saving" });
      try {
        const saved = await saveFile(file.id, { baseVersion: file.version, ...body });
        setState({ status: "saved" });
        onSaved(saved);
        return true;
      } catch (err) {
        setState({ status: "error", message: errorMessage(err, "Enregistrement impossible : vérifiez votre connexion.") });
        return false;
      }
    },
    [file.id, file.version, onSaved],
  );
  return { state, save };
}
