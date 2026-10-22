"use client";

import { useEffect, useState } from "react";
import { GitMerge, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Panel, Section } from "@/components/layout/page-shell";
import { MemoryManager } from "@/components/memory/memory-manager";
import { api, ApiError } from "@/lib/client/api";

type Settings = { featureEnabled: boolean; enabled: boolean; autoSave: boolean };

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function MemoryView() {
  const [count, setCount] = useState<number | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api<{ memories: unknown[]; settings: Settings }>("/api/memories")
      .then((d) => {
        setCount(d.memories.length);
        setSettings(d.settings);
      })
      .catch((err) => toast.error(errMsg(err, "Mémoire indisponible.")));
  }, [refreshKey]);

  async function saveSettings(patch: { memoryEnabled?: boolean; memoryAutoSave?: boolean }) {
    try {
      const d = await api<{ settings: Settings }>("/api/memories/settings", { method: "PATCH", json: patch });
      setSettings(d.settings);
    } catch (err) {
      toast.error(errMsg(err, "Enregistrement impossible."));
    }
  }

  async function clearAll() {
    try {
      const d = await api<{ deleted: number }>("/api/memories", { method: "DELETE", json: { confirm: true } });
      setRefreshKey((k) => k + 1);
      toast.success(`${d.deleted} souvenir(s) effacé(s).`);
    } catch (err) {
      toast.error(errMsg(err, "Effacement impossible."));
    }
  }

  async function consolidate() {
    try {
      const d = await api<{ result: { merged: number; superseded: number } }>("/api/memories/consolidate", { method: "POST" });
      setRefreshKey((k) => k + 1);
      toast.success(d.result.merged || d.result.superseded ? `${d.result.merged} doublon(s) fusionné(s), ${d.result.superseded} information(s) obsolète(s) archivée(s).` : "Aucun doublon à fusionner.");
    } catch (err) {
      toast.error(errMsg(err, "Consolidation impossible."));
    }
  }

  if (count === null || !settings) return <Loader2 className="animate-spin text-muted-foreground" />;

  return (
    <>
      <Section
        title="Mémoire persistante"
        description="Des informations durables que l'IA peut réutiliser d'une conversation à l'autre. Elles vous sont propres : aucun autre compte, administrateurs compris, n'y a accès."
      >
        {!settings.featureEnabled ? (
          <Panel className="text-sm text-muted-foreground">La mémoire persistante est désactivée par l&apos;administration pour cette application.</Panel>
        ) : (
          <div className="flex flex-col gap-2">
            <ToggleRow
              id="mem-enabled"
              label="Utiliser la mémoire"
              hint="Seuls les souvenirs pertinents pour votre demande sont ajoutés au contexte du modèle, dans un budget limité. La mémoire d'un projet n'est utilisée que dans les conversations de ce projet."
              checked={settings.enabled}
              onChange={(v) => saveSettings({ memoryEnabled: v })}
            />
            <ToggleRow
              id="mem-auto"
              label="Enregistrement automatique"
              hint="L'IA retient d'elle-même les informations durables que vous exprimez (préférences, outils, projets, décisions) et met à jour celles qui changent. Désactivé, seules vos demandes explicites (« retiens que… », « oublie que… ») sont prises en compte. Les secrets ne sont jamais mémorisés, ni les informations personnelles sensibles sans demande explicite."
              checked={settings.autoSave}
              disabled={!settings.enabled}
              onChange={(v) => saveSettings({ memoryAutoSave: v })}
            />
          </div>
        )}
      </Section>

      <Section
        title="Ce que l'IA a mémorisé"
        description="Corrigez une formulation inexacte, confirmez une hypothèse ou oubliez ce qui n'est plus vrai : un souvenir oublié est supprimé avec son historique et ne sera pas recréé par une analyse en attente. Le résumé propre à chaque conversation est distinct : il se consulte depuis l'indicateur de contexte du chat."
        actions={
          count > 0 ? (
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={consolidate} title="Fusionne les doublons et archive les informations remplacées">
                <GitMerge /> Consolider
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm">
                    <Trash2 /> Tout effacer
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Effacer toute la mémoire ?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Les {count} souvenir(s) de votre compte (personnels et de vos projets) seront supprimés définitivement, ainsi que les analyses en attente. Vos conversations ne sont pas affectées.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Annuler</AlertDialogCancel>
                    <AlertDialogAction onClick={clearAll}>Tout effacer</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ) : null
        }
      >
        <MemoryManager refreshKey={refreshKey} />
      </Section>
    </>
  );
}

function ToggleRow({ id, label, hint, checked, disabled, onChange }: { id: string; label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-2xl bg-muted px-4 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}
