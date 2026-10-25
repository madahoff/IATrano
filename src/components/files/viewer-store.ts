"use client";

import { useSyncExternalStore } from "react";
import type { ChatFileUpload, FileKind } from "@/lib/files/types";

// État global du panneau d'aperçu des fichiers : ouvert depuis la zone de saisie ou depuis un message, affiché une
// seule fois au-dessus de toute l'application (FileViewer, monté dans ChatShell).

export type ViewerFile = { id: string; name: string; kind: FileKind };
type State = { open: boolean; files: ViewerFile[]; index: number };

let state: State = { open: false, files: [], index: 0 };
/** Élément qui avait le focus à l'ouverture (carte cliquée) : il le retrouve à la fermeture. */
let opener: HTMLElement | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openFileViewer(files: ViewerFile[], index = 0) {
  if (!files.length) return;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state = { open: true, files, index: Math.min(Math.max(index, 0), files.length - 1) };
  emit();
}

export function closeFileViewer() {
  state = { ...state, open: false };
  emit();
}

export function restoreFocusAfterViewer() {
  if (opener?.isConnected) opener.focus();
  opener = null;
}

export function setFileViewerIndex(index: number) {
  if (index < 0 || index >= state.files.length) return;
  state = { ...state, index };
  emit();
}

export function useFileViewer(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

// Enregistrements effectués dans le panneau : la zone de saisie met à jour le texte qui sera transmis au modèle.
const savedListeners = new Set<(file: ChatFileUpload) => void>();

export function notifyFileSaved(file: ChatFileUpload) {
  savedListeners.forEach((l) => l(file));
}

export function onFileSaved(listener: (file: ChatFileUpload) => void) {
  savedListeners.add(listener);
  return () => {
    savedListeners.delete(listener);
  };
}
