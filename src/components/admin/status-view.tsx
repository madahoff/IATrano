"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Database, Loader2, RefreshCw, Server, TriangleAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel, Section } from "@/components/layout/page-shell";
import { api } from "@/lib/client/api";

type Status = {
  app: { version: string; node: string; uptimeSec: number; inDocker: boolean; env: string };
  database: { ok: boolean; latencyMs?: number; error?: string };
  ai: { ok: boolean; kind: string; baseUrl: string; version?: string; latencyMs: number; error?: string; hint?: string; defaultModel: string | null; defaultModelAvailable: boolean | null; models: number };
  counts: { users: number; conversations: number; messages: number; errors24h: number };
};

function Indicator({ ok, warn }: { ok: boolean; warn?: boolean }) {
  if (!ok) return <XCircle className="size-5 text-destructive" />;
  if (warn) return <TriangleAlert className="size-5 text-warning" />;
  return <CheckCircle2 className="size-5 text-success" />;
}

function uptime(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

export function StatusView() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api<Status>("/api/admin/status"));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    api<Status>("/api/admin/status")
      .then((s) => !cancelled && setStatus(s))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Section
      title="État de l'application"
      description="Vérification en direct de la base de données et du serveur IA."
      actions={<Button variant="secondary" size="sm" onClick={load} disabled={loading}>{loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Actualiser</Button>}
    >
      {!status ? (
        <Loader2 className="animate-spin text-muted-foreground" />
      ) : (
        <div className="flex flex-col gap-3">
          <Panel className="flex items-start gap-3">
            <Database className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">PostgreSQL</p>
              <p className="text-sm text-muted-foreground">{status.database.ok ? `Connectée · ${status.database.latencyMs} ms` : status.database.error}</p>
            </div>
            <Indicator ok={status.database.ok} />
          </Panel>
          <Panel className="flex items-start gap-3">
            <Server className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 text-sm">
              <p className="text-base font-medium">Serveur IA</p>
              <p className="break-all text-muted-foreground">{status.ai.kind === "OLLAMA" ? "Ollama" : "Compatible OpenAI"} · {status.ai.baseUrl}</p>
              {status.ai.ok ? (
                <p className="mt-1 text-muted-foreground">
                  Joignable en {status.ai.latencyMs} ms{status.ai.version ? ` · version ${status.ai.version}` : ""} · {status.ai.models} modèle(s) détecté(s)
                </p>
              ) : (
                <>
                  <p className="mt-1 text-destructive">{status.ai.error}</p>
                  {status.ai.hint && <p className="mt-1 text-muted-foreground">{status.ai.hint}</p>}
                </>
              )}
              <p className="mt-1">
                Modèle par défaut :{" "}
                {status.ai.defaultModel ? (
                  <>
                    {status.ai.defaultModel}{" "}
                    {status.ai.defaultModelAvailable === false && <Badge variant="warning">non détecté</Badge>}
                  </>
                ) : (
                  <span className="text-muted-foreground">non défini (premier modèle détecté)</span>
                )}
              </p>
              <Link href="/admin/ai" className="mt-2 inline-block font-medium underline underline-offset-4">Configurer</Link>
            </div>
            <Indicator ok={status.ai.ok} warn={status.ai.ok && (status.ai.models === 0 || status.ai.defaultModelAvailable === false)} />
          </Panel>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Utilisateurs", status.counts.users],
              ["Conversations", status.counts.conversations],
              ["Messages", status.counts.messages],
              ["Erreurs (24 h)", status.counts.errors24h],
            ].map(([label, value]) => (
              <Panel key={label as string} className="p-4">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
              </Panel>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Version {status.app.version} · Node {status.app.node} · {status.app.env} · {status.app.inDocker ? "dans Docker" : "hors Docker"} · en ligne depuis {uptime(status.app.uptimeSec)}
          </p>
        </div>
      )}
    </Section>
  );
}
