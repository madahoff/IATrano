"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, PlugZap, Save, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Field, Panel, Section } from "@/components/layout/page-shell";
import { formatBytes } from "@/components/documents/format";
import { api, ApiError } from "@/lib/client/api";
import type { getDocumentAdminView } from "@/lib/documents/admin";

type View = Awaited<ReturnType<typeof getDocumentAdminView>>;
type Settings = View["settings"];

const num = (v: string) => (v === "" ? 0 : Number(v));

export function DocumentsSettingsView({ initial }: { initial: View }) {
  const [view, setView] = useState(initial);
  const [form, setForm] = useState<Settings>(initial.settings);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tests, setTests] = useState<Array<{ service: string; ok: boolean; detail: string }> | null>(null);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      const data = {
        embeddingModel: form.embeddingModel || null,
        embeddingBaseUrl: form.embeddingBaseUrl || null,
        ocrEnabled: form.ocrEnabled,
        ocrLanguages: form.ocrLanguages,
        visionModel: form.visionModel || null,
        transcriptionUrl: form.transcriptionUrl || null,
        transcriptionModel: form.transcriptionModel || null,
        analysisEnabled: form.analysisEnabled,
        analysisModel: form.analysisModel || null,
        chunkTargetTokens: form.chunkTargetTokens,
        chunkOverlapTokens: form.chunkOverlapTokens,
        maxFileMb: form.maxFileMb,
        maxUnits: form.maxUnits,
        concurrency: form.concurrency,
        retrievalMaxPassages: form.retrievalMaxPassages,
      };
      const next = await api<View>("/api/admin/documents", { method: "PATCH", json: data });
      setView(next);
      setForm(next.settings);
      toast.success("Réglages documentaires enregistrés. Relancez l'index sémantique des documents existants si le modèle d'embeddings a changé.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Enregistrement impossible.");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    try {
      setTests((await api<{ results: NonNullable<typeof tests> }>("/api/admin/documents/test", { method: "POST" })).results);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Test impossible.");
    } finally {
      setTesting(false);
    }
  }

  const c = view.capabilities;
  const text = (k: keyof Settings) => ({ value: (form[k] as string | null) ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value as never) });
  const int = (k: keyof Settings) => ({ value: String(form[k] ?? ""), inputMode: "numeric" as const, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, num(e.target.value.replace(/\D/g, "")) as never) });

  return (
    <>
      <Section
        title="Capacités disponibles"
        description="Ce que le serveur peut réellement faire aujourd'hui. Une capacité absente est signalée dans chaque document concerné, jamais simulée."
        actions={
          <Button variant="outline" onClick={() => void test()} disabled={testing}>
            {testing ? <Loader2 className="animate-spin" /> : <PlugZap />} Tester les services
          </Button>
        }
      >
        <Panel className="flex flex-col gap-2 text-sm">
          <p>
            Outils : {Object.entries(c.tools).map(([k, v]) => (
              <Badge key={k} variant={v ? "secondary" : "outline"} className="mr-1">
                {v ? "✓" : "✗"} {k}
              </Badge>
            ))}
          </p>
          <p>OCR : {c.ocrEngine}</p>
          <p>Modèles vision détectés : {c.visionModels.length ? c.visionModels.join(", ") : "aucun (les images sont lues par OCR seulement)"}</p>
          <p>
            File de traitement : {c.worker ? "active" : "désactivée (DOCUMENT_WORKER=off)"} · {Object.entries(view.queue).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ") || "vide"}
          </p>
          <p className="text-muted-foreground">
            {view.totals.documents} document(s) · {formatBytes(view.totals.bytes)} · stockage {c.storage}
          </p>
          {tests && (
            <ul className="mt-2 flex flex-col gap-1">
              {tests.map((t) => (
                <li key={t.service} className="flex items-start gap-2">
                  {t.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                  <span>
                    <span className="font-medium">{t.service}</span> — {t.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </Section>

      <Section title="Recherche sémantique" description="Modèle d'embeddings servi par Ollama (/api/embed) ou un serveur compatible OpenAI (/v1/embeddings). Sans modèle, la recherche reste lexicale (BM25) avec expansion des requêtes par le LLM.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Modèle d'embeddings" htmlFor="emb" hint="Ex. embeddinggemma, bge-m3, nomic-embed-text. Vide : désactivé.">
            <Input id="emb" {...text("embeddingModel")} placeholder="embeddinggemma" />
          </Field>
          <Field label="Serveur d'embeddings" htmlFor="embUrl" hint="Vide : même serveur que le LLM.">
            <Input id="embUrl" {...text("embeddingBaseUrl")} placeholder="http://hôte:11434" />
          </Field>
        </div>
      </Section>

      <Section title="Lecture des images, vidéos et audio">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="OCR" hint="Pages numérisées, images, images clés des vidéos.">
            <div className="flex items-center gap-3">
              <Switch checked={form.ocrEnabled} onCheckedChange={(v) => set("ocrEnabled", v)} aria-label="Activer l'OCR" />
              <Input {...text("ocrLanguages")} aria-label="Langues OCR" className="max-w-40" />
            </div>
          </Field>
          <Field label="Modèle vision-langage" htmlFor="vision" hint="Schémas, graphiques, captures d'écran. Vide : OCR seul (signalé).">
            <Input id="vision" {...text("visionModel")} placeholder={c.visionModels[0] ?? "ex. qwen2.5vl:7b"} />
          </Field>
          <Field label="Service de transcription" htmlFor="asr" hint="Endpoint compatible OpenAI /v1/audio/transcriptions (deploy/whisper). Vide : audio non transcrit.">
            <Input id="asr" {...text("transcriptionUrl")} placeholder="http://127.0.0.1:8090" />
          </Field>
          <Field label="Modèle de transcription" htmlFor="asrModel">
            <Input id="asrModel" {...text("transcriptionModel")} placeholder="small" />
          </Field>
        </div>
      </Section>

      <Section title="Analyse et découpage">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Analyse progressive (sections, synthèse, méthodes)">
            <Switch checked={form.analysisEnabled} onCheckedChange={(v) => set("analysisEnabled", v)} aria-label="Activer l'analyse" />
          </Field>
          <Field label="Modèle d'analyse" htmlFor="am" hint={`Vide : modèle par défaut (${c.defaultModel ?? "non défini"}).`}>
            <Input id="am" {...text("analysisModel")} list="llm-models" />
            <datalist id="llm-models">
              {c.llmModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          <Field label="Taille cible des passages (tokens)" htmlFor="ct" hint="Réduite automatiquement si la fenêtre du modèle est petite.">
            <Input id="ct" {...int("chunkTargetTokens")} />
          </Field>
          <Field label="Chevauchement (tokens)" htmlFor="co">
            <Input id="co" {...int("chunkOverlapTokens")} />
          </Field>
          <Field label="Passages transmis par réponse" htmlFor="rp">
            <Input id="rp" {...int("retrievalMaxPassages")} />
          </Field>
          <Field label="Documents traités simultanément" htmlFor="cc" hint="Au-delà de 1, plusieurs analyses se partagent le GPU.">
            <Input id="cc" {...int("concurrency")} />
          </Field>
          <Field label="Taille maximale d'un fichier (Mo)" htmlFor="mf">
            <Input id="mf" {...int("maxFileMb")} />
          </Field>
          <Field label="Pages / unités maximales par document" htmlFor="mu">
            <Input id="mu" {...int("maxUnits")} />
          </Field>
        </div>
        <Button className="mt-5" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} Enregistrer
        </Button>
      </Section>
    </>
  );
}
