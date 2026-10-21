import type { Metadata } from "next";
import { requirePageUser } from "@/lib/auth/guard";
import { PageShell } from "@/components/layout/page-shell";
import { MemoryView } from "@/components/settings/memory-view";

export const metadata: Metadata = { title: "Mémoire" };

export default async function MemoryPage() {
  const user = await requirePageUser();
  return (
    <PageShell title="Mémoire" subtitle={user.email}>
      <MemoryView />
    </PageShell>
  );
}
