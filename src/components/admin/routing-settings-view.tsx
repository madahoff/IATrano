"use client";

import { useState } from "react";
import { FlaskConical, Info, Loader2, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Panel, Section } from "@/components/layout/page-shell";
import { api, ApiError } from "@/lib/client/api";
import {
  AUTH_MODE_HELP,
  AUTH_MODE_LABELS,
  AUTH_MODES,
  MODE_LABELS,
  ROUTING_MODES,
  routingSettingsSchema,
  type AuthMode,
  type ModeRule,
  type RoutingMode,
  type RoutingSettingsInput,
} from "@/lib/routing/config";
import { decideRouting, type Availability, type ModeOutcome } from "@/lib/routing/decide";
import { cn } from "@/lib/utils";
import { ModeIcon } from "@/components/chat/routing/mode-icon";

const RULE_LABELS: Record<ModeRule, string> = { ALLOWED: "Autorisé", FORBIDDEN: "Interdit", CONFIRM: "Toujours confirmer" };
const RULE_HELP: Record<ModeRule, string> = {
  ALLOWED: "JEV peut l'activer selon le mode d'autorisation.",
  FORBIDDEN: "Jamais activé, même si l'utilisateur le force.",
  CONFIRM: "Toujours soumis à confirmation, même en mode automatique (sauf si l'utilisateur le force).",
};

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(",", ".")));

type Draft = {
  modes: Record<RoutingMode, { question: string; threshold: string; rule: ModeRule }>;
  defaultAuthMode: AuthMode;
  highThreshold: string;
  fallbackModes: RoutingMode[];
  includeContext: boolean;
};

const toDraft = (s: RoutingSettingsInput): Draft => ({
  modes: Object.fromEntries(ROUTING_MODES.map((m) => [m, { question: s.modes[m].question, threshold: String(s.modes[m].threshold), rule: s.modes[m].rule }])) as Draft["modes"],
  defaultAuthMode: s.defaultAuthMode,
  highThreshold: String(s.highThreshold),
  fallbackModes: s.fallbackModes,
  includeContext: s.includeContext,
});

const fromDraft = (d: Draft) => ({
  modes: Object.fromEntries(ROUTING_MODES.map((m) => [m, { question: d.modes[m].question.trim(), threshold: num(d.modes[m].threshold), rule: d.modes[m].rule }])),
  defaultAuthMode: d.defaultAuthMode,
  highThreshold: num(d.highThreshold),
  fallbackModes: d.fallbackModes,
  includeContext: d.includeContext,
});

// La zone de test applique les mêmes disponibilités que le chat pour les trois modes.
const TEST_AVAILABILITY: Availability = {
  thinking: { available: true },
  research: { available: true },
  interactive: { available: true },
};

type TestResult = { ok: true; probabilities: Record<RoutingMode, number>; model: string; latencyMs: number; serverMs: number | null } | { ok: false; error: string; hint?: string };

