"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Section } from "@/components/layout/page-shell";
import { api } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

type Log = { id: string; level: "INFO" | "WARN" | "ERROR"; source: string; message: string; details: unknown; createdAt: string };
const FILTERS = [
  { value: "", label: "Tout" },
  { value: "ERROR", label: "Erreurs" },
  { value: "WARN", label: "Avertissements" },
  { value: "INFO", label: "Infos" },
];

export function LogsView() {
  const [level, setLevel] = useState("");
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchLogs = useCallback(
    () =>
      api<{ logs: Log[] }>(`/api/admin/logs${level ? `?level=${level}` : ""}`)
        .then((d) => setLogs(d.logs))
        .catch(() => toast.error("Chargement du journal impossible.")),
    [level],
  );
  const load = useCallback(async () => {
    setLoading(true);
    await fetchLogs();
    setLoading(false);
  }, [fetchLogs]);
  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  async function clear() {
    await api("/api/admin/logs", { method: "DELETE" });
    toast.success("Journal vidé.");
    void load();
  }

  return (
    <Section
      title="Journal technique"
      description="Erreurs du serveur IA, échecs de connexion et événements d'administration (200 derniers). Les secrets sont masqués."
      actions={
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={load} disabled={loading}>{loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Actualiser</Button>
          <Button variant="destructive" size="sm" onClick={clear}><Trash2 /> Vider</Button>
        </div>
      }
    >
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setLevel(f.value)}
            aria-pressed={level === f.value}
            className={cn("rounded-full px-3.5 py-1.5 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50", level === f.value ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-accent")}
          >
            {f.label}
          </button>
        ))}
      </div>
      {logs && logs.length === 0 && <p className="text-sm text-muted-foreground">Aucun événement.</p>}
      <ul className="flex flex-col gap-1.5">
        {logs?.map((l) => (
          <li key={l.id}>
            <Collapsible className="rounded-2xl bg-muted">
              <CollapsibleTrigger className="group flex w-full items-start gap-3 rounded-2xl px-4 py-3 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <Badge variant={l.level === "ERROR" ? "destructive" : l.level === "WARN" ? "warning" : "secondary"} className="mt-0.5">{l.level}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="block break-words">{l.message}</span>
                  <span className="block text-xs text-muted-foreground">{formatDate(l.createdAt)} · {l.source}</span>
                </span>
                {l.details != null && <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />}
              </CollapsibleTrigger>
              {l.details != null && (
                <CollapsibleContent>
                  <pre className="mx-4 mb-3 overflow-x-auto rounded-xl bg-background p-3 font-mono text-xs">{JSON.stringify(l.details, null, 2)}</pre>
                </CollapsibleContent>
              )}
            </Collapsible>
          </li>
        ))}
      </ul>
    </Section>
  );
}
