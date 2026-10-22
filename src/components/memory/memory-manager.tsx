"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Brain, Check, CheckCheck, ChevronDown, FolderGit2, History, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, Panel } from "@/components/layout/page-shell";
import { api, ApiError } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { CERTAINTY_LABELS, KIND_LABELS, MEMORY_KINDS, type MemoryCertaintyValue, type MemoryKindValue } from "@/lib/memory/types";

// Consultation et gestion des souvenirs : mémoire personnelle et mémoire de chaque projet.
// fixedProjectId : vue limitée à un projet (page du projet) ; sinon toutes les portées avec un filtre.

export type MemoryItem = {
  id: string;
  kind: MemoryKindValue;
  project: string | null;
  projectId: string | null;
  projectName: string | null;
  content: string;
  topic: string | null;
  source: "MANUAL" | "AUTO" | "DOCUMENT";
  certainty: MemoryCertaintyValue;
  status: "ACTIVE" | "SUPERSEDED";
  importance: number;
  mentionCount: number;
  supersededById: string | null;
  useCount: number;
  lastUsedAt: string | null;
  lastConfirmedAt: string;
  createdAt: string;
  updatedAt: string;
};
type ProjectRef = { id: string; name: string; memoryEnabled: boolean };
type Jobs = { pending: number; failed: number; lastError: string | null };

