// Envoi d'un fichier en flux brut (XMLHttpRequest : progression d'envoi et annulation).

export type UploadOutcome = { documents: Array<{ id: string; name: string }>; outcomes: Array<"created" | "duplicate" | "new_version"> };

export function uploadDocument(projectId: string, file: File, opts: { replaceId?: string; onProgress?: (fraction: number) => void; signal?: AbortSignal }): Promise<UploadOutcome> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/projects/${projectId}/documents${opts.replaceId ? `?replace=${encodeURIComponent(opts.replaceId)}` : ""}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // réponse non JSON (proxy, coupure)
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) return resolve(data as UploadOutcome);
      const message = (data as { error?: { message?: string } } | null)?.error?.message ?? (xhr.status === 413 ? "Fichier refusé par le serveur (taille)." : `Erreur ${xhr.status || "réseau"}`);
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Connexion au serveur impossible."));
    xhr.onabort = () => reject(new DOMException("Envoi annulé.", "AbortError"));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
