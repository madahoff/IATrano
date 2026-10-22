import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Faux serveur JEV (HTTP réel sur un port aléatoire) dont le comportement est réglable par test.

export type FakeJevOptions = {
  apiKey?: string | null;
  healthStatus?: string;
  healthDelayMs?: number;
  decideDelayMs?: number;
  models?: string[];
  /** Probabilité renvoyée pour chaque question, selon son nom (défaut 0.9). */
  noul?: (name: string, state: string) => number;
  malformedDecision?: boolean;
  serverTiming?: string | null;
};

export type FakeJev = {
  port: number;
  url: string;
  requests: Array<{ method: string; path: string; auth: string | null; body: unknown }>;
  options: FakeJevOptions;
  close: () => Promise<void>;
};

function send(res: ServerResponse, status: number, body: unknown, timing: string | null | undefined) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (timing) headers["server-timing"] = timing;
  res.writeHead(status, headers);
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return raw;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeJev(options: FakeJevOptions = {}): Promise<FakeJev> {
  const state: FakeJev = { port: 0, url: "", requests: [], options, close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    const o = state.options;
    const body = await readBody(req);
    const auth = req.headers.authorization ?? null;
    state.requests.push({ method: req.method ?? "", path: req.url ?? "", auth, body });
    const timing = o.serverTiming === undefined ? "inference;dur=42.5" : o.serverTiming;
    const authorized = !o.apiKey || auth === `Bearer ${o.apiKey}`;

    if (req.url === "/health") {
      if (o.healthDelayMs) await sleep(o.healthDelayMs);
      return send(res, 200, { status: o.healthStatus ?? "ready", model_sha256: "abc123" }, timing);
    }
    if (!authorized) return send(res, 401, { detail: "invalid api key" }, null);
    if (req.url === "/v1/models") {
      return send(res, 200, { object: "list", data: (o.models ?? ["jevos-1b", "jev-latest"]).map((id) => ({ id, object: "model" })) }, null);
    }
    if (req.url === "/v1/systemone" && req.method === "POST") {
      if (o.decideDelayMs) await sleep(o.decideDelayMs);
      if (o.malformedDecision) return send(res, 200, "<html>proxy error</html>", timing);
      const b = body as { state: string; questions: Record<string, { type: string; instructions: string }> };
      for (const q of Object.values(b.questions)) if (q.type !== "noul") return send(res, 422, { detail: "only noul supported" }, null);
      const answers = Object.fromEntries(Object.keys(b.questions).map((name) => [name, { type: "noul", noul: o.noul ? o.noul(name, b.state) : 0.9 }]));
      return send(res, 200, { model: "jevos-1b-q4_k_m", answers, usage: { input_tokens: 30, output_tokens: 0 } }, timing);
    }
    send(res, 404, { detail: "not found" }, null);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.port = (server.address() as AddressInfo).port;
  state.url = `http://127.0.0.1:${state.port}`;
  state.close = () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return state;
}

/** Port local sur lequel rien n'écoute (ouvert puis refermé). */
export async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
