"use client";

import { useState } from "react";
import { Loader2, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Field, Panel, Section } from "@/components/layout/page-shell";
import { api, ApiError } from "@/lib/client/api";
import type { ContextAdminView } from "@/lib/context/admin";
import { WINDOW_SOURCE_LABELS } from "@/lib/context/window";

const fmt = (n: number) => n.toLocaleString("fr-FR");
const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function ContextSettingsView({ initial }: { initial: ContextAdminView }) {
  const [view, setView] = useState(initial);
  const [form, setForm] = useState(initial.settings);
  const [saving, setSaving] = useState(false);
  const ollama = view.settings.providerType === "OLLAMA";

  async function save() {
    setSaving(true);
    try {
      const { providerType: _p, ...data } = form;
      void _p;
      const next = await api<ContextAdminView>("/api/admin/context", { method: "PATCH", json: data });
      setView(next);
      setForm(next.settings);
      toast.success("Réglages du contexte enregistrés.");
    } catch (err) {
      toast.error(errMsg(err, "Enregistrement impossible."));
    } finally {
      setSaving(false);
    }
  }

  const num = (k: keyof typeof form) => ({
    value: String(form[k]),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: Number(e.target.value) || 0 }),
    type: "number" as const,
    inputMode: "numeric" as const,
  });

  return (
    <>
      <Section
        title="Fenêtre de contexte"
        description={
          ollama
            ? "La fenêtre annoncée par Ollama est utilisée automatiquement et envoyée au modèle (num_ctx). Le réglage par défaut ci-dessous sert uniquement si Ollama ne fournit pas cette information ; un réglage manuel par modèle reste prioritaire. Une fenêtre plus grande consomme davantage de mémoire vidéo."
            : "Les serveurs compatibles OpenAI fixent la fenêtre au chargement du modèle. Elle est lue quand le serveur l'annonce ; sinon la valeur par défaut ci-dessous est supposée : renseignez la fenêtre réelle de chaque modèle plus bas."
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Fenêtre par défaut (tokens)" htmlFor="ctx-window">
              <Input id="ctx-window" min={1024} step={1024} {...num("contextDefaultWindow")} />
            </Field>
            <Field label="Réserve pour la réponse (tokens)" htmlFor="ctx-reserve" hint="Capacité effective du prompt = fenêtre − réserve.">
              <Input id="ctx-reserve" min={128} step={128} {...num("contextResponseReserve")} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Avertissement à (%)" htmlFor="ctx-warn">
              <Input id="ctx-warn" min={10} max={99} {...num("contextWarnPct")} />
            </Field>
            <Field label="Réduction conseillée à (%)" htmlFor="ctx-high">
              <Input id="ctx-high" min={10} max={99} {...num("contextHighPct")} />
            </Field>
            <Field label="Compaction auto à (%)" htmlFor="ctx-auto" hint="0 = jamais automatique.">
              <Input id="ctx-auto" min={0} max={100} {...num("contextAutoCompactPct")} />
            </Field>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-2xl bg-muted px-4 py-3">
            <div>
              <label htmlFor="mem-feature" className="text-sm font-medium">Mémoire persistante</label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Interrupteur général. Chaque utilisateur gère ensuite sa propre mémoire ; l&apos;administration n&apos;a accès au contenu d&apos;aucune mémoire.
              </p>
            </div>
            <Switch id="mem-feature" checked={form.memoryFeatureEnabled} onCheckedChange={(v) => setForm({ ...form, memoryFeatureEnabled: v })} />
          </div>
          <div>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />} Enregistrer
            </Button>
          </div>
        </div>
      </Section>

      <Section title="Fenêtre par modèle" description="Un réglage manuel prime sur la valeur par défaut et sur la valeur annoncée par le serveur.">
        {!view.reachable && <p className="mb-3 text-sm text-warning-foreground">Serveur IA injoignable : seuls les réglages manuels existants sont listés.</p>}
        {view.models.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun modèle détecté.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {view.models.map((m) => (
              <ModelRow key={m.model} row={m} onSaved={setView} />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function ModelRow({ row, onSaved }: { row: ContextAdminView["models"][number]; onSaved: (v: ContextAdminView) => void }) {
  const [windowValue, setWindowValue] = useState(String(row.manual?.contextWindow ?? row.effective.window));
  const [reserve, setReserve] = useState(row.manual?.responseReserve ? String(row.manual.responseReserve) : "");
  const [busy, setBusy] = useState(false);

  async function call(method: "PUT" | "DELETE") {
    setBusy(true);
    try {
      const json = method === "PUT" ? { model: row.model, contextWindow: Number(windowValue), responseReserve: reserve ? Number(reserve) : null } : { model: row.model };
      onSaved(await api<ContextAdminView>("/api/admin/context/models", { method, json }));
      toast.success(method === "PUT" ? "Fenêtre enregistrée." : "Réglage manuel retiré.");
    } catch (err) {
      toast.error(errMsg(err, "Enregistrement impossible."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <Panel className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium break-all">{row.model}</span>
          {!row.installed && <Badge variant="warning">non installé</Badge>}
          {row.manual && <Badge variant="secondary">manuel</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          Effectif : fenêtre {fmt(row.effective.window)} · réserve {fmt(row.effective.reserve)} · capacité {fmt(row.effective.capacity)} tokens —{" "}
          {WINDOW_SOURCE_LABELS[row.effective.source]}
          {row.providerMax ? ` · maximum annoncé par le modèle : ${fmt(row.providerMax)}` : " · maximum du modèle inconnu"}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Fenêtre (tokens)" htmlFor={`w-${row.model}`}>
            <Input id={`w-${row.model}`} className="w-36 bg-background" type="number" min={1024} step={1024} value={windowValue} onChange={(e) => setWindowValue(e.target.value)} />
          </Field>
          <Field label="Réserve (option)" htmlFor={`r-${row.model}`}>
            <Input id={`r-${row.model}`} className="w-32 bg-background" type="number" min={128} step={128} placeholder="défaut" value={reserve} onChange={(e) => setReserve(e.target.value)} />
          </Field>
          <Button size="sm" onClick={() => call("PUT")} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Save />} Enregistrer
          </Button>
          {row.manual && (
            <Button size="sm" variant="ghost" onClick={() => call("DELETE")} disabled={busy}>
              <RotateCcw /> Valeur automatique
            </Button>
          )}
        </div>
        {row.providerMax && Number(windowValue) > row.providerMax && (
          <p className="text-xs text-warning-foreground">Au-delà du maximum annoncé ({fmt(row.providerMax)}), la qualité des réponses peut se dégrader.</p>
        )}
      </Panel>
    </li>
  );
}