const PERSONAL = "personal";
const KIND_ORDER: MemoryKindValue[] = ["PREFERENCE", "CONSTRAINT", "DECISION", "OBJECTIVE", "FACT", "PROJECT"];
const SOURCE_LABELS = { MANUAL: "Ajouté par vous", AUTO: "Retenu d'une conversation", DOCUMENT: "Issu d'un document" } as const;
const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function MemoryManager({ fixedProjectId, refreshKey = 0 }: { fixedProjectId?: string; refreshKey?: number }) {
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [jobs, setJobs] = useState<Jobs>({ pending: 0, failed: 0, lastError: null });
  const [scope, setScope] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const apply = useCallback((d: { memories: MemoryItem[]; projects: ProjectRef[]; jobs: Jobs }) => {
    setMemories(d.memories);
    setProjects(d.projects);
    setJobs(d.jobs);
  }, []);
  const fetchAll = useCallback(() => {
    const qs = new URLSearchParams({ history: "1", ...(fixedProjectId ? { projectId: fixedProjectId } : {}) });
    return api<{ memories: MemoryItem[]; projects: ProjectRef[]; jobs: Jobs }>(`/api/memories?${qs}`);
  }, [fixedProjectId]);
  const load = () =>
    fetchAll()
      .then(apply)
      .catch((err) => toast.error(errMsg(err, "Mémoire indisponible.")));
  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then((d) => !cancelled && apply(d))
      .catch((err) => toast.error(errMsg(err, "Mémoire indisponible.")));
    return () => {
      cancelled = true;
    };
  }, [fetchAll, apply, refreshKey]);

  const replace = (m: MemoryItem) => setMemories((list) => (list ?? []).map((x) => (x.id === m.id ? m : x)));

  async function retryJobs() {
    try {
      const d = await api<{ retried: number; jobs: Jobs }>("/api/memories/jobs", { method: "POST", json: { action: "retry" } });
      setJobs(d.jobs);
      toast.success(`${d.retried} analyse(s) relancée(s).`);
      setTimeout(() => void load(), 4000);
    } catch (err) {
      toast.error(errMsg(err, "Relance impossible."));
    }
  }

  const groups = useMemo(() => {
    if (!memories) return [];
    const q = query.trim().toLowerCase();
    const visible = memories.filter((m) => m.status === "ACTIVE" && (!q || m.content.toLowerCase().includes(q) || (m.projectName ?? m.project ?? "").toLowerCase().includes(q)));
    const keys = fixedProjectId ? [fixedProjectId] : scope === "all" ? [PERSONAL, ...projects.map((p) => p.id)] : [scope];
    return keys
      .map((key) => ({
        key,
        label: key === PERSONAL ? "Mémoire personnelle" : (projects.find((p) => p.id === key)?.name ?? "Projet"),
        disabled: key !== PERSONAL && projects.find((p) => p.id === key)?.memoryEnabled === false,
        items: visible
          .filter((m) => (key === PERSONAL ? m.projectId === null : m.projectId === key))
          .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.updatedAt.localeCompare(a.updatedAt)),
      }))
      .filter((g) => g.items.length > 0 || g.key === fixedProjectId);
  }, [memories, projects, query, scope, fixedProjectId]);

  /** Versions remplacées, rattachées au souvenir actuel de leur chaîne. */
  const history = useMemo(() => {
    const byId = new Map((memories ?? []).map((m) => [m.id, m]));
    const out = new Map<string, MemoryItem[]>();
    for (const m of memories ?? []) {
      if (m.status !== "SUPERSEDED") continue;
      let head = m;
      for (let i = 0; i < 50 && head.supersededById && byId.has(head.supersededById); i++) head = byId.get(head.supersededById)!;
      if (head.status !== "ACTIVE") continue;
      out.set(head.id, [...(out.get(head.id) ?? []), m].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    }
    return out;
  }, [memories]);

  if (!memories) return <Loader2 className="animate-spin text-muted-foreground" />;
  const total = memories.filter((m) => m.status === "ACTIVE").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un souvenir" aria-label="Rechercher un souvenir" />
        </div>
        {!fixedProjectId && projects.length > 0 && (
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger className="w-48" aria-label="Portée">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Toutes les mémoires</SelectItem>
              <SelectItem value={PERSONAL}>Mémoire personnelle</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  Projet : {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={showHistory} onCheckedChange={setShowHistory} aria-label="Afficher l'historique" />
          Historique
        </label>
      </div>

      {(jobs.pending > 0 || jobs.failed > 0) && (
        <Panel className="flex flex-wrap items-center gap-3 py-3 text-sm">
          <RefreshCw className="size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-muted-foreground">
            {jobs.pending > 0 && `${jobs.pending} message(s) en cours d'analyse ou en attente du modèle. `}
            {jobs.failed > 0 && `${jobs.failed} analyse(s) n'ont pas abouti${jobs.lastError ? ` (${jobs.lastError})` : ""}.`}
          </p>
          {jobs.failed > 0 && (
            <Button size="sm" variant="secondary" onClick={retryJobs}>
              <RefreshCw /> Relancer
            </Button>
          )}
        </Panel>
      )}

      <AddMemory fixedProjectId={fixedProjectId} projects={projects} onAdded={(m, dup) => setMemories((list) => (dup ? (list ?? []).map((x) => (x.id === m.id ? m : x)) : [m, ...(list ?? [])]))} />

      {total === 0 && groups.every((g) => g.items.length === 0) ? (
        <p className="rounded-2xl bg-muted px-4 py-6 text-center text-sm text-muted-foreground">
          {fixedProjectId ? "Aucun souvenir pour ce projet. Les décisions et contraintes exprimées dans ses conversations y seront retenues." : "Aucune mémoire enregistrée pour le moment."}
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.key} className="flex flex-col gap-2">
            {!fixedProjectId && (
              <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground [&_svg]:size-4">
                {g.key === PERSONAL ? <UserRound /> : <FolderGit2 />} {g.label}
                <span className="font-normal">· {g.items.length}</span>
                {g.disabled && <Badge variant="outline">mémoire du projet désactivée</Badge>}
              </h3>
            )}
            {g.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun souvenir.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {g.items.map((m) => (
                  <MemoryRow
                    key={m.id}
                    memory={m}
                    history={showHistory ? (history.get(m.id) ?? []) : []}
                    onChange={replace}
                    onDelete={() => setMemories((list) => (list ?? []).filter((x) => x.id !== m.id && !(history.get(m.id) ?? []).some((h) => h.id === x.id)))}
                  />
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function AddMemory({ fixedProjectId, projects, onAdded }: { fixedProjectId?: string; projects: ProjectRef[]; onAdded: (m: MemoryItem, duplicate: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<MemoryKindValue>(fixedProjectId ? "DECISION" : "PREFERENCE");
  const [target, setTarget] = useState(fixedProjectId ?? PERSONAL);
  const [content, setContent] = useState("");
  const [project, setProject] = useState("");
  const [saving, setSaving] = useState(false);
  const inProject = target !== PERSONAL;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const d = await api<{ memory: MemoryItem; duplicateOf: boolean }>("/api/memories", {
        method: "POST",
        json: { kind, content, project: !inProject && kind === "PROJECT" ? project : null, projectId: inProject ? target : null },
      });
      onAdded(d.memory, d.duplicateOf);
      toast.success(d.duplicateOf ? "Un souvenir équivalent existait : il a été confirmé." : "Souvenir ajouté.");
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
      <div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <Plus /> Ajouter un souvenir
        </Button>
      </div>
    );
  }
  const kinds = MEMORY_KINDS.filter((k) => !(inProject && k === "PROJECT"));
  return (
    <form onSubmit={submit}>
      <Panel className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {!fixedProjectId && (
            <Field label="Portée">
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="w-full bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PERSONAL}>Mémoire personnelle (toutes les conversations)</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      Projet : {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Type">
            <Select value={kinds.includes(kind) ? kind : "FACT"} onValueChange={(v) => setKind(v as MemoryKindValue)}>
              <SelectTrigger className="w-full bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kinds.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k === "PROJECT" ? "Projet (hors espace projet)" : KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {!inProject && kind === "PROJECT" && (
            <Field label="Nom du projet" htmlFor="mem-project">
              <Input id="mem-project" className="bg-background" value={project} onChange={(e) => setProject(e.target.value)} maxLength={80} required />
            </Field>
          )}
        </div>
        <Field label="Contenu" htmlFor="mem-content" hint="Une phrase courte et durable. Pas de mot de passe ni de secret.">
          <Textarea id="mem-content" className="bg-background" value={content} onChange={(e) => setContent(e.target.value)} maxLength={inProject ? 2000 : 500} rows={2} required />
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

function MemoryRow({ memory, history, onChange, onDelete }: { memory: MemoryItem; history: MemoryItem[]; onChange: (m: MemoryItem) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);
  const [busy, setBusy] = useState(false);

  async function patch(json: Record<string, unknown>, success: string) {
    setBusy(true);
    try {
      const d = await api<{ memory: MemoryItem }>(`/api/memories/${memory.id}`, { method: "PATCH", json });
      onChange(d.memory);
      setEditing(false);
      toast.success(success);
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
      toast.success("Souvenir oublié.");
    } catch (err) {
      toast.error(errMsg(err, "Suppression impossible."));
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-2xl bg-muted px-4 py-3 text-sm">
      {editing ? (
        <>
          <Textarea className="bg-background" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={memory.projectId ? 2000 : 500} rows={2} aria-label="Contenu du souvenir" autoFocus />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => patch({ content: draft }, "Souvenir corrigé.")} disabled={busy || !draft.trim()}>
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
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <Badge variant="secondary">
                {memory.kind === "PREFERENCE" ? <Brain /> : null}
                {KIND_LABELS[memory.kind]}
              </Badge>
              {memory.project && <Badge variant="secondary">{memory.project}</Badge>}
              <Badge variant={memory.certainty === "UNCERTAIN" ? "outline" : "secondary"} title={memory.certainty === "UNCERTAIN" ? "Présenté au modèle comme non confirmé" : undefined}>
                {CERTAINTY_LABELS[memory.certainty]}
              </Badge>
              <span>{SOURCE_LABELS[memory.source]}</span>
              {memory.mentionCount > 1 && <span>· exprimé {memory.mentionCount} fois</span>}
              <span>· mis à jour {formatDate(memory.updatedAt)}</span>
              {memory.useCount > 0 && <span>· utilisé {memory.useCount} fois</span>}
            </p>
          </div>
          {memory.certainty === "UNCERTAIN" && (
            <Button variant="ghost" size="icon-sm" onClick={() => patch({ certainty: "CONFIRMED" }, "Souvenir confirmé.")} disabled={busy} aria-label="Confirmer ce souvenir" title="Confirmer">
              <CheckCheck />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => setEditing(true)} aria-label="Modifier ce souvenir" title="Modifier">
            <Pencil />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={remove} disabled={busy} aria-label="Oublier ce souvenir" title="Oublier (avec son historique)">
            <Trash2 />
          </Button>
        </div>
      )}
      {history.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <History className="size-3.5" /> Remplace {history.length} version(s) précédente(s)
            <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 flex flex-col gap-1 border-l-2 border-border pl-3 text-xs text-muted-foreground">
              {history.map((h) => (
                <li key={h.id}>
                  <span className="line-through">{h.content}</span> · jusqu&apos;au {formatDate(h.updatedAt)}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </li>
  );
}
