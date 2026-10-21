export function formatBytes(bytes?: number): string | undefined {
  if (!bytes) return undefined;
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} Go` : `${Math.round(bytes / 1024 ** 2)} Mo`;
}

export function formatDuration(ms?: number | null): string | undefined {
  if (ms == null) return undefined;
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

const dateFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
export function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  return dateFmt.format(new Date(iso));
}

export type DateGroup = "Aujourd'hui" | "Hier" | "7 derniers jours" | "30 derniers jours" | "Plus ancien";

export function dateGroup(iso: string, now = new Date()): DateGroup {
  const d = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 3600_000;
  const t = d.getTime();
  if (t >= startOfToday) return "Aujourd'hui";
  if (t >= startOfToday - day) return "Hier";
  if (t >= startOfToday - 7 * day) return "7 derniers jours";
  if (t >= startOfToday - 30 * day) return "30 derniers jours";
  return "Plus ancien";
}
