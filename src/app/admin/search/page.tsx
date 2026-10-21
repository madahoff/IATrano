import type { Metadata } from "next";
import { requirePagePermission } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { getAppSettings, publicAppSettings } from "@/lib/settings/service";
import { inDocker } from "@/lib/llm/url";
import { SearchSettingsView } from "@/components/admin/search-settings-view";

export const metadata: Metadata = { title: "Recherche Web" };

export default async function AdminSearchPage() {
  await requirePagePermission("settings:manage");
  const [settings, errors] = await Promise.all([
    getAppSettings(),
    db.errorLog.findMany({ where: { source: { startsWith: "search" } }, orderBy: { createdAt: "desc" }, take: 8 }),
  ]);
  return (
    <SearchSettingsView
      initial={publicAppSettings(settings)}
      inDocker={inDocker()}
      recentErrors={errors.map((e) => ({ id: e.id, level: e.level, source: e.source, message: e.message, createdAt: e.createdAt.toISOString() }))}
    />
  );
}
