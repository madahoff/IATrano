"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, MessageSquare } from "lucide-react";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PageShell, Panel, Section } from "@/components/layout/page-shell";
import { MemoryManager } from "@/components/memory/memory-manager";
import { DocumentLibrary } from "@/components/documents/document-library";
import type { ProjectDTO } from "@/lib/projects/service";
import type { ConversationSummary } from "@/lib/chat/protocol";
import { formatDate } from "@/lib/format";


export function ProjectDetailView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [project, setProject] = useState<ProjectDTO | null>(null); const [instructions, setInstructions] = useState(""); const [busy, setBusy] = useState(false);
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
  useEffect(() => { let cancelled = false; void api<{ project: ProjectDTO }>(`/api/projects/${projectId}`).then((p) => { if (cancelled) return; setProject(p.project); setInstructions(p.project.instructions ?? ""); }); return () => { cancelled = true; }; }, [projectId]);
  async function save() { setBusy(true); try { const d = await api<{ project: ProjectDTO }>(`/api/projects/${projectId}`, { method: "PATCH", json: { instructions } }); setProject(d.project); } finally { setBusy(false); } }
  if (!project) return <PageShell title="Projet"><Loader2 className="animate-spin" /></PageShell>;
  return <PageShell title={project.name} subtitle="Espace de travail partagé" nav={<Button variant="ghost" asChild><Link href="/projects"><ArrowLeft /> Projets</Link></Button>}>
    <div className="mb-4 flex flex-wrap gap-2"><Button asChild><Link href={`/?projectId=${project.id}`}>Nouvelle conversation</Link></Button><Button variant="secondary" onClick={() => void api(`/api/projects/${projectId}`, { method: "DELETE" }).then(() => router.push("/projects"))}>Supprimer le projet</Button></div>
    <Section title="Conversations du projet" description="Elles partagent les instructions, les documents et la mémoire de ce projet.">
      {conversations === null ? <Loader2 className="animate-spin text-muted-foreground" /> : conversations.length === 0 ? <p className="text-sm text-muted-foreground">Aucune conversation pour l&apos;instant.</p> : (
        <div className="flex flex-col gap-2">{conversations.map((c) => <Panel key={c.id} className="p-0"><Link href={`/c/${c.id}`} className="flex items-center gap-3 rounded-2xl p-3 outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"><MessageSquare className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{c.title}</span><span className="shrink-0 text-xs text-muted-foreground">{formatDate(c.updatedAt)}</span></Link></Panel>)}</div>
      )}
    </Section>
    <Section title="Instructions du projet" description="Elles sont ajoutées au contexte de chaque conversation du projet."><Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={5} placeholder="Ex. Réponds comme un analyste…" /><Button className="mt-3" onClick={() => void save()} disabled={busy}>Enregistrer</Button></Section>
    <DocumentLibrary projectId={project.id} />
    <Section title="Mémoire du projet" description="Décisions, contraintes et contexte retenus des conversations de ce projet, ou ajoutés par vous. Ils ne sont utilisés que dans ce projet, et seulement quand ils sont pertinents."><MemoryManager fixedProjectId={project.id} /></Section>
  </PageShell>;
}
