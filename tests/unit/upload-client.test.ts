import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/client/api";
import { isAbortError, uploadFile } from "@/lib/client/upload";

// Faux XMLHttpRequest : le test pilote les événements (progression, fin de transfert, réponse, panne).
class FakeXhr {
  static last: FakeXhr;
  status = 0;
  responseText = "";
  responseType = "";
  aborted = false;
  sent = false;
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void; onload?: () => void } = {};
  onload?: () => void;
  onerror?: () => void;
  constructor() {
    FakeXhr.last = this;
  }
  open() {}
  send() {
    this.sent = true;
  }
  abort() {
    this.aborted = true;
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body: unknown) {
    this.upload.onload?.();
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }
}

const form = () => new FormData();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("uploadFile", () => {
  it("rapporte la progression réelle puis la fin du transfert, et renvoie la réponse", async () => {
    const progress: number[] = [];
    const uploaded = vi.fn();
    const p = uploadFile<{ ok: boolean }>("/x", form(), { onProgress: ({ loaded, total }) => progress.push(loaded / total), onUploaded: uploaded });
    FakeXhr.last.progress(25, 100);
    FakeXhr.last.progress(100, 100);
    expect(uploaded).not.toHaveBeenCalled();
    FakeXhr.last.respond(200, { ok: true });
    await expect(p).resolves.toEqual({ ok: true });
    expect(progress).toEqual([0.25, 1]);
    expect(uploaded).toHaveBeenCalledOnce();
  });

  it("annulation : la requête réseau est réellement interrompue", async () => {
    const controller = new AbortController();
    const p = uploadFile("/x", form(), { signal: controller.signal });
    FakeXhr.last.progress(10, 100);
    controller.abort();
    const err = await p.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(FakeXhr.last.aborted).toBe(true);
  });

  it("annulation pendant l'analyse serveur (transfert terminé)", async () => {
    const controller = new AbortController();
    const p = uploadFile("/x", form(), { signal: controller.signal });
    FakeXhr.last.upload.onload?.();
    controller.abort();
    expect(isAbortError(await p.catch((e: unknown) => e))).toBe(true);
    expect(FakeXhr.last.aborted).toBe(true);
  });

  it("signal déjà annulé : aucune requête n'est émise", async () => {
    const controller = new AbortController();
    controller.abort();
    const before = FakeXhr.last;
    await expect(uploadFile("/x", form(), { signal: controller.signal })).rejects.toSatisfy(isAbortError);
    expect(FakeXhr.last).toBe(before);
  });

  it("connexion bloquée : abandon après le délai sans progression", async () => {
    const p = uploadFile("/x", form(), { stallMs: 1000 });
    FakeXhr.last.progress(10, 100);
    vi.advanceTimersByTime(900);
    FakeXhr.last.progress(20, 100); // la progression réarme le délai
    vi.advanceTimersByTime(900);
    expect(FakeXhr.last.aborted).toBe(false);
    vi.advanceTimersByTime(200);
    const err = (await p.catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("timeout");
    expect(FakeXhr.last.aborted).toBe(true);
  });

  it("analyse serveur trop longue : délai distinct du transfert", async () => {
    const p = uploadFile("/x", form(), { stallMs: 1000, processingTimeoutMs: 5000 });
    FakeXhr.last.upload.onload?.();
    vi.advanceTimersByTime(4000);
    expect(FakeXhr.last.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(((await p.catch((e: unknown) => e)) as ApiError).code).toBe("timeout");
  });

  it("erreur serveur : message et code de l'API conservés", async () => {
    const p = uploadFile("/x", form());
    FakeXhr.last.respond(400, { error: { code: "file_too_large", message: "Fichier trop volumineux (maximum 25 Mo)." } });
    const err = (await p.catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(400);
    expect(err.code).toBe("file_too_large");
    expect(err.message).toMatch(/trop volumineux/);
  });

  it("coupure réseau : erreur explicite", async () => {
    const p = uploadFile("/x", form());
    FakeXhr.last.onerror?.();
    expect(((await p.catch((e: unknown) => e)) as ApiError).code).toBe("network");
  });

  it("une annulation après la réponse est sans effet", async () => {
    const controller = new AbortController();
    const p = uploadFile<{ ok: boolean }>("/x", form(), { signal: controller.signal });
    FakeXhr.last.respond(200, { ok: true });
    controller.abort();
    await expect(p).resolves.toEqual({ ok: true });
    expect(FakeXhr.last.aborted).toBe(false);
  });
});
