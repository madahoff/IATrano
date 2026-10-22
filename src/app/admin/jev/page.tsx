import type { Metadata } from "next";
import { requirePagePermission } from "@/lib/auth/guard";
import { getJevSettings, publicJevSettings } from "@/lib/jev/settings";
import { JevConnectionView } from "@/components/admin/jev-connection-view";

export const metadata: Metadata = { title: "Connexion JEV" };

export default async function AdminJevPage() {
  await requirePagePermission("settings:manage");
  const settings = publicJevSettings(await getJevSettings());
  return <JevConnectionView initial={settings} />;
}