export function RoutingSettingsView({ initial }: { initial: RoutingSettingsInput }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [busy, setBusy] = useState<null | "save" | "reset" | "test">(null);
  const [testMessage, setTestMessage] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);

  const setMode = (m: RoutingMode, patch: Partial<Draft["modes"][RoutingMode]>) => setDraft((d) => ({ ...d, modes: { ...d.modes, [m]: { ...d.modes[m], ...patch } } }));
  const parsed = routingSettingsSchema.safeParse(fromDraft(draft));

  async function save() {
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Valeurs invalides.");
      return;
    }
    setBusy("save");
    try {
      const { settings } = await api<{ settings: RoutingSettingsInput }>("/api/admin/routing", { method: "PUT", json: parsed.data });
      setDraft(toDraft(settings));
      toast.success("Réglages du routage enregistrés : ils s'appliquent dès le prochain message.");
    } catch (err) {
      toast.error(errMsg(err, "Enregistrement impossible."));
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    try {
      const { settings } = await api<{ settings: RoutingSettingsInput }>("/api/admin/routing/reset", { method: "POST" });
      setDraft(toDraft(settings));
      toast.success("Valeurs par défaut rétablies.");
    } catch (err) {
      toast.error(errMsg(err, "Réinitialisation impossible."));
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    if (!testMessage.trim()) return;
    const modes = parsed.success ? parsed.data.modes : undefined;
    setBusy("test");
    setTest(null);
    try {
      setTest(await api<TestResult>("/api/admin/routing/test", { method: "POST", json: { message: testMessage, modes } }));
    } catch (err) {
      toast.error(errMsg(err, "Test impossible."));
    } finally {
      setBusy(null);
    }
  }

  const config = parsed.success ? parsed.data : null;
  const availability = TEST_AVAILABILITY;
  const decisions = (probabilities: Record<RoutingMode, number> | null, jevFailed: boolean) =>
    config
      ? Object.fromEntries(
          AUTH_MODES.map((a) => [
            a,
            decideRouting({ authMode: a, modes: config.modes, highThreshold: config.highThreshold, probabilities, jevFailed, fallbackModes: config.fallbackModes, overrides: {}, autoAccept: [], availability }).outcomes,
          ]),
        )
      : null;

  return (
    <>
      <Section title="Questions de routage" description="Avant chaque réponse, IATrano envoie UNE requête à JEV avec le message et ces trois questions (en anglais : le modèle JEV est entraîné en anglais).">
        <div className="flex flex-col gap-4">
          {ROUTING_MODES.map((m) => (
            <Panel key={m} className="flex flex-col gap-3">
              <p className="flex items-center gap-2 font-medium">
                <ModeIcon mode={m} className="size-4 text-muted-foreground" />
                {MODE_LABELS[m]}
              </p>
              <Field label="Question (anglais)" htmlFor={`q-${m}`}>
                <Textarea id={`q-${m}`} rows={2} value={draft.modes[m].question} onChange={(e) => setMode(m, { question: e.target.value })} className="bg-background text-sm" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Seuil d'activation (0–1)" htmlFor={`t-${m}`} hint="Le mode est retenu si P(oui) ≥ seuil.">
                  <Input id={`t-${m}`} inputMode="decimal" value={draft.modes[m].threshold} onChange={(e) => setMode(m, { threshold: e.target.value })} className="bg-background" />
                </Field>
                <Field label="Règle" hint={RULE_HELP[draft.modes[m].rule]}>
                  <Select value={draft.modes[m].rule} onValueChange={(v) => setMode(m, { rule: v as ModeRule })}>
                    <SelectTrigger className="w-full bg-background"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(RULE_LABELS) as ModeRule[]).map((r) => (
                        <SelectItem key={r} value={r}>{RULE_LABELS[r]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            </Panel>
          ))}
        </div>
      </Section>

      <Section title="Autorisations" description="Valeur par défaut pour les utilisateurs ; chacun peut changer de mode dans le chat.">
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Mode d'autorisation par défaut" hint={AUTH_MODE_HELP[draft.defaultAuthMode]}>
              <Select value={draft.defaultAuthMode} onValueChange={(v) => setDraft((d) => ({ ...d, defaultAuthMode: v as AuthMode }))}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AUTH_MODES.map((a) => (
                    <SelectItem key={a} value={a}>{AUTH_MODE_LABELS[a]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Seuil haut du mode hybride (0–1)" htmlFor="high" hint="Au-dessus : activation directe ; entre le seuil du mode et ce seuil : confirmation demandée.">
              <Input id="high" inputMode="decimal" value={draft.highThreshold} onChange={(e) => setDraft((d) => ({ ...d, highThreshold: e.target.value }))} />
            </Field>
          </div>
          <Field label="Si JEV est injoignable" hint="La conversation n'est jamais bloquée : ces modes sont appliqués d'office (aucun = réponse simple) et un avis s'affiche dans le chat.">
            <div className="flex flex-wrap gap-2">
              {ROUTING_MODES.map((m) => {
                const on = draft.fallbackModes.includes(m);
                return (
                  <Button
                    key={m}
                    type="button"
                    size="sm"
                    variant={on ? "default" : "secondary"}
                    aria-pressed={on}
                    onClick={() => setDraft((d) => ({ ...d, fallbackModes: on ? d.fallbackModes.filter((x) => x !== m) : [...d.fallbackModes, m] }))}
                  >
                    <ModeIcon mode={m} /> {MODE_LABELS[m]}
                  </Button>
                );
              })}
              <span className="self-center text-xs text-muted-foreground">{draft.fallbackModes.length ? "" : "Aucun : réponse simple"}</span>
            </div>
          </Field>
          <label className="flex items-center justify-between gap-4 rounded-2xl bg-muted px-4 py-3">
            <span>
              <span className="block text-sm font-medium">Joindre l&apos;échange précédent</span>
              <span className="block text-xs text-muted-foreground">Un court extrait de la question et de la réponse précédentes aide JEV à comprendre les relances (« et en 2025 ? »).</span>
            </span>
            <Switch checked={draft.includeContext} onCheckedChange={(v) => setDraft((d) => ({ ...d, includeContext: v }))} />
          </label>
          {!parsed.success && <p className="text-sm text-destructive">{parsed.error.issues[0]?.message}</p>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={busy !== null || !parsed.success}>
              {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />} Enregistrer
            </Button>
            <Button variant="ghost" onClick={reset} disabled={busy !== null}>
              {busy === "reset" ? <Loader2 className="animate-spin" /> : <RotateCcw />} Rétablir les valeurs par défaut
            </Button>
          </div>
        </div>
      </Section>

      <Section title="Zone de test" description="Saisissez un message : JEV renvoie ses probabilités avec les questions ci-dessus (même non enregistrées), et vous voyez la décision selon chaque mode d'autorisation.">
        <div className="flex flex-col gap-3">
          <Textarea value={testMessage} onChange={(e) => setTestMessage(e.target.value)} rows={3} placeholder="Ex. : Compare les offres d'électricité verte disponibles en France cette année." />
          <div>
            <Button variant="secondary" onClick={runTest} disabled={busy !== null || !testMessage.trim()}>
              {busy === "test" ? <Loader2 className="animate-spin" /> : <FlaskConical />} Analyser
            </Button>
          </div>
          {test && !test.ok && (
            <Panel className="bg-destructive/10 text-sm">
              <p className="font-medium text-destructive">{test.error}</p>
              {test.hint && <p className="mt-1 text-muted-foreground">{test.hint}</p>}
              {config && <p className="mt-2">Dans le chat : {config.fallbackModes.length ? `modes de repli appliqués (${config.fallbackModes.map((m) => MODE_LABELS[m]).join(", ")})` : "réponse simple"}, avec un avis à l&apos;utilisateur.</p>}
            </Panel>
          )}
          {test?.ok && config && <TestTable probabilities={test.probabilities} decisions={decisions(test.probabilities, false)!} config={config} meta={`Modèle ${test.model} · ${test.latencyMs} ms${test.serverMs !== null ? ` (inférence ${test.serverMs} ms)` : ""}`} />}
        </div>
      </Section>

      <Panel className="flex gap-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>Dans tous les modes, l&apos;utilisateur peut forcer ou désactiver un mode pour un message dans le panneau « Options » sous le champ de saisie : son choix prime sur JEV, sauf si le mode est interdit ici. Chaque décision (proposée, acceptée, refusée, forcée) est enregistrée dans le journal.</p>
      </Panel>
    </>
  );
}

function Cell({ o }: { o: ModeOutcome }) {
  const label = o.state === "on" ? "Activé" : o.state === "ask" ? "Confirmation" : "Non";
  return (
    <td className="px-3 py-2" title={o.reason}>
      <span
        className={cn(
          "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
          o.state === "on" && "bg-success/12 text-success",
          o.state === "ask" && "bg-warning/15 text-warning-foreground",
          o.state === "off" && "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </td>
  );
}

function TestTable({
  probabilities,
  decisions,
  config,
  meta,
}: {
  probabilities: Record<RoutingMode, number>;
  decisions: Record<string, Record<RoutingMode, ModeOutcome>>;
  config: RoutingSettingsInput;
  meta: string;
}) {
  return (
    <Panel className="overflow-x-auto p-0 md:p-0">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <caption className="px-4 pt-3 text-left text-xs text-muted-foreground">{meta}</caption>
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Mode</th>
            <th className="px-3 py-2 font-medium">P(oui)</th>
            <th className="px-3 py-2 font-medium">Seuil</th>
            {AUTH_MODES.map((a) => (
              <th key={a} className="px-3 py-2 font-medium">{AUTH_MODE_LABELS[a]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROUTING_MODES.map((m) => (
            <tr key={m} className="border-t border-background">
              <td className="px-3 py-2 font-medium whitespace-nowrap">
                <span className="inline-flex items-center gap-1.5">
                  <ModeIcon mode={m} className="size-3.5 text-muted-foreground" />
                  {MODE_LABELS[m]}
                </span>
              </td>
              <td className="px-3 py-2 tabular-nums">{Math.round(probabilities[m] * 100)} %</td>
              <td className="px-3 py-2 text-muted-foreground tabular-nums">{Math.round(config.modes[m].threshold * 100)} %</td>
              {AUTH_MODES.map((a) => (
                <Cell key={a} o={decisions[a][m]} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 pb-3 text-xs text-muted-foreground">
        « Confirmation » : une carte demande l&apos;accord de l&apos;utilisateur avant la réponse. « Désactivé » : JEV n&apos;est pas consulté, seuls les boutons de l&apos;utilisateur comptent. Survolez une case pour le détail.
      </p>
    </Panel>
  );
}
