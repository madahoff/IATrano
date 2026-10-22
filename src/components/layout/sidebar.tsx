"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Search,
  SquarePen,
  Trash2,
  X,
  FolderKanban,
  FolderOpen,
  ChevronRight,
  Plus,
  FolderInput,
  FolderMinus,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Logo } from "@/components/common/logo";
import { api, ApiError } from "@/lib/client/api";
import { dateGroup, type DateGroup } from "@/lib/format";
import type { ConversationSummary } from "@/lib/chat/protocol";
import { cn } from "@/lib/utils";
import { useApp } from "./app-context";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { UserMenu } from "./user-menu";

type ProjectRef = { id: string; name: string };

/**
 * Glisser-déposer des conversations : vers un projet (rattachement), vers « Retirer du projet »,
 * ou vers la corbeille (suppression confirmée). Les mêmes actions existent dans le menu « … »
 * pour le clavier et les écrans tactiles (le glisser-déposer HTML ne fonctionne pas au doigt).
 */
type DndValue = {
  projects: ProjectRef[];
  dragging: ConversationSummary | null;
  setDragging: (c: ConversationSummary | null) => void;
  moveTo: (c: ConversationSummary, projectId: string | null) => void;
  requestDelete: (c: ConversationSummary) => void;
};
const DndContext = createContext<DndValue | null>(null);
const useDnd = () => useContext(DndContext)!;
const DRAG_TYPE = "application/x-iatrano-conversation";

const GROUP_ORDER: DateGroup[] = ["Aujourd'hui", "Hier", "7 derniers jours", "30 derniers jours", "Plus ancien"];

