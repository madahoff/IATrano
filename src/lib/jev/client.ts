import { z } from "zod";

// Client HTTP de JEV (jevos) : GET /health, GET /v1/models, POST /v1/systemone (questions « noul » uniquement).
// Aucune dépendance à la base : la configuration est fournie par l'appelant (voir service.ts), ce qui
// permet de tester une configuration non enregistrée et de simuler le serveur dans les tests.

export type JevClientConfig = {
  baseUrl: string;
  apiKey: string | null;
  timeoutMs: number;
};

export type JevErrorCode = "unreachable" | "timeout" | "unauthorized" | "unsupported" | "bad_response" | "http_error";

export class JevError extends Error {
  constructor(
    message: string,
    public readonly code: JevErrorCode,
    public readonly hint?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export type Timing = {
  /** Temps total mesuré côté IATrano (requête + réponse). */
  totalMs: number;
  /** Temps d'inférence annoncé par JEV (en-tête Server-Timing), si présent. */
  serverMs: number | null;
};

export type JevHealth = { status: string; ready: boolean; timing: Timing; raw: Record<string, unknown> };
export type JevModels = { ids: string[]; timing: Timing };
export type JevQuestion = { name: string; instructions: string };
export type JevDecision = {
  model: string;
  /** P(oui) entre 0 et 1, par nom de question. */
  answers: Record<string, number>;
  usage?: { input_tokens?: number; output_tokens?: number };
  timing: Timing;
};

export const JEV_DEFAULT_MODEL = "jev-latest";

/** Extrait le temps d'inférence (ms) d'un en-tête Server-Timing ; privilégie une métrique nommée « infer… ». */
export function parseServerTiming(header: string | null): number | null {
  if (!header) return null;
  const metrics = header.split(",").map((part) => {
    const [name, ...params] = part.trim().split(";");
    const dur = params.map((p) => p.trim()).find((p) => p.startsWith("dur="));
    const value = dur ? Number(dur.slice(4).replace(/"/g, "")) : NaN;
    return { name: name.trim().toLowerCase(), value };
  });
  const valid = metrics.filter((m) => Number.isFinite(m.value) && m.value >= 0);
  if (!valid.length) return null;
  const preferred = valid.find((m) => m.name.startsWith("infer")) ?? valid.find((m) => m.name !== "total") ?? valid[0];
  return Math.round(preferred.value * 10) / 10;
}

/** Traduit une erreur réseau Node (fetch failed + cause.code) en message clair avec piste de correction. */
export function describeJevNetworkError(err: unknown, baseUrl: string, timeoutMs: number): JevError {
  if (err instanceof JevError) return err;
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  let target = baseUrl;
  try {
    target = new URL(baseUrl).host;
  } catch {}
  if (e?.name === "TimeoutError") {
    return new JevError(
      `JEV (${target}) n'a pas répondu dans le délai de ${Math.round(timeoutMs / 100) / 10} s.`,
      "timeout",
      "Le serveur est peut-être saturé ou le modèle en cours de chargement. Réessayez, ou augmentez le délai d'attente.",
    );
  }
  const code = e?.cause?.code ?? "";
  if (code === "ECONNREFUSED") {
    return new JevError(
      `Connexion refusée par ${target}.`,
      "unreachable",
      "La machine répond mais rien n'écoute sur ce port : vérifier `systemctl status jev` sur le serveur et l'option --host/--port du service.",
    );
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new JevError(`Hôte « ${target} » introuvable.`, "unreachable", "Nom d'hôte non résolu : utilisez l'adresse IP Tailscale (100.x.y.z) ou vérifiez MagicDNS.");
  }
  if (code.startsWith("ERR_TLS") || code.includes("CERT") || code === "EPROTO") {
    return new JevError("Erreur TLS avec JEV.", "unreachable", "Certificat invalide, ou serveur en http alors que https est sélectionné : vérifiez le protocole.");
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
    return new JevError("La connexion avec JEV a été interrompue.", "unreachable", "Le service s'est peut-être arrêté : vérifier `systemctl status jev` et `journalctl -u jev`.");
  }
  return new JevError(
    `Serveur JEV injoignable (${e?.cause?.message ?? e?.message ?? "erreur inconnue"}).`,
    "unreachable",
    "Vérifier que Tailscale est connecté sur les deux machines et que le pare-feu autorise le port.",
  );
}

const healthSchema = z.object({ status: z.string() }).passthrough();
// Format OpenAI ({ data: [{ id }] }) ou liste simple ({ models: [...] }).
const modelEntry = z.union([z.string(), z.object({ id: z.string() }).transform((m) => m.id), z.object({ name: z.string() }).transform((m) => m.name)]);
const modelsSchema = z.union([
  z.object({ data: z.array(z.object({ id: z.string() }).transform((m) => m.id)) }).transform((r) => r.data),
  z.object({ models: z.array(modelEntry) }).transform((r) => r.models),
]);
const decisionSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.object({ type: z.string().optional(), noul: z.number().min(0).max(1) }).passthrough()),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).passthrough().optional(),
});

