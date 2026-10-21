import { ProviderError } from "./types";
import { describeNetworkError } from "./url";

export type FetchOptions = {
  baseUrl: string;
  timeoutMs: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

/** fetch avec délai d'attente sur l'obtention des en-têtes, annulation et erreurs réseau traduites. */
export async function fetchWithTimeout(url: string, init: RequestInit, opts: FetchOptions): Promise<Response> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    return await fetch(url, {
      ...init,
      signal,
      redirect: "error",
      cache: "no-store",
      headers: { ...(init.headers as Record<string, string>), ...opts.headers },
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new ProviderError("Génération annulée.", "aborted");
    if (timeout.aborted) {
      const e = new Error("timeout");
      e.name = "TimeoutError";
      throw describeNetworkError(e, opts.baseUrl, opts.timeoutMs);
    }
    throw describeNetworkError(err, opts.baseUrl, opts.timeoutMs);
  }
}

/** Lit un corps de réponse ligne par ligne, avec un délai maximal d'inactivité entre deux fragments. */
export async function* readLines(
  body: ReadableStream<Uint8Array>,
  opts: { idleTimeoutMs: number; signal?: AbortSignal; baseUrl: string },
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => reader.cancel().catch(() => {});
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error("timeout");
          e.name = "TimeoutError";
          reject(describeNetworkError(e, opts.baseUrl, opts.idleTimeoutMs));
        }, opts.idleTimeoutMs);
      });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), idle]);
      } catch (err) {
        if (opts.signal?.aborted) throw new ProviderError("Génération annulée.", "aborted");
        if (err instanceof ProviderError) throw err;
        throw describeNetworkError(err, opts.baseUrl, opts.idleTimeoutMs);
      } finally {
        clearTimeout(timer);
      }
      if (opts.signal?.aborted) throw new ProviderError("Génération annulée.", "aborted");
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer) yield buffer;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock?.();
  }
}

export async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 2000);
    try {
      const data = JSON.parse(text) as { error?: string | { message?: string } };
      if (typeof data.error === "string") return data.error;
      if (data.error?.message) return data.error.message;
    } catch {}
    return text.slice(0, 300) || res.statusText;
  } catch {
    return res.statusText;
  }
}
