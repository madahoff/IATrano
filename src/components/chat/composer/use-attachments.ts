"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/client/api";
import { isAbortError, uploadFile } from "@/lib/client/upload";
import { CHAT_FILE_MAX_BYTES, type ChatFileUpload } from "@/lib/files/types";
import { onFileSaved } from "@/components/files/viewer-store";

// Pièces jointes du chat : chaque fichier a son propre envoi (progression, annulation, nouvelle tentative).
// Le serveur conserve le fichier (aperçu, édition) ; seuls les fichiers à l'état « ready » sont transmis au modèle.

export type AttachmentResult = ChatFileUpload;

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
  /** false : refus définitif (format, fichier corrompu, trop volumineux) — réessayer ne changerait rien. */
  retryable?: boolean;
  result?: AttachmentResult;
  /** Aperçu local immédiat des images (URL d'objet du navigateur, libérée au retrait). */
  localUrl?: string;
};

export const MAX_ATTACHMENT_BYTES = CHAT_FILE_MAX_BYTES;
/** Images que le navigateur affiche lui-même : miniature locale sans attendre le serveur. */
const LOCAL_PREVIEW = /^image\/(png|jpeg|webp|gif|bmp)$/;
/** Envois simultanés : au-delà, les fichiers attendent leur tour (l'analyse OCR est coûteuse côté serveur). */
const CONCURRENCY = 2;

// Identifiant local d'une pièce jointe (clé de liste). crypto.randomUUID() n'existe qu'en contexte sécurisé
// (HTTPS ou localhost) : en http sur le réseau local il est absent, d'où ce compteur.
let seq = 0;
const localId = () => `att-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const isActive = (s: AttachmentStatus) => s === "preparing" || s === "uploading" || s === "processing";

export function useAttachments() {
  const [items, setItems] = useState<AttachmentItem[]>([]);
  // Dernière liste rendue, lue par les actions qui ont des effets de bord (les fonctions de mise à jour restent pures).
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
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
          // 400 : le serveur a refusé ce fichier (format, contenu illisible) ; le reste est passager (réseau, serveur).
          const definitive = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
          patch(id, { status: "error", error: err instanceof ApiError ? err.message : "Le fichier n’a pas pu être lu.", retryable: !definitive });
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
        const id = localId();
        files.current.set(id, file);
        const localUrl = LOCAL_PREVIEW.test(file.type) ? URL.createObjectURL(file) : undefined;
        // Contrôle local immédiat : inutile de transférer 200 Mo pour se faire refuser par le serveur.
        if (file.size > MAX_ATTACHMENT_BYTES)
          return { id, file, status: "error", loaded: 0, percent: null, localUrl, error: `Fichier trop volumineux (maximum ${MAX_ATTACHMENT_BYTES / 1024 / 1024} Mo).` };
        return { id, file, status: "preparing", loaded: 0, percent: null, localUrl };
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
      patch(id, { status: "preparing", percent: null, loaded: 0, error: undefined, retryable: undefined, result: undefined });
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
      const it = itemsRef.current.find((i) => i.id === id);
      if (it?.localUrl) URL.revokeObjectURL(it.localUrl);
      // Fichier déjà conservé par le serveur mais jamais envoyé : supprimé tout de suite (sinon après 24 h).
      if (it?.result) void fetch(`/api/chat/files/${it.result.id}`, { method: "DELETE" }).catch(() => {});
      setItems((list) => list.filter((i) => i.id !== id));
      pump();
    },
    [pump],
  );

  /** Vide la liste (après envoi du message : les fichiers suivent désormais la conversation) : interrompt ce qui serait encore en cours. */
  const clear = useCallback(() => {
    queue.current = [];
    for (const c of controllers.current.values()) c.abort();
    controllers.current.clear();
    files.current.clear();
    for (const it of itemsRef.current) if (it.localUrl) URL.revokeObjectURL(it.localUrl);
    setItems([]);
  }, []);

  // Fichier modifié dans le panneau d'aperçu : le texte transmis au modèle et la miniature suivent la nouvelle version.
  useEffect(
    () =>
      onFileSaved((saved) => {
        const target = itemsRef.current.find((it) => it.result?.id === saved.id);
        if (!target) return;
        if (target.localUrl) URL.revokeObjectURL(target.localUrl);
        setItems((list) => list.map((it) => (it.id === target.id ? { ...it, result: saved, localUrl: undefined } : it)));
      }),
    [],
  );

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
