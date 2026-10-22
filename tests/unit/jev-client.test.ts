// Client JEV : fetch simulé (formats, erreurs) et faux serveur HTTP (délais, en-têtes, authentification).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevClient, JevError, parseServerTiming } from "@/lib/jev/client";
import { hostError, jevBaseUrl, jevConnectionSchema } from "@/lib/jev/config";
import { openSecret, sealSecret } from "@/lib/crypto/secret-box";
import { closedPort, startFakeJev, type FakeJev } from "../support/fake-jev";

let fake: FakeJev | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
  vi.unstubAllGlobals();
});

const mockFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) =>
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as unknown as typeof fetch;

describe("createJevClient (fetch simulé)", () => {
  it("envoie la requête systemone attendue et renvoie les probabilités", async () => {
    let sent: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const f = mockFetch((url, init) => {
      sent = { url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ model: "jevos-v5", answers: { billing: { type: "noul", noul: 0.97 }, refund: { type: "noul", noul: 0.12 } }, usage: { input_tokens: 28 } }), {
        headers: { "server-timing": "inference;dur=31.2" },
      });
    });
    const client = createJevClient({ baseUrl: "http://jev:8017/", apiKey: "k-secret", timeoutMs: 1000 }, { fetch: f });
    const d = await client.decide("I was charged twice.", [
      { name: "billing", instructions: "Is this a billing problem?" },
      { name: "refund", instructions: "Does the user ask for a refund?" },
    ]);
    expect(sent!.url).toBe("http://jev:8017/v1/systemone");
    expect(sent!.headers.authorization).toBe("Bearer k-secret");
    expect(sent!.body).toEqual({
      model: "jev-latest",
      state: "I was charged twice.",
      questions: { billing: { type: "noul", instructions: "Is this a billing problem?" }, refund: { type: "noul", instructions: "Does the user ask for a refund?" } },
    });
    expect(d.answers).toEqual({ billing: 0.97, refund: 0.12 });
    expect(d.model).toBe("jevos-v5");
    expect(d.timing.serverMs).toBe(31.2);
  });

  it("n'envoie jamais la clé sur /health", async () => {
    let auth: string | undefined;
    const f = mockFetch((_url, init) => {
      auth = (init?.headers as Record<string, string>).authorization;
      return Response.json({ status: "loading" });
    });
    const h = await createJevClient({ baseUrl: "http://jev:8017", apiKey: "k", timeoutMs: 1000 }, { fetch: f }).health();
    expect(auth).toBeUndefined();
    expect(h).toMatchObject({ status: "loading", ready: false });
  });

  it("accepte les deux formats de /v1/models", async () => {
    const a = createJevClient({ baseUrl: "http://jev", apiKey: null, timeoutMs: 1000 }, { fetch: mockFetch(() => Response.json({ data: [{ id: "jev-latest" }] })) });
    const b = createJevClient({ baseUrl: "http://jev", apiKey: null, timeoutMs: 1000 }, { fetch: mockFetch(() => Response.json({ models: ["jevos-1b", { name: "jev-latest" }] })) });
    expect((await a.models()).ids).toEqual(["jev-latest"]);
    expect((await b.models()).ids).toEqual(["jevos-1b", "jev-latest"]);
  });

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [422, "unsupported"],
    [404, "http_error"],
    [500, "http_error"],
  ])("traduit le statut HTTP %i en erreur « %s »", async (status, code) => {
    const client = createJevClient({ baseUrl: "http://jev", apiKey: "k", timeoutMs: 1000 }, { fetch: mockFetch(() => Response.json({ detail: "x" }, { status })) });
    await expect(client.decide("x", [{ name: "q", instructions: "Q?" }])).rejects.toMatchObject({ code });
  });

  it("rejette une réponse mal formée ou incomplète", async () => {
    const bad = createJevClient({ baseUrl: "http://jev", apiKey: null, timeoutMs: 1000 }, { fetch: mockFetch(() => new Response("<html>oops</html>")) });
    await expect(bad.decide("x", [{ name: "q", instructions: "Q?" }])).rejects.toMatchObject({ code: "bad_response" });
    const outOfRange = createJevClient({ baseUrl: "http://jev", apiKey: null, timeoutMs: 1000 }, { fetch: mockFetch(() => Response.json({ answers: { q: { noul: 1.7 } } })) });
    await expect(outOfRange.decide("x", [{ name: "q", instructions: "Q?" }])).rejects.toMatchObject({ code: "bad_response" });
    const missing = createJevClient({ baseUrl: "http://jev", apiKey: null, timeoutMs: 1000 }, { fetch: mockFetch(() => Response.json({ answers: { other: { noul: 0.5 } } })) });
    await expect(missing.decide("x", [{ name: "q", instructions: "Q?" }])).rejects.toThrow(/pas de probabilité pour « q »/);
  });

  it("traduit les erreurs réseau avec une piste de correction", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const client = createJevClient({ baseUrl: "http://jev:8017", apiKey: null, timeoutMs: 1000 }, { fetch: mockFetch(() => Promise.reject(refused)) });
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect(err.code).toBe("unreachable");
    expect(err.hint).toMatch(/systemctl status jev/);
  });
});

