import type { Metadata } from "next";
import { requirePagePermission } from "@/lib/auth/guard";
import { getDocumentAdminView } from "@/lib/documents/admin";
import { DocumentsSettingsView } from "@/components/admin/documents-settings-view";

export const metadata: Metadata = { title: "Documents" };

export default async function AdminDocumentsPage() {
  await requirePagePermission("settings:manage");
  return <DocumentsSettingsView initial={await getDocumentAdminView()} />;
}
