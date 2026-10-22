"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Info, Loader2, PlugZap, RotateCcw, Save, Stethoscope } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Field, Panel, Section } from "@/components/layout/page-shell";
import { DiagnosticReportView, TestHistory, type TestRun } from "@/components/admin/diagnostic-report";
import { useJevAutoRefresh } from "@/components/jev/jev-status-pill";
import { api, ApiError } from "@/lib/client/api";
import { jevBaseUrl, jevConnectionSchema, type JevConnectionInput, type JevProtocol } from "@/lib/jev/config";
import type { DiagnosticReport } from "@/lib/diagnostics/report";
import type { PublicJevSettings } from "@/lib/jev/settings";

type Target = "JEV" | "LLM" | "SEARCH";
type FieldName = keyof JevConnectionInput;

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const notifyPill = () => window.dispatchEvent(new Event("jev:refresh"));

const KEY_SOURCE_LABELS: Record<PublicJevSettings["keySource"], string> = {
  admin: "Une clé est enregistrée (chiffrée). Laissez vide pour la conserver.",
  env: "Clé lue depuis JEV_API_KEY du .env. Saisissez-en une pour la remplacer ici.",
  none: "Aucune clé configurée. Saisissez la valeur de JEV_API_KEY du serveur.",
};

function useHistory(target: Target) {
  const [runs, setRuns] = useState<TestRun[] | null>(null);
  const reload = useCallback(
    () =>
      api<{ runs: TestRun[] }>(`/api/admin/connection-tests?target=${target}`)
        .then((d) => setRuns(d.runs))
        .catch(() => setRuns([])),
    [target],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { runs, reload };
}

export function JevConnectionView({ initial }: { initial: PublicJevSettings }) {
  const [saved, setSaved] = useState(initial);
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(String(initial.port));
  const [protocol, setProtocol] = useState<JevProtocol>(initial.protocol);
  const [timeoutSec, setTimeoutSec] = useState(String(initial.timeoutSec));
  const [threshold, setThreshold] = useState(String(initial.defaultThreshold));
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [busy, setBusy] = useState<null | "test" | "save" | "saveTest" | "reset">(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [autoRefresh, setAutoRefresh] = useJevAutoRefresh();
  const jevHistory = useHistory("JEV");

  const dirty =
    host !== saved.host ||
    Number(port) !== saved.port ||
    protocol !== saved.protocol ||
    Number(timeoutSec) !== saved.timeoutSec ||
    Number(threshold.replace(",", ".")) !== saved.defaultThreshold ||
    apiKey !== "" ||
    clearKey;

  function load(s: PublicJevSettings) {
    setSaved(s);
    setHost(s.host);
    setPort(String(s.port));
    setProtocol(s.protocol);
    setTimeoutSec(String(s.timeoutSec));
    setThreshold(String(s.defaultThreshold));
    setApiKey("");
    setClearKey(false);
    setErrors({});
  }

  /** Validation locale (mêmes règles que le serveur) ; renvoie null et affiche les erreurs si invalide. */
  function validate(): JevConnectionInput | null {
    const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));
    const parsed = jevConnectionSchema.safeParse({ host, port: num(port), protocol, timeoutSec: num(timeoutSec), defaultThreshold: num(threshold) });
    if (parsed.success) {
      setErrors({});
      return parsed.data;
    }
    const next: Partial<Record<FieldName, string>> = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path[0] as FieldName;
      next[k] ??= issue.message;
    }
    setErrors(next);
    toast.error("Corrigez les champs signalés.");
    return null;
  }

  const keyPayload = () => (clearKey ? { apiKey: "" } : apiKey.trim() ? { apiKey: apiKey.trim() } : {});

  async function runTest(body: object) {
    setReport(null);
    const { report } = await api<{ report: DiagnosticReport }>("/api/admin/jev/test", { method: "POST", json: body });
    setReport(report);
    void jevHistory.reload();
    notifyPill();
  }

  async function testUnsaved() {
    const c = validate();
    if (!c) return;
    setBusy("test");
    try {
      await runTest({ connection: c, ...keyPayload() });
    } catch (err) {
      toast.error(errMsg(err, "Test impossible."));
    } finally {
      setBusy(null);
    }
  }

  async function save(andTest: boolean) {
    const c = validate();
    if (!c) return;
    setBusy(andTest ? "saveTest" : "save");
    try {
      // Rien à enregistrer : on teste directement la configuration enregistrée.
      if (andTest && !dirty) {
        await runTest({});
        return;
      }
      const { settings } = await api<{ settings: PublicJevSettings }>("/api/admin/jev/settings", { method: "PUT", json: { ...c, ...keyPayload() } });
      load(settings);
      toast.success("Configuration JEV enregistrée.");
      notifyPill();
      if (andTest) await runTest({});
    } catch (err) {
      toast.error(errMsg(err, "Enregistrement impossible."));
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    try {
      const { settings } = await api<{ settings: PublicJevSettings }>("/api/admin/jev/settings/reset", { method: "POST" });
      load(settings);
      toast.success("Valeurs par défaut rétablies.");
      notifyPill();
    } catch (err) {
      toast.error(errMsg(err, "Réinitialisation impossible."));
    } finally {
      setBusy(null);
    }
  }

  const preview = (() => {
    const p = Number(port);
    return host.trim() && Number.isInteger(p) && p > 0 ? jevBaseUrl({ protocol, host, port: p }) : null;
  })();

  return (
    <>
      <Section
        title="Connexion JEV"
        description="JEV renvoie la probabilité d'un « oui » à des questions fermées. C'est le serveur IATrano (et non le navigateur) qui le contacte."
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,8rem)_1fr_minmax(0,11rem)]">
            <Field label="Protocole">
              <Select value={protocol} onValueChange={(v) => setProtocol(v as JevProtocol)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="HTTP">http</SelectItem>
                  <SelectItem value="HTTPS">https</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Hôte (IP ou nom)" htmlFor="jev-host" hint={errors.host ? <span className="text-destructive">{errors.host}</span> : "IP Tailscale du serveur, ex. 100.121.17.90"}>
              <Input id="jev-host" value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} autoCapitalize="off" className="font-mono text-sm" aria-invalid={!!errors.host} />
            </Field>
            <Field label="Port" htmlFor="jev-port" hint={errors.port && <span className="text-destructive">{errors.port}</span>}>
              <Input id="jev-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} className="font-mono text-sm" aria-invalid={!!errors.port} />
            </Field>
          </div>

          <Field
            label="Clé API"
            htmlFor="jev-key"
            hint={
              clearKey ? (
                "La clé enregistrée sera supprimée à l'enregistrement."
              ) : saved.keyUnreadable ? (
                <span className="text-destructive">La clé enregistrée est illisible (AUTH_SECRET a changé) : ressaisissez-la.</span>
              ) : (
                `${KEY_SOURCE_LABELS[saved.keySource]} Elle n'est jamais renvoyée au navigateur.`
              )
            }
          >
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Input
                  id="jev-key"
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKey}
                  placeholder={saved.keySource !== "none" && !clearKey ? "•••••••• (enregistrée)" : ""}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setClearKey(false);
                  }}
                  className="pr-10 font-mono text-sm"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-1/2 right-1 -translate-y-1/2"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "Masquer la clé" : "Afficher la clé"}
                  aria-pressed={showKey}
                >
                  {showKey ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              {saved.hasStoredKey && (
                <Button type="button" variant="ghost" onClick={() => { setClearKey(true); setApiKey(""); }} disabled={clearKey}>
                  Supprimer
                </Button>
              )}
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Délai d'attente (s)" htmlFor="jev-timeout" hint={errors.timeoutSec ? <span className="text-destructive">{errors.timeoutSec}</span> : "Durée maximale d'un appel à JEV."}>
              <Input id="jev-timeout" inputMode="decimal" value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} aria-invalid={!!errors.timeoutSec} />
            </Field>
            <Field label="Seuil de décision par défaut (0–1)" htmlFor="jev-threshold" hint={errors.defaultThreshold ? <span className="text-destructive">{errors.defaultThreshold}</span> : "« Oui » si P(oui) ≥ seuil, pour les questions sans seuil propre."}>
              <Input id="jev-threshold" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-invalid={!!errors.defaultThreshold} />
            </Field>
          </div>

          {preview && <p className="text-xs text-muted-foreground">Adresse appelée : <span className="font-mono">{preview}</span></p>}

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={testUnsaved} disabled={busy !== null}>
              {busy === "test" ? <Loader2 className="animate-spin" /> : <PlugZap />} Tester sans enregistrer
            </Button>
            <Button onClick={() => save(false)} disabled={busy !== null || !dirty}>
              {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />} Enregistrer
            </Button>
            <Button onClick={() => save(true)} disabled={busy !== null}>
              {busy === "saveTest" ? <Loader2 className="animate-spin" /> : <Stethoscope />} {dirty ? "Enregistrer et tester" : "Tester la connexion"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmReset(true)} disabled={busy !== null}>
              {busy === "reset" ? <Loader2 className="animate-spin" /> : <RotateCcw />} Rétablir les valeurs par défaut
            </Button>
          </div>

          {(busy === "test" || busy === "saveTest") && (
            <Panel className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Test en cours : réseau, service, authentification, décision, routage…
            </Panel>
          )}
          {report && <DiagnosticReportView report={report} />}

          <label className="flex items-center justify-between gap-4 rounded-2xl bg-muted px-4 py-3">
            <span>
              <span className="block text-sm font-medium">Actualiser la pastille d&apos;état toutes les 30 s</span>
              <span className="block text-xs text-muted-foreground">Interroge /health de JEV (sans clé). Réglage propre à ce navigateur.</span>
            </span>
            <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
          </label>
        </div>
      </Section>

      <Section title="Historique des tests JEV" description="Les 20 derniers tests (tous administrateurs confondus).">
        <TestHistory runs={jevHistory.runs} />
      </Section>

      <ServiceDiagnostics
        target="LLM"
        title="Serveur LLM (Qwen)"
        description="Joignabilité, liste des modèles, courte complétion avec et sans thinking, latence. L'adresse se règle dans Administration → Serveur IA."
        endpoint="/api/admin/llm/diagnose"
        running="Test en cours (la première complétion peut charger le modèle en mémoire)…"
      />
      <ServiceDiagnostics
        target="SEARCH"
        title="Service de recherche Web"
        description="Joignabilité et requête de test. Le service se règle dans Administration → Recherche Web."
        endpoint="/api/admin/search/diagnose"
        running="Recherche de test en cours…"
      />

      <Panel className="flex gap-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>
          La pastille d&apos;état (en haut à droite de l&apos;administration et du chat) est verte quand JEV est prêt, orange quand il répond sans être prêt (modèle en cours de chargement), rouge quand il est injoignable. Installation du serveur : <code>deploy/jev/README.md</code>.
        </p>
      </Panel>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rétablir les valeurs par défaut ?</AlertDialogTitle>
            <AlertDialogDescription>
              Hôte {saved.defaults.host}, port {saved.defaults.port}, {saved.defaults.protocol.toLowerCase()}, délai {saved.defaults.timeoutSec} s, seuil {saved.defaults.defaultThreshold}. La clé API enregistrée est conservée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={() => void reset()}>Rétablir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ServiceDiagnostics({ target, title, description, endpoint, running }: { target: Target; title: string; description: string; endpoint: string; running: string }) {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const history = useHistory(target);

  async function run() {
    setBusy(true);
    setReport(null);
    try {
      setReport((await api<{ report: DiagnosticReport }>(endpoint, { method: "POST" })).report);
      void history.reload();
    } catch (err) {
      toast.error(errMsg(err, "Test impossible."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title={title}
      description={description}
      actions={
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
            Historique ({history.runs?.length ?? 0})
          </Button>
          <Button variant="secondary" size="sm" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Stethoscope />} Tester la connexion
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {busy && (
          <Panel className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {running}
          </Panel>
        )}
        {report && <DiagnosticReportView report={report} />}
        {showHistory && <TestHistory runs={history.runs} />}
      </div>
    </Section>
  );
}
