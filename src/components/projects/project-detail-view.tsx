"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileText, Loader2, MessageSquare, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageShell, Panel, Section } from "@/components/layout/page-shell";
import { MemoryManager } from "@/components/memory/memory-manager";
import type { ProjectDTO } from "@/lib/projects/service";
import type { ConversationSummary } from "@/lib/chat/protocol";
import { formatDate } from "@/lib/format";

type Doc = { id: string; name: string; mimeType: string; sizeBytes: number; status: string; error: string | null; createdAt: string; _count: { chunks: number } };
const size = (n: number) => `${(n / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Ko`;

export function ProjectDetailView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [project, setProject] = useState<ProjectDTO | null>(null); const [docs, setDocs] = useState<Doc[]>([]); const [instructions, setInstructions] = useState(""); const [busy, setBusy] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{ conversations: ConversationSummary[] }>(`/api/conversations?projectId=${encodeURIComponent(projectId)}`)
      .then((d) => !cancelled && setConversations(d.conversations))
      .catch(() => !cancelled && setConversations([]));
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  async function load() { const [p, d] = await Promise.all([api<{ project: ProjectDTO }>(`/api/projects/${projectId}`), api<{ documents: Doc[] }>(`/api/projects/${projectId}/documents`)]); setProject(p.project); setInstructions(p.project.instructions ?? ""); setDocs(d.documents); }
  useEffect(() => { let cancelled = false; void Promise.all([api<{ project: ProjectDTO }>(`/api/projects/${projectId}`), api<{ documents: Doc[] }>(`/api/projects/${projectId}/documents`)]).then(([p, d]) => { if (cancelled) return; setProject(p.project); setInstructions(p.project.instructions ?? ""); setDocs(d.documents); }); return () => { cancelled = true; }; }, [projectId]);
  async function save() { setBusy(true); try { const d = await api<{ project: ProjectDTO }>(`/api/projects/${projectId}`, { method: "PATCH", json: { instructions } }); setProject(d.project); } finally { setBusy(false); } }
  async function upload(e: React.ChangeEvent<HTMLInputElement>) { const files = [...(e.target.files ?? [])]; if (!files.length) return; setBusy(true); try { const form = new FormData(); files.forEach((f) => form.append("files", f)); await api(`/api/projects/${projectId}/documents`, { method: "POST", body: form }); await load(); } catch (err) { alert(err instanceof ApiError ? err.message : "Import impossible."); } finally { setBusy(false); e.target.value = ""; } }
  if (!project) return <PageShell title="Projet"><Loader2 className="animate-spin" /></PageShell>;
  return <PageShell title={project.name} subtitle="Espace de travail partagé" nav={<Button variant="ghost" asChild><Link href="/projects"><ArrowLeft /> Projets</Link></Button>}>
    <div className="mb-4 flex flex-wrap gap-2"><Button asChild><Link href={`/?projectId=${project.id}`}>Nouvelle conversation</Link></Button><Button variant="secondary" onClick={() => void api(`/api/projects/${projectId}`, { method: "DELETE" }).then(() => router.push("/projects"))}>Supprimer le projet</Button></div>
    <Section title="Conversations du projet" description="Elles partagent les instructions, les documents et la mémoire de ce projet.">
      {conversations === null ? <Loader2 className="animate-spin text-muted-foreground" /> : conversations.length === 0 ? <p className="text-sm text-muted-foreground">Aucune conversation pour l&apos;instant.</p> : (
        <div className="flex flex-col gap-2">{conversations.map((c) => <Panel key={c.id} className="p-0"><Link href={`/c/${c.id}`} className="flex items-center gap-3 rounded-2xl p-3 outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"><MessageSquare className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{c.title}</span><span className="shrink-0 text-xs text-muted-foreground">{formatDate(c.updatedAt)}</span></Link></Panel>)}</div>
      )}
    </Section>
    <Section title="Instructions du projet" description="Elles sont ajoutées au contexte de chaque conversation du projet."><Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={5} placeholder="Ex. Réponds comme un analyste…" /><Button className="mt-3" onClick={() => void save()} disabled={busy}>Enregistrer</Button></Section>
    <Section title="Documents" description="Les documents sont découpés, indexés et analysés en arrière-plan ; ouvrez un document pour suivre sa couverture et consulter ses sources." actions={<label><Input type="file" multiple accept=".pdf,.docx,.pptx,.xlsx,.csv,.tsv,.txt,.md,.markdown,.json,.html,.png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm,.mp3,.wav,.m4a,.ogg" className="hidden" onChange={(e) => void upload(e)} /><Button variant="secondary" asChild><span><FileText /> Importer</span></Button></label>}>
      <div className="flex flex-col gap-2">{docs.length === 0 ? <p className="text-sm text-muted-foreground">Aucun document.</p> : docs.map((d) => <Panel key={d.id} className="flex items-center gap-3 p-3"><FileText className="shrink-0 text-muted-foreground" /><Link href={`/projects/${projectId}/documents/${d.id}`} className="min-w-0 flex-1"><p className="truncate text-sm font-medium hover:underline">{d.name}</p><p className="text-xs text-muted-foreground">{size(d.sizeBytes)} · {d._count.chunks} segment(s) · {d.status === "READY" ? "Prêt" : d.status === "ERROR" ? d.error : "Traitement"}</p></Link><Button variant="ghost" size="icon-sm" onClick={() => void api(`/api/projects/${projectId}/documents/${d.id}`, { method: "DELETE" }).then(() => load())} aria-label="Supprimer"><Trash2 /></Button></Panel>)}</div>
    </Section>
    <Section title="Mémoire du projet" description="Décisions, contraintes et contexte retenus des conversations de ce projet, ou ajoutés par vous. Ils ne sont utilisés que dans ce projet, et seulement quand ils sont pertinents."><MemoryManager fixedProjectId={project.id} /></Section>
  </PageShell>;
}
