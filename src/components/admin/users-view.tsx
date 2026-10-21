"use client";

import { useState } from "react";
import { Loader2, MoreHorizontal, Pencil, Plus, Trash2, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";
import type { Role } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
import { Field, Section } from "@/components/layout/page-shell";
import { initials } from "@/components/layout/user-menu";
import { api, ApiError } from "@/lib/client/api";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { formatDate } from "@/lib/format";

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  _count: { conversations: number; sessions: number };
};
type Actor = { id: string; role: Role; canManageRoles: boolean };

const RANK: Record<Role, number> = { USER: 0, ADMIN: 1, SUPERADMIN: 2 };
const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function UsersView({ initial, actor }: { initial: UserRow[]; actor: Actor }) {
  const [users, setUsers] = useState(initial);
  const [editing, setEditing] = useState<UserRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<UserRow | null>(null);

  const reload = async () => setUsers((await api<{ users: UserRow[] }>("/api/admin/users")).users);
  const canManage = (u: UserRow) => u.id !== actor.id && (actor.role === "SUPERADMIN" || RANK[u.role] < RANK[actor.role]);
  const assignable: Role[] = actor.canManageRoles ? ["USER", "ADMIN", "SUPERADMIN"] : ["USER"];

  async function toggleActive(u: UserRow) {
    try {
      await api(`/api/admin/users/${u.id}`, { method: "PATCH", json: { isActive: !u.isActive } });
      toast.success(u.isActive ? "Compte désactivé, sessions révoquées." : "Compte réactivé.");
      await reload();
    } catch (err) {
      toast.error(errMsg(err, "Action impossible."));
    }
  }

  async function remove(u: UserRow) {
    try {
      await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
      toast.success("Compte supprimé.");
      await reload();
    } catch (err) {
      toast.error(errMsg(err, "Suppression impossible."));
    }
  }

  return (
    <Section
      title="Utilisateurs"
      description={`${users.length} compte(s). Chaque utilisateur dispose de son propre espace et de ses conversations.`}
      actions={<Button size="sm" onClick={() => setEditing("new")}><Plus /> Nouvel utilisateur</Button>}
    >
      <ul className="flex flex-col gap-2">
        {users.map((u) => (
          <li key={u.id} className="flex items-center gap-3 rounded-2xl bg-muted px-4 py-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-background text-xs font-semibold">{initials(u.name)}</span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                <span className="truncate">{u.name}</span>
                {u.id === actor.id && <Badge variant="secondary">Vous</Badge>}
                <Badge variant={u.role === "USER" ? "secondary" : "default"}>{ROLE_LABELS[u.role]}</Badge>
                {!u.isActive && <Badge variant="destructive">Désactivé</Badge>}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {u.email} · {u._count.conversations} conversation(s) · dernière connexion {formatDate(u.lastLoginAt)}
              </p>
            </div>
            {canManage(u) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`Actions pour ${u.name}`}><MoreHorizontal /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem onSelect={() => setEditing(u)}><Pencil /> Modifier</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => toggleActive(u)}>{u.isActive ? <><UserX /> Désactiver</> : <><UserCheck /> Réactiver</>}</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(u)}><Trash2 /> Supprimer</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        ))}
      </ul>

      {editing && <UserDialog user={editing === "new" ? null : editing} assignable={assignable} onClose={() => setEditing(null)} onSaved={reload} />}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer {deleting?.name} ?</AlertDialogTitle>
            <AlertDialogDescription>Le compte et toutes ses conversations seront définitivement supprimés. Pour conserver les données, désactivez plutôt le compte.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && remove(deleting)}>Supprimer</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

function UserDialog({ user, assignable, onClose, onSaved }: { user: UserRow | null; assignable: Role[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "USER");
  const [password, setPassword] = useState("");
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const roles = assignable.includes(role) ? assignable : [role, ...assignable];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (user) {
        await api(`/api/admin/users/${user.id}`, {
          method: "PATCH",
          json: { name, email, ...(role !== user.role ? { role } : {}), isActive, ...(password ? { password } : {}) },
        });
        toast.success("Compte mis à jour.");
      } else {
        await api("/api/admin/users", { method: "POST", json: { name, email, role, password } });
        toast.success("Compte créé.");
      }
      await onSaved();
      onClose();
    } catch (err) {
      toast.error(errMsg(err, "Enregistrement impossible."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{user ? "Modifier le compte" : "Nouvel utilisateur"}</DialogTitle>
            <DialogDescription>{user ? "Un changement de rôle ou de mot de passe déconnecte l'utilisateur." : "Transmettez le mot de passe initial à l'utilisateur ; il pourra le modifier."}</DialogDescription>
          </DialogHeader>
          <Field label="Nom" htmlFor="u-name"><Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></Field>
          <Field label="E-mail" htmlFor="u-email"><Input id="u-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Rôle">
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {roles.map((r) => <SelectItem key={r} value={r} disabled={!assignable.includes(r)}>{ROLE_LABELS[r]}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label={user ? "Nouveau mot de passe (facultatif)" : "Mot de passe initial"} htmlFor="u-pw" hint="Au moins 10 caractères.">
            <Input id="u-pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required={!user} minLength={10} />
          </Field>
          {user && (
            <label className="flex items-center justify-between rounded-2xl bg-muted px-4 py-3 text-sm font-medium">
              Compte actif <Switch checked={isActive} onCheckedChange={setIsActive} />
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
            <Button type="submit" disabled={saving}>{saving && <Loader2 className="animate-spin" />} {user ? "Enregistrer" : "Créer"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
