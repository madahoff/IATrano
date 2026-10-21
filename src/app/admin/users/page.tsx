import type { Metadata } from "next";
import { requirePagePermission } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { listUsers } from "@/lib/users/service";
import { UsersView } from "@/components/admin/users-view";

export const metadata: Metadata = { title: "Utilisateurs" };

export default async function AdminUsersPage() {
  const actor = await requirePagePermission("users:manage");
  return (
    <UsersView
      initial={await listUsers()}
      actor={{ id: actor.id, role: actor.role, canManageRoles: hasPermission(actor.role, "roles:manage") }}
    />
  );
}
