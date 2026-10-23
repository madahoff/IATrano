// Envoi de fichier avec progression réelle et annulation.
// fetch ne sait pas mesurer la progression d'un envoi (seulement celle d'une réception) : on utilise
// XMLHttpRequest, dont `upload.onprogress` rapporte les octets réellement transmis et dont `abort()`
// coupe la connexion (le serveur le voit via `req.signal`).

import { ApiError } from "./api";

export type UploadProgress = { loaded: number; total: number };

export type UploadOptions = {
  signal?: AbortSignal;
  /** Octets du corps de requête déjà transmis (multipart compris). */
  onProgress?: (p: UploadProgress) => void;
  /** Le corps est entièrement transmis : le serveur traite maintenant le fichier. */
  onUploaded?: () => void;
  /** Annule l'envoi si aucun octet ne part pendant ce délai (connexion bloquée). */
  stallMs?: number;
  /** Délai maximal d'attente de la réponse une fois le transfert terminé. */
  processingTimeoutMs?: number;
};

export function isAbortError(err: unknown) {
  return err instanceof DOMException && err.name === "AbortError";
}

function parseError(xhr: XMLHttpRequest): ApiError {
  try {
    const data = JSON.parse(xhr.responseText) as { error?: { message?: string; code?: string } };
    return new ApiError(data.error?.message ?? `Erreur ${xhr.status}`, xhr.status, data.error?.code);
  } catch {
    if (xhr.status === 413) return new ApiError("Fichier trop volumineux pour le serveur.", 413, "file_too_large");
    return new ApiError(xhr.status >= 500 ? "Le serveur ne répond pas correctement." : `Erreur ${xhr.status}`, xhr.status);
  }
}

export function uploadFile<T>(path: string, body: FormData, opts: UploadOptions = {}): Promise<T> {
  const { signal, onProgress, onUploaded, stallMs = 45_000, processingTimeoutMs = 200_000 } = opts;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Envoi annulé.", "AbortError"));
    const xhr = new XMLHttpRequest();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const arm = (ms: number, message: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        xhr.abort();
        finish(() => reject(new ApiError(message, 0, "timeout")));
      }, ms);
    };
    function onAbort() {
      xhr.abort();
      finish(() => reject(new DOMException("Envoi annulé.", "AbortError")));
    }

    xhr.open("POST", path);
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => {
      arm(stallMs, "L’envoi est bloqué : la connexion ne transmet plus de données.");
      if (e.lengthComputable) onProgress?.({ loaded: e.loaded, total: e.total });
    };
    xhr.upload.onload = () => {
      arm(processingTimeoutMs, "Le serveur met trop de temps à analyser le fichier.");
      onUploaded?.();
    };
    xhr.onerror = () => finish(() => reject(new ApiError("Connexion au serveur interrompue. Vérifiez votre réseau.", 0, "network")));
    xhr.onload = () =>
      finish(() => {
        if (xhr.status === 401 && typeof window !== "undefined") {
          // Même comportement que api() : rechargement complet vers la connexion.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.href = "/login";
        }
        if (xhr.status < 200 || xhr.status >= 300) return reject(parseError(xhr));
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new ApiError("Réponse du serveur illisible.", xhr.status));
        }
      });

    signal?.addEventListener("abort", onAbort, { once: true });
    arm(stallMs, "L’envoi n’a pas pu démarrer : le serveur ne répond pas.");
    xhr.send(body);
  });
}
