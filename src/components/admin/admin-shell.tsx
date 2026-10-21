"use client";

import { usePathname } from "next/navigation";
import { Activity, Bot, ScrollText, Users } from "lucide-react";
import { NavLinks, PageShell } from "@/components/layout/page-shell";

const ITEMS = [
  { href: "/admin", label: "État", icon: <Activity /> },
  { href: "/admin/ai", label: "Serveur IA", icon: <Bot /> },
  { href: "/admin/users", label: "Utilisateurs", icon: <Users /> },
  { href: "/admin/logs", label: "Journal", icon: <ScrollText /> },
];

export function AdminShell({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <PageShell title="Administration" subtitle={subtitle} nav={<NavLinks items={ITEMS} active={pathname} />}>
      {children}
    </PageShell>
  );
}
