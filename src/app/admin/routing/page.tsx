import type { Metadata } from "next";
import { requirePagePermission } from "@/lib/auth/guard";
import { getRoutingSettings, routingConfigFrom } from "@/lib/routing/service";
import { RoutingSettingsView } from "@/components/admin/routing-settings-view";

export const metadata: Metadata = { title: "Routage et autorisations" };

export default async function AdminRoutingPage() {
  await requirePagePermission("settings:manage");
  const settings = routingConfigFrom(await getRoutingSettings());
  return <RoutingSettingsView initial={settings} />;
}
