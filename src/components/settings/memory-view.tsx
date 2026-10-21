"use client";

import { useEffect, useState } from "react";
import { Brain, Check, FolderGit2, Loader2, Pencil, Plus, Trash2, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Field, Panel, Section } from "@/components/layout/page-shell";
import { api, ApiError } from "@/lib/client/api";
import { formatDate } from "@/lib/format";

type Kind = "PREFERENCE" | "FACT" | "PROJECT";
type MemoryItem = {
  id: string;
  kind: Kind;
  project: string | null;
  content: string;
  source: "MANUAL" | "AUTO";
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
type Settings = { featureEnabled: boolean; enabled: boolean; autoSave: boolean };

const KIND_LABELS: Record<Kind, string> = { PREFERENCE: "Préférences et consignes", FACT: "Informations sur vous", PROJECT: "Projets" };
const KIND_ICONS: Record<Kind, React.ReactNode> = { PREFERENCE: <Brain />, FACT: <UserRound />, PROJECT: <FolderGit2 /> };
const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function MemoryView() {
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  const load = () =>
    api<{ memories: MemoryItem[]; settings: Settings }>("/api/memories")
      .then((d) => {
        setMemories(d.memories);
        setSettings(d.settings);
      })
      .catch((err) => toast.error(errMsg(err, "Mémoire indisponible.")));
  useEffect(() => {
    void load();
  }, []);

  async function saveSettings(patch: { memoryEnabled?: boolean; memoryAutoSave?: boolean }) {
    try {
      const d = await api<{ settings: Settings }>("/api/memories/settings", { method: "PATCH", json: patch });
      setSettings(d.settings);
    } catch (err) {
      toast.error(errMsg(err, "Enregistrement impossible."));
    }
  }

  async function clearAll() {
    try {
      const d = await api<{ deleted: number }>("/api/memories", { method: "DELETE", json: { confirm: true } });
      setMemories([]);
      toast.success(`${d.deleted} mémoire(s) effacée(s).`);
    } catch (err) {
      toast.error(errMsg(err, "Effacement impossible."));
    }
  }

  if (!memories || !settings) return <Loader2 className="animate-spin text-muted-foreground" />;

  return (
    <>
      <Section
        title="Mémoire persistante"
        description="Des informations durables que l'IA peut réutiliser d'une conversation à l'autre. Elles vous sont propres : aucun autre compte, administrateurs compris, n'y a accès."
      >
        {!settings.featureEnabled ? (
          <Panel className="text-sm text-muted-foreground">La mémoire persistante est désactivée par l&apos;administration pour cette application.</Panel>
        ) : (
          <div className="flex flex-col gap-2">
            <ToggleRow
              id="mem-enabled"
              label="Utiliser la mémoire"
              hint="Les souvenirs pertinents pour votre demande sont ajoutés au contexte du modèle (jamais tous systématiquement)."
              checked={settings.enabled}
              onChange={(v) => saveSettings({ memoryEnabled: v })}
            />
            <ToggleRow
              id="mem-auto"
              label="Enregistrement automatique"
              hint="Quand vous dites « retiens que… », « je préfère… », « appelle-moi… » ou « oublie que… », la mémoire est mise à jour et vous en êtes averti. Les mots de passe et secrets ne sont jamais mémorisés."
              checked={settings.autoSave}
              disabled={!settings.enabled}
              onChange={(v) => saveSettings({ memoryAutoSave: v })}
            />
          </div>
        )}
      </Section>

      <Section
        title="Ce que l'IA a mémorisé"
        description="Modifiez une formulation inexacte ou supprimez ce qui n'est plus vrai. Le résumé de contexte propre à chaque conversation est distinct : il se consulte depuis l'indicateur de contexte du chat."
        actions={
          memories.length > 0 ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 /> Tout effacer
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Effacer toute la mémoire ?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Les {memories.length} mémoire(s) de votre compte seront supprimées définitivement. Vos conversations ne sont pas affectées.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Annuler</AlertDialogCancel>
                  <AlertDialogAction onClick={clearAll}>Tout effacer</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null
        }
      >
        <AddMemory onAdded={(m, dup) => setMemories((list) => (dup ? (list ?? []).map((x) => (x.id === m.id ? m : x)) : [m, ...(list ?? [])]))} />
        {memories.length === 0 ? (
          <p className="mt-4 rounded-2xl bg-muted px-4 py-6 text-center text-sm text-muted-foreground">Aucune mémoire enregistrée pour le moment.</p>
        ) : (
          <div className="mt-4 flex flex-col gap-6">
            {(Object.keys(KIND_LABELS) as Kind[]).map((kind) => {
              const items = memories.filter((m) => m.kind === kind);
              if (items.length === 0) return null;
              return (
                <div key={kind} className="flex flex-col gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground [&_svg]:size-4">
                    {KIND_ICONS[kind]} {KIND_LABELS[kind]}
                  </h3>
                  <ul className="flex flex-col gap-2">
                    {items.map((m) => (
                      <MemoryRow
                        key={m.id}
                        memory={m}
                        onChange={(next) => setMemories((list) => (list ?? []).map((x) => (x.id === next.id ? next : x)))}
                        onDelete={() => setMemories((list) => (list ?? []).filter((x) => x.id !== m.id))}
                      />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}

function ToggleRow({ id, label, hint, checked, disabled, onChange }: { id: string; label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-2xl bg-muted px-4 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function AddMemory({ onAdded }: { onAdded: (m: MemoryItem, duplicate: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("PREFERENCE");
  const [content, setContent] = useState("");
  const [project, setProject] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const d = await api<{ memory: MemoryItem; duplicateOf: boolean }>("/api/memories", { method: "POST", json: { kind, content, project: kind === "PROJECT" ? project : null } });
      onAdded(d.memory, d.duplicateOf);
      toast.success(d.duplicateOf ? "Une mémoire équivalente existait : elle a été mise à jour." : "Mémoire ajoutée.");
      setContent("");
      setOpen(false);
    } catch (err) {
      toast.error(errMsg(err, "Ajout impossible."));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Plus /> Ajouter une mémoire
      </Button>
    );
  }
  return (
    <form onSubmit={submit}>
      <Panel className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
              <SelectTrigger className="w-full bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PREFERENCE">Préférence ou consigne</SelectItem>
                <SelectItem value="FACT">Information sur vous</SelectItem>
                <SelectItem value="PROJECT">Projet</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {kind === "PROJECT" && (
            <Field label="Nom du projet" htmlFor="mem-project">
              <Input id="mem-project" className="bg-background" value={project} onChange={(e) => setProject(e.target.value)} maxLength={80} required />
            </Field>
          )}
        </div>
        <Field label="Contenu" htmlFor="mem-content" hint="Une phrase courte et durable. Pas de mot de passe ni de secret.">
          <Textarea id="mem-content" className="bg-background" value={content} onChange={(e) => setContent(e.target.value)} maxLength={500} rows={2} required />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" disabled={saving || !content.trim()}>
            {saving ? <Loader2 className="animate-spin" /> : <Check />} Enregistrer
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Annuler
          </Button>
        </div>
      </Panel>
    </form>
  );
}

function MemoryRow({ memory, onChange, onDelete }: { memory: MemoryItem; onChange: (m: MemoryItem) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const d = await api<{ memory: MemoryItem }>(`/api/memories/${memory.id}`, { method: "PATCH", json: { content: draft } });
      onChange(d.memory);
      setEditing(false);
      toast.success("Mémoire modifiée.");
    } catch (err) {
      toast.error(errMsg(err, "Modification impossible."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/api/memories/${memory.id}`, { method: "DELETE" });
      onDelete();
      toast.success("Mémoire supprimée.");
    } catch (err) {
      toast.error(errMsg(err, "Suppression impossible."));
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-2xl bg-muted px-4 py-3 text-sm">
      {editing ? (
        <>
          <Textarea className="bg-background" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={500} rows={2} aria-label="Contenu de la mémoire" autoFocus />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={busy || !draft.trim()}>
              {busy ? <Loader2 className="animate-spin" /> : <Check />} Enregistrer
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(memory.content);
                setEditing(false);
              }}
            >
              <X /> Annuler
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="break-words">{memory.content}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {memory.project && <Badge variant="secondary">{memory.project}</Badge>}
              <span>{memory.source === "AUTO" ? "Enregistrée depuis une conversation" : "Ajoutée manuellement"}</span>
              <span>· modifiée {formatDate(memory.updatedAt)}</span>
              {memory.useCount > 0 && <span>· utilisée {memory.useCount} fois</span>}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => setEditing(true)} aria-label="Modifier cette mémoire">
            <Pencil />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={remove} disabled={busy} aria-label="Supprimer cette mémoire">
            <Trash2 />
          </Button>
        </div>
      )}
    </li>
  );
}
