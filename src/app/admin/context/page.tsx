import type { Metadata } from "next";
import { requirePagePermission } from "@/lib/auth/guard";
import { getContextAdminView } from "@/lib/context/admin";
import { ContextSettingsView } from "@/components/admin/context-settings-view";

export const metadata: Metadata = { title: "Contexte et mémoire" };

export default async function AdminContextPage() {
  await requirePagePermission("settings:manage");
  return <ContextSettingsView initial={await getContextAdminView()} />;
}
