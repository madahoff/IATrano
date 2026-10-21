import { requirePagePermission } from "@/lib/auth/guard";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { AdminShell } from "@/components/admin/admin-shell";

// Toutes les pages /admin exigent la permission côté serveur (404 sinon) ; chaque route API la revérifie.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePagePermission("admin:access");
  return <AdminShell subtitle={`${user.name} · ${ROLE_LABELS[user.role]}`}>{children}</AdminShell>;
}
