import { afterEach, describe, expect, it } from "vitest";
import { describeNetworkError, normalizeBaseUrl } from "@/lib/llm/url";
import { apiRoot } from "@/lib/llm/openai-compatible";

describe("Validation des URL de fournisseur", () => {
  it("normalise et ajoute le schéma", () => {
    expect(normalizeBaseUrl("192.168.1.20:11434")).toEqual({ ok: true, url: "http://192.168.1.20:11434" });
    expect(normalizeBaseUrl("http://host.docker.internal:11434/")).toEqual({ ok: true, url: "http://host.docker.internal:11434" });
    expect(normalizeBaseUrl("https://llm.lan/v1/")).toEqual({ ok: true, url: "https://llm.lan/v1" });
  });
  it("refuse les schémas, identifiants et hôtes dangereux", () => {
    expect(normalizeBaseUrl("file:///etc/passwd").ok).toBe(false);
    expect(normalizeBaseUrl("http://user:pass@host:1234").ok).toBe(false);
    expect(normalizeBaseUrl("http://169.254.169.254/latest").ok).toBe(false);
    expect(normalizeBaseUrl("http://host:1/?x=1").ok).toBe(false);
    expect(normalizeBaseUrl("").ok).toBe(false);
  });
  it("applique la liste blanche AI_URL_ALLOWLIST", () => {
    expect(normalizeBaseUrl("http://10.0.0.5:11434", "10.0.0.5, localhost").ok).toBe(true);
    expect(normalizeBaseUrl("http://10.0.0.6:11434", "10.0.0.5").ok).toBe(false);
  });
  it("construit la racine de l'API OpenAI", () => {
    expect(apiRoot("http://localhost:1234")).toBe("http://localhost:1234/v1");
    expect(apiRoot("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1");
  });
});

describe("Diagnostic des erreurs réseau", () => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  afterEach(() => {
    delete process.env.IATRANO_IN_DOCKER;
  });

  it("explique localhost dans un conteneur", () => {
    process.env.IATRANO_IN_DOCKER = "true";
    const e = describeNetworkError(refused, "http://localhost:11434", 1000);
    expect(e.code).toBe("unreachable");
    expect(e.hint).toContain("host.docker.internal");
  });
  it("explique OLLAMA_HOST quand l'hôte refuse la connexion", () => {
    const e = describeNetworkError(refused, "http://host.docker.internal:11434", 1000);
    expect(e.hint).toContain("OLLAMA_HOST=0.0.0.0");
  });
  it("traduit les erreurs DNS et les délais", () => {
    const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    expect(describeNetworkError(dns, "http://serveur-ia:11434", 1000).message).toContain("introuvable");
    const t = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(describeNetworkError(t, "http://x:1", 5000).code).toBe("timeout");
  });
});
