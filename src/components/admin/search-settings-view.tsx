"use client";

import { useState } from "react";
import { CheckCircle2, FlaskConical, Info, Loader2, Save, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Panel, Section } from "@/components/layout/page-shell";
import { api, ApiError } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { PublicAppSettings } from "@/lib/settings/service";

type Kind = "SEARXNG" | "BRAVE";
type TestResult =
  | {
      ok: true;
      provider: string;
      latencyMs: number;
      resultCount: number;
      results: Array<{ title: string; url: string; engine: string | null; publishedAt: string | null }>;
      pages: Array<{ url: string; ok: boolean; chars?: number; title?: string | null; error?: string; ms: number }>;
    }
  | { ok: false; latencyMs: number; error: string; hint?: string };

type LogRow = { id: string; level: string; source: string; message: string; createdAt: string };

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function SearchSettingsView({ initial, inDocker, recentErrors }: { initial: PublicAppSettings; inDocker: boolean; recentErrors: LogRow[] }) {
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.webSearchEnabled);
  const [autoDefault, setAutoDefault] = useState(initial.webSearchAutoDefault);
  const [provider, setProvider] = useState<Kind>(initial.searchProvider);
  const [searxngUrl, setSearxngUrl] = useState(initial.searxngUrl);
  const [braveKey, setBraveKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [fallback, setFallback] = useState(initial.searchFallbackEnabled);
  const [maxResults, setMaxResults] = useState(String(initial.searchMaxResults));
  const [maxPages, setMaxPages] = useState(String(initial.searchMaxPages));
  const [timeoutSec, setTimeoutSec] = useState(String(Math.round(initial.searchTimeoutMs / 1000)));
  const [cacheMin, setCacheMin] = useState(String(Math.round(initial.searchCacheTtlSec / 60)));
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("dernière version de Next.js");
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  async function save() {
    const n = { maxResults: Number(maxResults), maxPages: Number(maxPages), timeout: Number(timeoutSec), cache: Number(cacheMin) };
    if (!(n.maxResults >= 1 && n.maxResults <= 20)) return toast.error("Résultats par requête : entre 1 et 20.");
    if (!(n.maxPages >= 1 && n.maxPages <= 8)) return toast.error("Pages consultées : entre 1 et 8.");
    if (!(n.timeout >= 5 && n.timeout <= 60)) return toast.error("Durée maximale : entre 5 et 60 secondes.");
    if (!(n.cache >= 0 && n.cache <= 1440)) return toast.error("Cache : entre 0 et 1440 minutes.");
    setSaving(true);
    try {
      const { settings } = await api<{ settings: PublicAppSettings }>("/api/admin/settings", {
        method: "PATCH",
        json: {
          webSearchEnabled: enabled,
          webSearchAutoDefault: autoDefault,
          searchProvider: provider,
          searxngUrl,
          searchFallbackEnabled: fallback,
          ...(clearKey ? { braveApiKey: "" } : braveKey ? { braveApiKey: braveKey } : {}),
          searchMaxResults: n.maxResults,
          searchMaxPages: n.maxPages,
          searchTimeoutMs: n.timeout * 1000,
          searchCacheTtlSec: n.cache * 60,
        },
      });
      setSaved(settings);
      setSearxngUrl(settings.searxngUrl);
      setBraveKey("");
      setClearKey(false);
      toast.success("Recherche Web enregistrée.");
    } catch (err) {
      toast.error(errMsg(err, "Enregistrement impossible."));
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(
        await api<TestResult>("/api/admin/search/test", {
          method: "POST",
          json: { searchProvider: provider, searxngUrl, query, searchFallbackEnabled: fallback, ...(clearKey ? { braveApiKey: "" } : braveKey ? { braveApiKey: braveKey } : {}) },
        }),
      );
    } catch (err) {
      toast.error(errMsg(err, "Test impossible."));
    } finally {
      setTesting(false);
    }
  }

  const keySource = saved.hasBraveApiKey ? "Une clé est enregistrée. Laissez vide pour la conserver." : saved.braveApiKeyFromEnv ? "Clé fournie par BRAVE_SEARCH_API_KEY (environnement)." : "Clé de l'API Brave Search (offre gratuite disponible). Jamais renvoyée au navigateur.";

  return (
    <>
      <Section title="Recherche Web" description="Le serveur IATrano recherche sur Internet, lit les pages utiles et transmet les extraits pertinents au modèle, avec citations vérifiées.">
        <div className="flex flex-col gap-4">
          {!saved.searchConfigured && (
            <Panel className="flex gap-3 bg-warning/15 text-sm">
              <Info className="mt-0.5 size-4 shrink-0" />
              <p>Aucun moteur de recherche n&apos;est configuré : la recherche Web est inactive tant qu&apos;une adresse SearXNG ou une clé Brave n&apos;est pas renseignée.</p>
            </Panel>
          )}
          <label className="flex items-center justify-between gap-4 rounded-2xl bg-muted px-4 py-3">
            <span>
              <span className="block text-sm font-medium">Activer la recherche Web</span>
              <span className="block text-xs text-muted-foreground">Désactivée : aucune recherche n&apos;est effectuée pour aucun utilisateur.</span>
            </span>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </label>
          <label className="flex items-center justify-between gap-4 rounded-2xl bg-muted px-4 py-3">
            <span>
              <span className="block text-sm font-medium">Recherche Web automatique par défaut</span>
              <span className="block text-xs text-muted-foreground">Ancien fonctionnement uniquement : avec le routage JEV, la recherche est décidée à chaque message (Administration → Routage et autorisations).</span>
            </span>
            <Switch checked={autoDefault} onCheckedChange={setAutoDefault} disabled={!enabled} />
          </label>
        </div>
      </Section>

      <Section title="Moteur de recherche" description="C'est le serveur (et non le navigateur) qui interroge le moteur.">
        <div className="flex flex-col gap-4">
          <Field label="Fournisseur">
            <Select value={provider} onValueChange={(v) => setProvider(v as Kind)}>
              <SelectTrigger className="w-full sm:w-80"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="SEARXNG">SearXNG (auto-hébergé, gratuit)</SelectItem>
                <SelectItem value="BRAVE">Brave Search API (clé requise)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {provider === "SEARXNG" ? (
            <Field
              label="Adresse du service SearXNG"
              htmlFor="searxng"
              hint={
                saved.searxngUrlFromEnv
                  ? `Laissez vide pour utiliser SEARXNG_URL (${saved.searxngUrlFromEnv}).`
                  : inDocker
                    ? "Avec le service « searxng » de compose.yaml : http://searxng:8080"
                    : "Ex. http://localhost:8888 · http://192.168.1.20:8080 — le format json doit être activé dans settings.yml."
              }
            >
              <Input id="searxng" value={searxngUrl} onChange={(e) => setSearxngUrl(e.target.value)} placeholder={saved.searxngUrlFromEnv ?? "http://searxng:8080"} spellCheck={false} autoCapitalize="off" className="font-mono text-sm" />
            </Field>
          ) : (
            <Field label="Clé d'API Brave Search" htmlFor="brave" hint={keySource}>
              <div className="flex gap-2">
                <Input id="brave" type="password" autoComplete="off" value={braveKey} placeholder={saved.hasBraveApiKey && !clearKey ? "••••••••" : ""} onChange={(e) => { setBraveKey(e.target.value); setClearKey(false); }} />
                {saved.hasBraveApiKey && <Button type="button" variant="ghost" onClick={() => { setClearKey(true); setBraveKey(""); }} disabled={clearKey}>Supprimer</Button>}
              </div>
            </Field>
          )}
          {provider === "SEARXNG" && (
            <Panel className="flex flex-col gap-3">
              <label className="flex items-center justify-between gap-4">
                <span>
                  <span className="block text-sm font-medium">Basculer sur Brave si SearXNG échoue</span>
                  <span className="block text-xs text-muted-foreground">
                    Si SearXNG est injoignable, trop lent ou ne renvoie rien (moteurs amont bloqués), la même requête part vers l&apos;API Brave Search. Le basculement est signalé dans le détail de la recherche.
                    {!saved.hasBraveApiKey && !saved.braveApiKeyFromEnv && " Inactif tant qu'aucune clé Brave n'est renseignée."}
                  </span>
                </span>
                <Switch checked={fallback} onCheckedChange={setFallback} />
              </label>
              {fallback && <div className="[&_input]:bg-background"><Field label="Clé d'API Brave Search (secours)" htmlFor="brave" hint={keySource}>
              <div className="flex gap-2">
                <Input id="brave" type="password" autoComplete="off" value={braveKey} placeholder={saved.hasBraveApiKey && !clearKey ? "••••••••" : ""} onChange={(e) => { setBraveKey(e.target.value); setClearKey(false); }} />
                {saved.hasBraveApiKey && <Button type="button" variant="ghost" onClick={() => { setClearKey(true); setBraveKey(""); }} disabled={clearKey}>Supprimer</Button>}
              </div>
            </Field></div>}
            </Panel>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Résultats par requête" htmlFor="maxr" hint="1 à 20 — candidats examinés.">
              <Input id="maxr" type="number" min={1} max={20} value={maxResults} onChange={(e) => setMaxResults(e.target.value)} />
            </Field>
            <Field label="Pages consultées au maximum" htmlFor="maxp" hint="1 à 8 — pages téléchargées et lues.">
              <Input id="maxp" type="number" min={1} max={8} value={maxPages} onChange={(e) => setMaxPages(e.target.value)} />
            </Field>
            <Field label="Durée maximale de la recherche (s)" htmlFor="tmo" hint="Au-delà, la réponse est générée avec ce qui a été récupéré.">
              <Input id="tmo" type="number" min={5} max={60} value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} />
            </Field>
            <Field label="Cache des résultats et pages (min)" htmlFor="cache" hint="En mémoire uniquement ; 0 désactive le cache.">
              <Input id="cache" type="number" min={0} max={1440} value={cacheMin} onChange={(e) => setCacheMin(e.target.value)} />
            </Field>
          </div>
          <div>
            <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="animate-spin" /> : <Save />} Enregistrer</Button>
          </div>
        </div>
      </Section>

      <Section title="Tester la connectivité" description="Recherche réelle avec la configuration saisie (même non enregistrée), puis lecture des premières pages.">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Requête de test" />
            <Button variant="secondary" onClick={runTest} disabled={testing || query.trim().length < 2}>{testing ? <Loader2 className="animate-spin" /> : <FlaskConical />} Tester</Button>
          </div>
          {test && (
            <Panel className={test.ok ? "" : "bg-destructive/10"}>
              <p className="flex items-center gap-2 font-medium">
                {test.ok ? <CheckCircle2 className="size-5 text-success" /> : <XCircle className="size-5 text-destructive" />}
                {test.ok ? `${test.provider} : ${test.resultCount} résultat(s) en ${test.latencyMs} ms` : test.error}
              </p>
              {!test.ok && test.hint && <p className="mt-1 text-sm text-muted-foreground">{test.hint}</p>}
              {test.ok && (
                <div className="mt-3 flex flex-col gap-3 text-sm">
                  <ul className="flex flex-col gap-1">
                    {test.results.map((r) => (
                      <li key={r.url} className="truncate"><span className="text-muted-foreground">{r.engine ? `${r.engine} · ` : ""}</span>{r.title || r.url}</li>
                    ))}
                  </ul>
                  <div>
                    <p className="mb-1 font-medium">Lecture des pages : {test.pages.filter((p) => p.ok).length}/{test.pages.length} réussie(s)</p>
                    <ul className="flex flex-col gap-1">
                      {test.pages.map((p) => (
                        <li key={p.url} className="flex min-w-0 items-center gap-2">
                          {p.ok ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <XCircle className="size-4 shrink-0 text-destructive" />}
                          <span className="min-w-0 truncate">{p.url}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{p.ok ? `${p.chars} car. · ${p.ms} ms` : p.error}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </Panel>
          )}
        </div>
      </Section>

      <Section title="Erreurs récentes" description="Derniers incidents liés à la recherche (détails complets dans le Journal).">
        {recentErrors.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune erreur enregistrée.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {recentErrors.map((e) => (
              <li key={e.id} className="rounded-2xl bg-muted px-4 py-2.5 text-sm">
                <span className="block break-words">{e.message}</span>
                <span className="block text-xs text-muted-foreground">{e.source} · {formatDate(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
