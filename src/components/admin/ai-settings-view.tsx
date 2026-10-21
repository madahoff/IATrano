"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, CheckCircle2, Info, Loader2, PlugZap, Radar, RefreshCw, Save, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Panel, Section } from "@/components/layout/page-shell";
import { api, ApiError } from "@/lib/client/api";
import { formatBytes } from "@/lib/format";
import type { PublicAppSettings } from "@/lib/settings/service";
import type { ConnectionTest, ModelInfo, ProviderKind } from "@/lib/llm/types";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/llm/prompt";

type Detection = { kind: ProviderKind; baseUrl: string; ok: boolean; version?: string; modelCount?: number; models?: string[]; error?: string };

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function AiSettingsView({ initial, inDocker }: { initial: PublicAppSettings; inDocker: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [providerType, setProviderType] = useState<ProviderKind>(initial.providerType);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [timeoutSec, setTimeoutSec] = useState(String(Math.round(initial.requestTimeoutMs / 1000)));
  const [savingConn, setSavingConn] = useState(false);

  const [test, setTest] = useState<{ result: ConnectionTest; models: ModelInfo[] } | null>(null);
  const [testing, setTesting] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detections, setDetections] = useState<Detection[] | null>(null);

  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState<{ error?: string; hint?: string } | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);

  const [defaultModel, setDefaultModel] = useState(initial.defaultModel ?? "none");
  const [thinkingDefault, setThinkingDefault] = useState(initial.thinkingDefault);
  const [clarifications, setClarifications] = useState(initial.clarificationsEnabled);
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt);
  const [savingPrefs, setSavingPrefs] = useState(false);

  const dirtyConn = providerType !== saved.providerType || baseUrl !== saved.baseUrl || apiKey !== "" || clearKey || Number(timeoutSec) * 1000 !== saved.requestTimeoutMs;

  const fetchModels = useCallback(
    (refresh: boolean) =>
      api<{ models: ModelInfo[]; provider: { reachable: boolean; error?: string; hint?: string } }>(`/api/models${refresh ? "?refresh=1" : ""}`)
        .then((d) => {
          setModels(d.models);
          setModelsError(d.provider.reachable ? null : { error: d.provider.error, hint: d.provider.hint });
        })
        .catch((err) => setModelsError({ error: errMsg(err, "Chargement impossible.") })),
    [],
  );
  const loadModels = useCallback(
    async (refresh = false) => {
      setModelsLoading(true);
      await fetchModels(refresh);
      setModelsLoading(false);
    },
    [fetchModels],
  );
  useEffect(() => {
    void fetchModels(false);
  }, [fetchModels]);

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api("/api/admin/ai/test", { method: "POST", json: { providerType, baseUrl, apiKey: clearKey ? "" : apiKey || undefined } }));
    } catch (err) {
      toast.error(errMsg(err, "Test impossible."));
    } finally {
      setTesting(false);
    }
  }

  async function runDetect() {
    setDetecting(true);
    try {
      const d = await api<{ results: Detection[] }>("/api/admin/ai/detect", { method: "POST" });
      setDetections(d.results);
    } catch (err) {
      toast.error(errMsg(err, "Détection impossible."));
    } finally {
      setDetecting(false);
    }
  }

  async function saveConnection() {
    const t = Number(timeoutSec);
    if (!Number.isFinite(t) || t < 5 || t > 900) {
      toast.error("Le délai doit être compris entre 5 et 900 secondes.");
      return;
    }
    setSavingConn(true);
    try {
      const { settings } = await api<{ settings: PublicAppSettings }>("/api/admin/settings", {
        method: "PATCH",
        json: { providerType, baseUrl, requestTimeoutMs: t * 1000, ...(clearKey ? { apiKey: "" } : apiKey ? { apiKey } : {}) },
      });
      setSaved(settings);
      setBaseUrl(settings.baseUrl);
      setApiKey("");
      setClearKey(false);
      toast.success("Connexion enregistrée.");
      void loadModels(true);
    } catch (err) {
      toast.error(errMsg(err, "Enregistrement impossible."));
    } finally {
      setSavingConn(false);
    }
  }

  async function savePreferences() {
    setSavingPrefs(true);
    try {
      const { settings } = await api<{ settings: PublicAppSettings }>("/api/admin/settings", {
        method: "PATCH",
        json: { defaultModel: defaultModel === "none" ? null : defaultModel, thinkingDefault, clarificationsEnabled: clarifications, systemPrompt },
      });
      setSaved(settings);
      toast.success("Préférences enregistrées.");
    } catch (err) {
      toast.error(errMsg(err, "Enregistrement impossible."));
    } finally {
      setSavingPrefs(false);
    }
  }

  const defaultMissing = defaultModel !== "none" && models !== null && !models.some((m) => m.id === defaultModel);

  return (
    <>
      <Section title="Connexion au moteur IA" description="C'est le serveur IATrano (et non le navigateur) qui contacte le moteur IA à cette adresse.">
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_1fr]">
            <Field label="Type de fournisseur">
              <Select value={providerType} onValueChange={(v) => setProviderType(v as ProviderKind)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="OLLAMA">Ollama</SelectItem>
                  <SelectItem value="OPENAI_COMPATIBLE">Compatible OpenAI</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Adresse du serveur IA (hôte ou IP + port)" htmlFor="baseUrl" hint={providerType === "OLLAMA" ? "Ex. http://localhost:11434 · http://host.docker.internal:11434 · http://192.168.1.20:11434" : "Ex. http://localhost:1234/v1 (LM Studio) · http://192.168.1.20:8080/v1 (llama.cpp)"}>
              <Input id="baseUrl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} autoCapitalize="off" className="font-mono text-sm" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_minmax(0,14rem)]">
            <Field label="Clé d'API (facultative)" htmlFor="apiKey" hint={saved.hasApiKey ? "Une clé est enregistrée. Laissez vide pour la conserver." : "Uniquement si votre serveur compatible OpenAI exige une clé. Elle n'est jamais renvoyée au navigateur."}>
              <div className="flex gap-2">
                <Input id="apiKey" type="password" autoComplete="off" value={apiKey} placeholder={saved.hasApiKey && !clearKey ? "••••••••" : ""} onChange={(e) => { setApiKey(e.target.value); setClearKey(false); }} />
                {saved.hasApiKey && (
                  <Button type="button" variant="ghost" onClick={() => { setClearKey(true); setApiKey(""); }} disabled={clearKey}>Supprimer</Button>
                )}
              </div>
            </Field>
            <Field label="Délai d'attente (s)" htmlFor="timeout" hint="Inclut le chargement du modèle en mémoire.">
              <Input id="timeout" type="number" min={5} max={900} value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={runTest} disabled={testing}>{testing ? <Loader2 className="animate-spin" /> : <PlugZap />} Tester la connexion</Button>
            <Button variant="secondary" onClick={runDetect} disabled={detecting}>{detecting ? <Loader2 className="animate-spin" /> : <Radar />} Détecter automatiquement</Button>
            <Button onClick={saveConnection} disabled={savingConn || !dirtyConn}>{savingConn ? <Loader2 className="animate-spin" /> : <Save />} Enregistrer</Button>
          </div>

          {test && (
            <Panel className={test.result.ok ? "" : "bg-destructive/10"}>
              <p className="flex items-center gap-2 font-medium">
                {test.result.ok ? <CheckCircle2 className="size-5 text-success" /> : <XCircle className="size-5 text-destructive" />}
                {test.result.ok ? `Connexion réussie en ${test.result.latencyMs} ms` : test.result.error}
              </p>
              {test.result.ok && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {test.result.version ? `Version ${test.result.version} · ` : ""}{test.models.length} modèle(s) : {test.models.map((m) => m.id).join(", ") || "aucun"}
                </p>
              )}
              {test.result.hint && <p className="mt-1 text-sm text-muted-foreground">{test.result.hint}</p>}
              {test.result.ok && dirtyConn && <p className="mt-2 text-sm">N&apos;oubliez pas d&apos;enregistrer cette configuration.</p>}
            </Panel>
          )}

          {detections && (
            <Panel>
              <p className="mb-3 text-sm font-medium">Résultat de la détection (depuis le serveur{inDocker ? ", dans Docker" : ""})</p>
              <ul className="flex flex-col gap-2">
                {detections.filter((d) => d.ok).map((d) => (
                  <li key={d.kind + d.baseUrl} className="flex flex-wrap items-center gap-3 rounded-2xl bg-background px-4 py-3 text-sm">
                    <CheckCircle2 className="size-4 text-success" />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{d.kind === "OLLAMA" ? "Ollama" : "Compatible OpenAI"}</span> · <span className="font-mono">{d.baseUrl}</span>
                      <span className="block text-xs text-muted-foreground">{d.modelCount} modèle(s){d.models?.length ? ` : ${d.models.join(", ")}` : ""}</span>
                    </span>
                    <Button size="sm" variant="secondary" onClick={() => { setProviderType(d.kind); setBaseUrl(d.baseUrl); }}>Utiliser</Button>
                  </li>
                ))}
              </ul>
              {detections.every((d) => !d.ok) && (
                <p className="text-sm text-muted-foreground">
                  Aucun moteur trouvé sur les adresses usuelles ({[...new Set(detections.map((d) => new URL(d.baseUrl).host))].join(", ")}). Si le moteur tourne sur une autre machine, saisissez son adresse IP puis testez.
                </p>
              )}
            </Panel>
          )}

          <Panel className="flex gap-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <div className="flex flex-col gap-1.5">
              <p><strong className="text-foreground">Deux adresses distinctes.</strong> L&apos;adresse saisie dans votre navigateur pour ouvrir IATrano n&apos;a aucun lien avec celle-ci, qui est utilisée par le serveur pour joindre le moteur IA.</p>
              {inDocker ? (
                <p>IATrano tourne <strong className="text-foreground">dans Docker</strong> : ici, <code>localhost</code> désigne le conteneur. Pour un moteur installé sur la machine hôte, utilisez <code>http://host.docker.internal:11434</code>, et faites écouter Ollama sur toutes les interfaces (<code>OLLAMA_HOST=0.0.0.0:11434</code>). Pour une autre machine du réseau, utilisez son IP.</p>
              ) : (
                <p>IATrano tourne <strong className="text-foreground">hors Docker</strong> : <code>http://localhost:11434</code> convient si Ollama est sur la même machine. Pour une autre machine, utilisez son IP et faites écouter le moteur sur le réseau.</p>
              )}
            </div>
          </Panel>
        </div>
      </Section>

      <Section
        title="Modèles disponibles"
        description="Liste réellement exposée par le serveur configuré."
        actions={<Button variant="secondary" size="sm" onClick={() => loadModels(true)} disabled={modelsLoading}>{modelsLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Actualiser</Button>}
      >
        {modelsError && (
          <Panel className="mb-3 bg-destructive/10 text-sm">
            <p className="font-medium text-destructive">{modelsError.error ?? "Serveur IA injoignable."}</p>
            {modelsError.hint && <p className="mt-1 text-muted-foreground">{modelsError.hint}</p>}
          </Panel>
        )}
        {models && models.length === 0 && !modelsError && <p className="text-sm text-muted-foreground">Aucun modèle exposé par le serveur.</p>}
        <ul className="flex flex-col gap-2">
          {models?.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-2xl bg-muted px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{m.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {[m.family, m.parameterSize, m.quantization, formatBytes(m.sizeBytes), m.contextLength ? `contexte ${m.contextLength.toLocaleString("fr-FR")}` : null].filter(Boolean).join(" · ") || "Métadonnées non fournies par le serveur"}
                </span>
              </span>
              {m.capabilities.thinking === "yes" && <Badge variant="success"><Brain /> Thinking</Badge>}
              {m.capabilities.thinking === "no" && <Badge variant="secondary">Sans Thinking</Badge>}
              {m.capabilities.thinking === "unknown" && <Badge variant="secondary">Thinking non déclaré</Badge>}
              {saved.defaultModel === m.id && <Badge>Par défaut</Badge>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Préférences globales" description="Valeurs par défaut pour tous les utilisateurs (chacun peut les remplacer dans ses paramètres).">
        <div className="flex flex-col gap-5">
          <Field label="Modèle par défaut" hint={defaultMissing ? <span className="text-warning-foreground">Ce modèle n&apos;est plus détecté sur le serveur.</span> : "Utilisé pour les nouvelles conversations."}>
            <Select value={defaultModel} onValueChange={setDefaultModel}>
              <SelectTrigger className="w-full sm:w-96"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Aucun (premier modèle détecté)</SelectItem>
                {defaultMissing && <SelectItem value={defaultModel}>{defaultModel} (indisponible)</SelectItem>}
                {models?.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <label className="flex items-center justify-between gap-4 rounded-2xl bg-muted px-4 py-3">
            <span>
              <span className="block text-sm font-medium">Thinking activé par défaut</span>
              <span className="block text-xs text-muted-foreground">Ignoré pour les modèles qui ne prennent pas en charge le raisonnement.</span>
            </span>
            <Switch checked={thinkingDefault} onCheckedChange={setThinkingDefault} />
          </label>
          <label className="flex items-center justify-between gap-4 rounded-2xl bg-muted px-4 py-3">
            <span>
              <span className="block text-sm font-medium">Questions de précision</span>
              <span className="block text-xs text-muted-foreground">Le modèle peut proposer des questions à choix lorsque la demande est ambiguë.</span>
            </span>
            <Switch checked={clarifications} onCheckedChange={setClarifications} />
          </label>
          <Field label="Instructions système" htmlFor="sys" hint="Laissez vide pour utiliser les instructions par défaut.">
            <Textarea id="sys" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder={DEFAULT_SYSTEM_PROMPT} rows={5} className="text-sm" />
          </Field>
          <div>
            <Button onClick={savePreferences} disabled={savingPrefs}>{savingPrefs ? <Loader2 className="animate-spin" /> : <Save />} Enregistrer</Button>
          </div>
        </div>
      </Section>
    </>
  );
}
