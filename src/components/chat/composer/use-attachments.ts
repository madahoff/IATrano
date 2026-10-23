"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/client/api";
import { isAbortError, uploadFile } from "@/lib/client/upload";

// Pièces jointes du chat : chaque fichier a son propre envoi (progression, annulation, nouvelle tentative).
// Seuls les fichiers à l'état « ready » sont transmis au modèle.

export type AttachmentResult = { name: string; kind: string; text: string; warning: string | null };

export type AttachmentStatus = "preparing" | "uploading" | "processing" | "ready" | "error" | "canceled";

export type AttachmentItem = {
  id: string;
  file: File;
  status: AttachmentStatus;
  /** Octets du fichier déjà transmis (estimés à partir du corps multipart, jamais au-delà de la réalité). */
  loaded: number;
  /** Pourcentage réel de transfert, null tant que le navigateur ne l'a pas mesuré. */
  percent: number | null;
  error?: string;
  result?: AttachmentResult;
};

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Envois simultanés : au-delà, les fichiers attendent leur tour (l'analyse OCR est coûteuse côté serveur). */
const CONCURRENCY = 2;

export const isActive = (s: AttachmentStatus) => s === "preparing" || s === "uploading" || s === "processing";

export function useAttachments() {
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const queue = useRef<string[]>([]);
  const files = useRef(new Map<string, File>());

  const patch = useCallback((id: string, p: Partial<AttachmentItem>) => {
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...p } : it)));
  }, []);

  const pump = useCallback(function pump() {
    while (controllers.current.size < CONCURRENCY && queue.current.length) {
      const id = queue.current.shift()!;
      const file = files.current.get(id);
      if (!file) continue;
      const controller = new AbortController();
      controllers.current.set(id, controller);
      const form = new FormData();
      form.append("file", file);
      uploadFile<AttachmentResult>("/api/chat/attachments", form, {
        signal: controller.signal,
        onProgress: ({ loaded, total }) => {
          if (controller.signal.aborted) return;
          // Pourcentage arrondi vers le bas : 100 % seulement quand le dernier octet est parti.
          patch(id, { status: "uploading", percent: Math.floor((loaded / total) * 100), loaded: Math.min(file.size, Math.round((loaded / total) * file.size)) });
        },
        onUploaded: () => !controller.signal.aborted && patch(id, { status: "processing", percent: 100, loaded: file.size }),
      })
        .then((result) => {
          // Réponse arrivée au moment même de l'annulation : le choix de l'utilisateur l'emporte.
          if (!controller.signal.aborted) patch(id, { status: "ready", result });
        })
        .catch((err: unknown) => {
          if (isAbortError(err) || controller.signal.aborted) return; // état déjà mis à jour par cancel()
          patch(id, { status: "error", error: err instanceof ApiError ? err.message : "Le fichier n’a pas pu être lu." });
        })
        .finally(() => {
          if (controllers.current.get(id) === controller) controllers.current.delete(id);
          pump();
        });
    }
  }, [patch]);

  const enqueue = useCallback(
    (id: string) => {
      queue.current.push(id);
      pump();
    },
    [pump],
  );

  const add = useCallback(
    (list: FileList | File[]) => {
      const added: AttachmentItem[] = [...list].map((file) => {
        const id = crypto.randomUUID();
        files.current.set(id, file);
        // Contrôle local immédiat : inutile de transférer 200 Mo pour se faire refuser par le serveur.
        if (file.size > MAX_ATTACHMENT_BYTES)
          return { id, file, status: "error", loaded: 0, percent: null, error: `Fichier trop volumineux (maximum ${MAX_ATTACHMENT_BYTES / 1024 / 1024} Mo).` };
        return { id, file, status: "preparing", loaded: 0, percent: null };
      });
      setItems((current) => [...current, ...added]);
      for (const it of added) if (it.status === "preparing") enqueue(it.id);
    },
    [enqueue],
  );

  const cancel = useCallback(
    (id: string) => {
      queue.current = queue.current.filter((q) => q !== id);
      controllers.current.get(id)?.abort();
      controllers.current.delete(id);
      patch(id, { status: "canceled", percent: null, loaded: 0, error: undefined });
      pump();
    },
    [patch, pump],
  );

  const retry = useCallback(
    (id: string) => {
      const file = files.current.get(id);
      if (!file || file.size > MAX_ATTACHMENT_BYTES) return;
      patch(id, { status: "preparing", percent: null, loaded: 0, error: undefined, result: undefined });
      enqueue(id);
    },
    [enqueue, patch],
  );

  const remove = useCallback(
    (id: string) => {
      queue.current = queue.current.filter((q) => q !== id);
      controllers.current.get(id)?.abort();
      controllers.current.delete(id);
      files.current.delete(id);
      setItems((list) => list.filter((it) => it.id !== id));
      pump();
    },
    [pump],
  );

  /** Vide la liste (après envoi du message) : interrompt ce qui serait encore en cours. */
  const clear = useCallback(() => {
    queue.current = [];
    for (const c of controllers.current.values()) c.abort();
    controllers.current.clear();
    files.current.clear();
    setItems([]);
  }, []);

  // Démontage (changement de conversation, navigation) : aucune requête ne doit survivre.
  useEffect(() => {
    const live = controllers.current;
    return () => {
      for (const c of live.values()) c.abort();
      live.clear();
    };
  }, []);

  return { items, add, cancel, retry, remove, clear };
}
