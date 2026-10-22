"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FolderKanban, Loader2, Plus } from "lucide-react";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageShell, Panel, Section } from "@/components/layout/page-shell";
import type { ProjectDTO } from "@/lib/projects/service";

export function ProjectsView() {
  const [projects, setProjects] = useState<ProjectDTO[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<{ projects: ProjectDTO[] }>("/api/projects").then((d) => setProjects(d.projects)); }, []);
  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try { const d = await api<{ project: ProjectDTO }>("/api/projects", { method: "POST", json: { name } }); setProjects((p) => [d.project, ...(p ?? [])]); setName(""); } finally { setBusy(false); }
  }
  return <PageShell title="Projets" subtitle="Documents, mémoire et conversations partagés" nav={<Button variant="ghost" asChild><Link href="/">Retour au chat</Link></Button>}>
    <Section title="Créer un projet" description="Chaque projet isole ses documents et sa mémoire des autres projets.">
      <div className="flex gap-2"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du projet" onKeyDown={(e) => e.key === "Enter" && void create()} /><Button onClick={() => void create()} disabled={busy || !name.trim()}>{busy ? <Loader2 className="animate-spin" /> : <Plus />} Créer</Button></div>
    </Section>
    <Section title="Mes projets">
      {!projects ? <Loader2 className="animate-spin" /> : projects.length === 0 ? <p className="text-sm text-muted-foreground">Aucun projet pour le moment.</p> : <div className="grid gap-3 sm:grid-cols-2">{projects.map((p) => <Link key={p.id} href={`/projects/${p.id}`}><Panel className="h-full transition-colors hover:bg-accent"><FolderKanban className="mb-3 text-muted-foreground" /><h3 className="font-medium">{p.name}</h3><p className="mt-1 text-sm text-muted-foreground">{p.description || "Aucune description"}</p><p className="mt-3 text-xs text-muted-foreground">{p.documentCount ?? 0} document(s) · {p.conversationCount ?? 0} conversation(s) · {p.memoryCount ?? 0} mémoire(s)</p></Panel></Link>)}</div>}
    </Section>
  </PageShell>;
}