describe("createJevClient (faux serveur HTTP)", () => {
  it("respecte le délai d'attente", async () => {
    fake = await startFakeJev({ decideDelayMs: 500 });
    const client = createJevClient({ baseUrl: fake.url, apiKey: null, timeoutMs: 100 });
    const err = await client.decide("x", [{ name: "q", instructions: "Q?" }]).catch((e) => e);
    expect(err).toMatchObject({ code: "timeout" });
    expect(err.message).toMatch(/0,1 s|0.1 s/);
  });

  it("signale un port fermé comme injoignable", async () => {
    const client = createJevClient({ baseUrl: `http://127.0.0.1:${await closedPort()}`, apiKey: null, timeoutMs: 1000 });
    await expect(client.health()).rejects.toMatchObject({ code: "unreachable" });
  });

  it("mesure la latence et lit Server-Timing", async () => {
    fake = await startFakeJev({ serverTiming: "inference;dur=12.5, total;dur=20" });
    const d = await createJevClient({ baseUrl: fake.url, apiKey: null, timeoutMs: 2000 }).decide("x", [{ name: "q", instructions: "Q?" }]);
    expect(d.timing.serverMs).toBe(12.5);
    expect(d.timing.totalMs).toBeGreaterThanOrEqual(0);
  });
});

describe("parseServerTiming", () => {
  it.each([
    [null, null],
    ["", null],
    ["inference;dur=42.5", 42.5],
    ['total;dur=50, infer;desc="model";dur=31', 31],
    ["db;dur=5", 5],
    ["cache;desc=hit", null],
  ])("%s → %s", (header, expected) => expect(parseServerTiming(header)).toBe(expected));
});

describe("validation de la configuration", () => {
  it.each([
    ["100.121.17.90", null],
    ["jev-server.tail1234.ts.net", null],
    ["fd7a:115c:a1e0::1", null],
    ["", "obligatoire"],
    ["300.1.1.1", "IPv4"],
    ["10.0.0", "IPv4"],
    ["http://100.121.17.90", "http://"],
    ["100.121.17.90:8017", "Port"],
    ["serveur jev", "uniquement l'hôte"],
    ["169.254.169.254", "interdite"],
    ["-bad-.host", "invalide"],
  ])("hôte %j", (host, expected) => {
    const e = hostError(host);
    if (expected === null) expect(e).toBeNull();
    else expect(e).toContain(expected);
  });

  it("borne le port, le délai et le seuil", () => {
    const base = { host: "100.121.17.90", port: 8017, protocol: "HTTP" as const, timeoutSec: 10, defaultThreshold: 0.5 };
    expect(jevConnectionSchema.safeParse(base).success).toBe(true);
    for (const bad of [{ port: 0 }, { port: 65536 }, { port: 80.5 }, { timeoutSec: 0 }, { timeoutSec: -1 }, { defaultThreshold: 1.2 }, { defaultThreshold: -0.1 }]) {
      expect(jevConnectionSchema.safeParse({ ...base, ...bad }).success).toBe(false);
    }
  });

  it("construit l'URL de base (IPv6 entre crochets)", () => {
    expect(jevBaseUrl({ protocol: "HTTP", host: "100.121.17.90", port: 8017 })).toBe("http://100.121.17.90:8017");
    expect(jevBaseUrl({ protocol: "HTTPS", host: "fd7a::1", port: 443 })).toBe("https://[fd7a::1]:443");
  });
});

describe("chiffrement de la clé", () => {
  it("chiffre de façon non déterministe et déchiffre avec le même secret uniquement", () => {
    const master = "m".repeat(40);
    const a = sealSecret("ma-cle-jev", master, "jev-api-key");
    const b = sealSecret("ma-cle-jev", master, "jev-api-key");
    expect(a).not.toBe(b);
    expect(a).not.toContain("ma-cle-jev");
    expect(openSecret(a, master, "jev-api-key")).toBe("ma-cle-jev");
    expect(openSecret(a, "autre-secret".repeat(4), "jev-api-key")).toBeNull();
    expect(openSecret(a, master, "autre-usage")).toBeNull();
    expect(openSecret("v1:corrompu", master, "jev-api-key")).toBeNull();
  });
});