type RequestOpts = { auth?: boolean; body?: unknown; signal?: AbortSignal };

export function createJevClient(config: JevClientConfig, deps: { fetch?: typeof fetch } = {}) {
  const doFetch = deps.fetch ?? fetch;
  const base = config.baseUrl.replace(/\/+$/, "");

  async function request(method: "GET" | "POST", path: string, opts: RequestOpts = {}) {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if ((opts.auth ?? true) && config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const controller = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
    const start = performance.now();
    let res: Response;
    let text: string;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fetchPromise = doFetch(`${base}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal,
        redirect: "error",
        cache: "no-store",
      }).then(async (response) => ({ response, text: await response.text() }));
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const e = new Error("timeout");
          e.name = "TimeoutError";
          reject(e);
        }, config.timeoutMs);
      });
      const result = await Promise.race([fetchPromise, timeoutPromise]);
      res = result.response;
      text = result.text;
    } catch (err) {
      if ((err as { name?: string })?.name === "TimeoutError") {
        throw describeJevNetworkError(err, base, config.timeoutMs);
      }
      if (opts.signal?.aborted) throw new JevError("Requête annulée.", "unreachable");
      throw describeJevNetworkError(err, base, config.timeoutMs);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const timing: Timing = { totalMs: Math.round(performance.now() - start), serverMs: parseServerTiming(res.headers.get("server-timing")) };
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) throw statusError(res.status, path, body, text);
    return { res, body, text, timing };
  }

  function statusError(status: number, path: string, body: unknown, text: string): JevError {
    const detail = typeof body === "object" && body && "detail" in body ? JSON.stringify((body as { detail: unknown }).detail) : text.slice(0, 200);
    if (status === 401 || status === 403) {
      return new JevError(
        config.apiKey ? "Clé API refusée par JEV." : "JEV exige une clé API et aucune n'est configurée.",
        "unauthorized",
        "Vérifier JEV_API_KEY sur le serveur (/etc/jev/jev.env) et la clé saisie dans l'administration.",
        status,
      );
    }
    if (status === 422) {
      return new JevError(`Requête refusée par JEV (422) : ${detail}`, "unsupported", "Seules les questions de type « noul » (oui/non) sont prises en charge.", status);
    }
    if (status === 404) {
      return new JevError(`Route ${path} introuvable (404).`, "http_error", "Ce serveur n'est probablement pas JEV, ou sa version est incompatible.", status);
    }
    return new JevError(`JEV a répondu ${status} sur ${path}${detail ? ` : ${detail}` : ""}.`, "http_error", status >= 500 ? "Erreur interne de JEV : consulter `journalctl -u jev` sur le serveur." : undefined, status);
  }

  function malformed(path: string, text: string): JevError {
    return new JevError(`Réponse mal formée sur ${path} : ${text.slice(0, 160) || "(vide)"}`, "bad_response", "Le serveur ne parle pas l'API JEV attendue : vérifier l'hôte, le port et la version de jevos.");
  }

  return {
    baseUrl: base,

    /** GET /health (sans clé, comme le prévoit JEV). */
    async health(signal?: AbortSignal): Promise<JevHealth> {
      const { body, text, timing } = await request("GET", "/health", { auth: false, signal });
      const parsed = healthSchema.safeParse(body);
      if (!parsed.success) throw malformed("/health", text);
      return { status: parsed.data.status, ready: parsed.data.status === "ready", timing, raw: parsed.data };
    },

    /** GET /v1/models ; `auth: false` envoie la requête sans clé (vérification du refus). */
    async models(opts: { auth?: boolean; signal?: AbortSignal } = {}): Promise<JevModels> {
      const { body, text, timing } = await request("GET", "/v1/models", opts);
      const parsed = modelsSchema.safeParse(body);
      if (!parsed.success) throw malformed("/v1/models", text);
      return { ids: parsed.data, timing };
    },

    /** POST /v1/systemone avec une ou plusieurs questions oui/non. */
    async decide(state: string | Record<string, unknown>, questions: JevQuestion[], opts: { model?: string; signal?: AbortSignal } = {}): Promise<JevDecision> {
      if (!questions.length) throw new JevError("Aucune question fournie.", "bad_response");
      const payload = {
        model: opts.model ?? JEV_DEFAULT_MODEL,
        state,
        questions: Object.fromEntries(questions.map((q) => [q.name, { type: "noul", instructions: q.instructions }])),
      };
      const { body, text, timing } = await request("POST", "/v1/systemone", { body: payload, signal: opts.signal });
      const parsed = decisionSchema.safeParse(body);
      if (!parsed.success) throw malformed("/v1/systemone", text);
      const answers: Record<string, number> = {};
      for (const q of questions) {
        const a = parsed.data.answers[q.name];
        if (!a) throw new JevError(`Réponse incomplète : pas de probabilité pour « ${q.name} ».`, "bad_response");
        answers[q.name] = a.noul;
      }
      return { model: parsed.data.model ?? payload.model, answers, usage: parsed.data.usage, timing };
    },
  };
}

export type JevClient = ReturnType<typeof createJevClient>;