export function Sidebar({ onClose, onCollapse }: { onClose?: () => void; onCollapse?: () => void }) {
  const { conversations, startNewChat, upsertConversation, removeConversation } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const [dragging, setDragging] = useState<ConversationSummary | null>(null);
  const [overZone, setOverZone] = useState<"trash" | "unlink" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);
  // Projet de la page affichée : conversation de projet (/c/<id>) ou nouvelle conversation de projet (/?projectId=).
  const activeProjectId = () => {
    const convId = pathname.startsWith("/c/") ? pathname.slice(3) : null;
    if (convId) return conversations.find((c) => c.id === convId)?.projectId ?? null;
    return pathname === "/" ? new URLSearchParams(window.location.search).get("projectId") : null;
  };
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [results, setResults] = useState<ConversationSummary[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Recherche dans la base (titres + contenu des messages), avec anti-rebond.
  useEffect(() => {
    const q = query.trim();
    if (!q && !showArchived) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (showArchived && !q) params.set("archived", "1");
        const data = await api<{ conversations: ConversationSummary[] }>(`/api/conversations?${params}`, { signal: ctrl.signal });
        setResults(data.conversations);
      } catch (err) {
        if (!ctrl.signal.aborted) toast.error(err instanceof Error ? err.message : "Recherche impossible.");
      } finally {
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, q ? 250 : 0);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, showArchived, conversations]);

  // Projets (section « Projets » en bas de la liste) : rechargés quand la liste des conversations change.
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const projectKey = conversations.map((c) => c.projectId ?? "").join(",");
  useEffect(() => {
    const ctrl = new AbortController();
    api<{ projects: Array<{ id: string; name: string }> }>("/api/projects", { signal: ctrl.signal })
      .then((d) => setProjects(d.projects.map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => {});
    return () => ctrl.abort();
  }, [projectKey]);

  async function moveTo(c: ConversationSummary, projectId: string | null) {
    if ((c.projectId ?? null) === projectId) return;
    try {
      const { conversation } = await api<{ conversation: ConversationSummary }>(`/api/conversations/${c.id}`, { method: "PATCH", json: { projectId } });
      upsertConversation({ ...conversation, updatedAt: c.updatedAt });
      const name = projects.find((p) => p.id === projectId)?.name;
      toast.success(projectId ? `« ${c.title} » ajoutée au projet « ${name ?? "?"} ».` : `« ${c.title} » retirée du projet.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Déplacement impossible.");
    }
  }

  async function confirmDelete() {
    const c = pendingDelete;
    setPendingDelete(null);
    if (!c) return;
    try {
      await api(`/api/conversations/${c.id}`, { method: "DELETE" });
      removeConversation(c.id);
      toast.success("Conversation supprimée.");
      if (pathname === `/c/${c.id}`) router.push(c.projectId ? `/?projectId=${encodeURIComponent(c.projectId)}` : "/");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Suppression impossible.");
    }
  }

  const dnd: DndValue = { projects, dragging, setDragging, moveTo: (c, p) => void moveTo(c, p), requestDelete: setPendingDelete };
  const dropZone = (zone: "trash" | "unlink") => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOverZone(zone);
    },
    onDragLeave: () => setOverZone((z) => (z === zone ? null : z)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const c = dragging;
      setOverZone(null);
      setDragging(null);
      if (!c) return;
      if (zone === "trash") setPendingDelete(c);
      else void moveTo(c, null);
    },
  });

  const filtering = Boolean(query.trim()) || showArchived;
  const list = useMemo(() => (filtering ? (results ?? []) : conversations.filter((c) => !c.archived)), [filtering, results, conversations]);
  const groups = useMemo(() => {
    if (query.trim() || showArchived) return null;
    const map = new Map<DateGroup, ConversationSummary[]>();
    const now = new Date();
    // Les conversations de projet sont rangées sous leur projet (section « Projets »), pas par date.
    for (const c of list.filter((x) => !x.projectId)) {
      const g = dateGroup(c.updatedAt, now);
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ label: g, items: map.get(g)! }));
  }, [list, query, showArchived]);

  return (
    <DndContext.Provider value={dnd}>
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <Link href="/" onClick={startNewChat} className="flex items-center gap-2 rounded-full px-1.5 py-1 font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <Logo className="size-7" />
          IATrano
        </Link>
        <div className="flex items-center gap-0.5">
          {onCollapse && (
            <Button variant="ghost" size="icon-sm" onClick={onCollapse} aria-label="Masquer la barre latérale" className="text-muted-foreground">
              <PanelLeftClose />
            </Button>
          )}
          {onClose && (
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fermer le menu" className="text-muted-foreground">
              <X />
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5 px-3 pb-2">
        <Button
          data-mascot-attention
          variant="ghost"
          className="h-10 justify-start gap-2.5 px-3 hover:bg-sidebar-accent"
          onClick={() => {
            // Depuis un projet, la nouvelle conversation reste dans ce projet (contexte partagé).
            const projectId = activeProjectId();
            startNewChat();
            router.push(projectId ? `/?projectId=${encodeURIComponent(projectId)}` : "/");
            onClose?.();
          }}
        >
          <SquarePen />
          Nouvelle conversation
        </Button>
        <Button variant="ghost" className="h-10 justify-start gap-2.5 px-3 hover:bg-sidebar-accent" asChild>
          <Link href="/projects" onClick={() => onClose?.()}><FolderKanban /> Projets</Link>
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setResults(null);
            }}
            placeholder="Rechercher"
            aria-label="Rechercher dans les conversations"
            className="h-10 rounded-full bg-sidebar-accent/70 pl-9"
          />
          {searching && <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="Conversations">
        {showArchived && !query && <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">Conversations archivées</p>}
        {query && <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">Résultats</p>}
        {/* Projets en tête de liste, avant les conversations groupées par date. */}
        {groups && projects.length > 0 && <ProjectsSection projects={projects} conversations={list} onNavigate={onClose} />}
        {groups
          ? groups.map((g) => (
              <section key={g.label} className="mt-3 first:mt-1">
                <h2 className="px-3 pb-1 text-xs font-medium text-muted-foreground">{g.label}</h2>
                <ul className="flex flex-col gap-0.5">
                  {g.items.map((c) => (
                    <ConversationItem key={c.id} conversation={c} />
                  ))}
                </ul>
              </section>
            ))
          : (
            <ul className="flex flex-col gap-0.5">
              {list.map((c) => (
                <ConversationItem key={c.id} conversation={c} showSnippet />
              ))}
            </ul>
          )}
        {list.length === 0 && projects.length === 0 && !searching && (!filtering || results !== null) && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
            <MessageSquare className="size-5" />
            {query ? "Aucune conversation ne correspond." : showArchived ? "Aucune conversation archivée." : "Aucune conversation pour le moment."}
          </div>
        )}
      </nav>

      {dragging && (
        // Zones de dépôt affichées pendant le glisser : retirer du projet, corbeille.
        <div className="flex flex-col gap-1.5 px-3 pb-2" aria-live="polite">
          {dragging.projectId && (
            <div
              {...dropZone("unlink")}
              className={cn(
                "flex h-11 items-center justify-center gap-2 rounded-2xl bg-sidebar-accent text-sm text-muted-foreground transition-colors",
                overZone === "unlink" && "bg-primary text-primary-foreground",
              )}
            >
              <FolderMinus className="size-4" /> Retirer du projet
            </div>
          )}
          <div
            {...dropZone("trash")}
            className={cn(
              "flex h-14 items-center justify-center gap-2 rounded-2xl bg-destructive/10 text-sm font-medium text-destructive transition-all",
              overZone === "trash" && "scale-[1.03] bg-destructive text-white",
            )}
          >
            <Trash2 className={cn("size-5 transition-transform", overZone === "trash" && "-rotate-12 scale-110")} />
            {overZone === "trash" ? "Relâcher pour supprimer" : "Glisser ici pour supprimer"}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1 px-3 pb-3">
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-9 justify-start gap-2.5 px-3 text-muted-foreground hover:bg-sidebar-accent", showArchived && "bg-sidebar-accent text-foreground")}
          onClick={() => {
            setResults(null);
            setShowArchived((s) => !s);
          }}
          aria-pressed={showArchived}
        >
          <Archive />
          {showArchived ? "Retour aux conversations" : "Archives"}
        </Button>
        <UserMenu />
      </div>
      <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer la conversation ?</AlertDialogTitle>
            <AlertDialogDescription>
              « {pendingDelete?.title} » et tous ses messages seront définitivement supprimés. Cette action est irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </DndContext.Provider>
  );
}

/**
 * Section « Projets » : chaque projet avec ses conversations en arborescence (branches),
 * repliable, avec un raccourci pour démarrer une conversation dans le projet.
 */
function ProjectsSection({ projects, conversations, onNavigate }: { projects: Array<{ id: string; name: string }>; conversations: ConversationSummary[]; onNavigate?: () => void }) {
  const { startNewChat } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const { dragging, setDragging, moveTo } = useDnd();
  const [over, setOver] = useState<string | null>(null);
  const [collapsedRaw, setCollapsedRaw] = useLocalStorage("iatrano:sidebar-collapsed-projects");
  const collapsed = new Set((collapsedRaw ?? "").split(",").filter(Boolean));
  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsedRaw([...next].join(","));
  };
  return (
    <section className="mt-1">
      <h2 className="px-3 pb-1 text-xs font-medium text-muted-foreground">Projets</h2>
      <ul className="flex flex-col gap-0.5">
        {projects.map((p) => {
          const items = conversations.filter((c) => c.projectId === p.id);
          const open = !collapsed.has(p.id);
          const active = pathname === `/projects/${p.id}`;
          return (
            <li key={p.id}>
              <div
                // Cible de dépôt : rattache la conversation glissée à ce projet.
                onDragOver={(e) => {
                  if (!dragging || dragging.projectId === p.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setOver(p.id);
                }}
                onDragLeave={() => setOver((o) => (o === p.id ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  const c = dragging;
                  setDragging(null);
                  if (c) moveTo(c, p.id);
                }}
                className={cn(
                  "group/proj flex min-h-9 items-center gap-0.5 rounded-xl pr-1 transition-colors hover:bg-sidebar-accent",
                  active && "bg-sidebar-accent",
                  dragging && dragging.projectId !== p.id && "bg-sidebar-accent/60",
                  over === p.id && "bg-primary text-primary-foreground hover:bg-primary [&_svg]:text-primary-foreground",
                )}
              >
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-1 text-muted-foreground hover:bg-accent"
                  onClick={() => toggle(p.id)}
                  aria-expanded={open}
                  aria-label={`${open ? "Replier" : "Déplier"} le projet ${p.name}`}
                >
                  <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
                </Button>
                <Link
                  href={`/projects/${p.id}`}
                  onClick={() => onNavigate?.()}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pr-1 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {open ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" /> : <FolderKanban className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="truncate">{p.name}</span>
                  {!open && items.length > 0 && <span className="shrink-0 text-xs font-normal text-muted-foreground">{items.length}</span>}
                </Link>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground opacity-100 hover:bg-accent md:opacity-0 md:group-hover/proj:opacity-100 md:focus-visible:opacity-100"
                  aria-label={`Nouvelle conversation dans ${p.name}`}
                  onClick={() => {
                    startNewChat();
                    router.push(`/?projectId=${encodeURIComponent(p.id)}`);
                    onNavigate?.();
                  }}
                >
                  <Plus />
                </Button>
              </div>
              {open && (
                // Arborescence : un tronc vertical et une branche horizontale par conversation.
                <ul className="relative ml-[1.3rem] flex flex-col gap-0.5 pl-3 before:absolute before:top-0 before:bottom-[1.125rem] before:left-0 before:w-px before:bg-sidebar-foreground/15">
                  {items.map((c) => (
                    <ConversationItem key={c.id} conversation={c} inProject />
                  ))}
                  {items.length === 0 && (
                    <li className="relative px-3 py-1.5 text-xs text-muted-foreground before:absolute before:top-1/2 before:-left-3 before:h-px before:w-2.5 before:bg-sidebar-foreground/15">Aucune conversation</li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ConversationItem({ conversation, showSnippet, inProject }: { conversation: ConversationSummary; showSnippet?: boolean; inProject?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { upsertConversation, removeConversation, setConversations } = useApp();
  const { projects, dragging, setDragging, moveTo } = useDnd();
  const active = pathname === `/c/${conversation.id}`;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  async function rename() {
    const next = title.trim();
    setEditing(false);
    if (!next || next === conversation.title) {
      setTitle(conversation.title);
      return;
    }
    try {
      const { conversation: c } = await api<{ conversation: ConversationSummary }>(`/api/conversations/${conversation.id}`, { method: "PATCH", json: { title: next } });
      upsertConversation(c);
    } catch (err) {
      setTitle(conversation.title);
      toast.error(err instanceof ApiError ? err.message : "Renommage impossible.");
    }
  }

  async function setArchived(archived: boolean) {
    try {
      const { conversation: c } = await api<{ conversation: ConversationSummary }>(`/api/conversations/${conversation.id}`, { method: "PATCH", json: { archived } });
      setConversations((list) => list.map((x) => (x.id === c.id ? c : x)));
      toast.success(archived ? "Conversation archivée." : "Conversation restaurée.");
      if (archived && active) router.push("/");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Action impossible.");
    }
  }

  async function remove() {
    try {
      await api(`/api/conversations/${conversation.id}`, { method: "DELETE" });
      removeConversation(conversation.id);
      toast.success("Conversation supprimée.");
      if (active) router.push("/");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Suppression impossible.");
    }
  }

  if (editing) {
    return (
      <li>
        <Input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === "Enter") rename();
            if (e.key === "Escape") {
              setTitle(conversation.title);
              setEditing(false);
            }
          }}
          maxLength={120}
          aria-label="Nouveau titre"
          className="h-9 bg-sidebar-accent"
        />
      </li>
    );
  }

  return (
    <li className={cn("group/item relative", inProject && "before:absolute before:top-[1.125rem] before:-left-3 before:h-px before:w-2.5 before:bg-sidebar-foreground/15")}>
      <Link
        href={`/c/${conversation.id}`}
        draggable={!conversation.archived}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, conversation.id);
          e.dataTransfer.effectAllowed = "move";
          setDragging(conversation);
        }}
        onDragEnd={() => setDragging(null)}
        className={cn(
          "flex min-h-9 flex-col justify-center rounded-xl px-3 py-1.5 pr-9 text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50",
          active && "bg-sidebar-accent font-medium",
          dragging?.id === conversation.id && "opacity-40",
        )}
        aria-current={active ? "page" : undefined}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {conversation.projectId && !inProject && <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" aria-label="Conversation de projet" />}
          <span className="truncate">{conversation.title}</span>
        </span>
        {showSnippet && conversation.snippet && <span className="line-clamp-2 text-xs font-normal text-muted-foreground">{conversation.snippet}</span>}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              "absolute top-1.5 right-1.5 text-muted-foreground opacity-100 hover:bg-accent md:opacity-0 md:group-hover/item:opacity-100 md:focus-visible:opacity-100 md:data-[state=open]:opacity-100",
              active && "md:opacity-100",
            )}
            aria-label={`Actions pour ${conversation.title}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil /> Renommer
          </DropdownMenuItem>
          {conversation.archived ? (
            <DropdownMenuItem onSelect={() => setArchived(false)}>
              <ArchiveRestore /> Désarchiver
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => setArchived(true)}>
              <Archive /> Archiver
            </DropdownMenuItem>
          )}
          {projects.length > 0 && !conversation.archived && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderInput /> Déplacer vers un projet
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                {projects.map((p) => (
                  <DropdownMenuItem key={p.id} disabled={conversation.projectId === p.id} onSelect={() => moveTo(conversation, p.id)}>
                    <FolderKanban /> <span className="truncate">{p.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {conversation.projectId && (
            <DropdownMenuItem onSelect={() => moveTo(conversation, null)}>
              <FolderMinus /> Retirer du projet
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <Trash2 /> Supprimer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer la conversation ?</AlertDialogTitle>
            <AlertDialogDescription>
              « {conversation.title} » et tous ses messages seront définitivement supprimés. Cette action est irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
