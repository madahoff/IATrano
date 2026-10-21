import type { Metadata } from "next";
import { requirePagePermission } from "@/lib/auth/guard";
import { LogsView } from "@/components/admin/logs-view";

export const metadata: Metadata = { title: "Journal" };

export default async function AdminLogsPage() {
  await requirePagePermission("diagnostics:view");
  return <LogsView />;
}
