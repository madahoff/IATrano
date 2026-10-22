"use client";

import { usePathname } from "next/navigation";
import { Activity, Bot, Gauge, Globe, Route, ScrollText, Signpost, Users } from "lucide-react";
import { NavLinks, PageShell } from "@/components/layout/page-shell";
import { JevStatusPill } from "@/components/jev/jev-status-pill";

const ITEMS = [
  { href: "/admin", label: "État", icon: <Activity /> },
  { href: "/admin/ai", label: "Serveur IA", icon: <Bot /> },
  { href: "/admin/jev", label: "Connexion JEV", icon: <Signpost /> },
  { href: "/admin/routing", label: "Routage et autorisations", icon: <Route /> },
  { href: "/admin/search", label: "Recherche Web", icon: <Globe /> },
  { href: "/admin/context", label: "Contexte et mémoire", icon: <Gauge /> },
  { href: "/admin/users", label: "Utilisateurs", icon: <Users /> },
  { href: "/admin/logs", label: "Journal", icon: <ScrollText /> },
];

export function AdminShell({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <PageShell title="Administration" subtitle={subtitle} nav={<NavLinks items={ITEMS} active={pathname} />} headerExtra={<JevStatusPill href="/admin/jev" />}>
      {children}
    </PageShell>
  );
}
