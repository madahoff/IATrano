"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { UserMenu } from "./user-menu";

const GROUP_ORDER: DateGroup[] = ["Aujourd'hui", "Hier", "7 derniers jours", "30 derniers jours", "Plus ancien"];

export function Sidebar({ onClose, onCollapse }: { onClose?: () => void; onCollapse?: () => void }) {
  const { conversations, startNewChat } = useApp();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [results, setResults] = useState<ConversationSummary[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Recherche dans la base (titres + contenu des messages), avec anti-rebond.
  useEffect(() => {
    const q = query.trim();
    if (!q && !showArchived) {
      setResults(null);
      return;
    }
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

  const list = results ?? conversations.filter((c) => !c.archived);
  const groups = useMemo(() => {
    if (query.trim() || showArchived) return null;
    const map = new Map<DateGroup, ConversationSummary[]>();
    const now = new Date();
    for (const c of list) {
      const g = dateGroup(c.updatedAt, now);
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ label: g, items: map.get(g)! }));
  }, [list, query, showArchived]);

  return (
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
          variant="ghost"
          className="h-10 justify-start gap-2.5 px-3 hover:bg-sidebar-accent"
          onClick={() => {
            startNewChat();
            router.push("/");
            onClose?.();
          }}
        >
          <SquarePen />
          Nouvelle conversation
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
        {list.length === 0 && !searching && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
            <MessageSquare className="size-5" />
            {query ? "Aucune conversation ne correspond." : showArchived ? "Aucune conversation archivée." : "Aucune conversation pour le moment."}
          </div>
        )}
      </nav>

      <div className="flex flex-col gap-1 px-3 pb-3">
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-9 justify-start gap-2.5 px-3 text-muted-foreground hover:bg-sidebar-accent", showArchived && "bg-sidebar-accent text-foreground")}
          onClick={() => setShowArchived((s) => !s)}
          aria-pressed={showArchived}
        >
          <Archive />
          {showArchived ? "Retour aux conversations" : "Archives"}
        </Button>
        <UserMenu />
      </div>
    </div>
  );
}

function ConversationItem({ conversation, showSnippet }: { conversation: ConversationSummary; showSnippet?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { upsertConversation, removeConversation, setConversations } = useApp();
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
    <li className="group/item relative">
      <Link
        href={`/c/${conversation.id}`}
        className={cn(
          "flex min-h-9 flex-col justify-center rounded-xl px-3 py-1.5 pr-9 text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50",
          active && "bg-sidebar-accent font-medium",
        )}
        aria-current={active ? "page" : undefined}
      >
        <span className="truncate">{conversation.title}</span>
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
