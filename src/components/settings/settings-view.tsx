"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { Bot, Laptop, Loader2, LogOut, Monitor, Moon, Palette, Save, Server, Shield, Sun, User } from "lucide-react";
import { toast } from "sonner";
import type { Role } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Field, Panel, Section } from "@/components/layout/page-shell";
import { logout } from "@/components/layout/user-menu";
import { api, ApiError } from "@/lib/client/api";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { formatDate } from "@/lib/format";
import type { ModelInfo } from "@/lib/llm/types";
import { cn } from "@/lib/utils";
import { useMounted } from "@/hooks/use-mounted";

type Props = {
  user: { id: string; name: string; email: string; role: Role };
  isAdmin: boolean;
  preferences: { defaultModel: string | null; thinkingDefault: boolean | null; clarificationsEnabled: boolean | null; webSearchDefault: boolean | null };
  app: { providerLabel: string; defaultModel: string | null; thinkingDefault: boolean; clarificationsEnabled: boolean; webSearchAutoDefault: boolean; webSearchEnabled: boolean };
};

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function SettingsView(props: Props) {
  return (
    <Tabs defaultValue="account" className="gap-4">
      <TabsList className="h-11 w-full justify-start overflow-x-auto rounded-full bg-muted p-1 sm:w-fit">
        <TabsTrigger value="account" className="rounded-full px-4"><User /> Compte</TabsTrigger>
        <TabsTrigger value="ai" className="rounded-full px-4"><Bot /> IA</TabsTrigger>
        <TabsTrigger value="sessions" className="rounded-full px-4"><Shield /> Sessions</TabsTrigger>
        <TabsTrigger value="appearance" className="rounded-full px-4"><Palette /> Apparence</TabsTrigger>
      </TabsList>
      <TabsContent value="account"><AccountTab {...props} /></TabsContent>
      <TabsContent value="ai"><AiTab {...props} /></TabsContent>
      <TabsContent value="sessions"><SessionsTab /></TabsContent>
      <TabsContent value="appearance"><AppearanceTab /></TabsContent>
    </Tabs>
  );
}

function AccountTab({ user }: Props) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [currentPassword, setCurrentPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const emailChanged = email.trim().toLowerCase() !== user.email;

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/api/me", { method: "PATCH", json: { name, email, currentPassword: emailChanged ? currentPassword : undefined } });
      toast.success("Profil mis à jour.");
      setCurrentPassword("");
    } catch (err) {
      toast.error(errMsg(err, "Mise à jour impossible."));
    } finally {
      setSaving(false);
    }
  }

  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwSaving, setPwSaving] = useState(false);
  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (pw.next !== pw.confirm) {
      toast.error("Les deux mots de passe ne correspondent pas.");
      return;
    }
    setPwSaving(true);
    try {
      await api("/api/me/password", { method: "POST", json: { currentPassword: pw.current, newPassword: pw.next } });
      toast.success("Mot de passe modifié. Vos autres sessions ont été déconnectées.");
      setPw({ current: "", next: "", confirm: "" });
    } catch (err) {
      toast.error(errMsg(err, "Changement impossible."));
    } finally {
      setPwSaving(false);
    }
  }

  return (
    <>
      <Section title="Profil" description={<>Rôle : <Badge variant="secondary">{ROLE_LABELS[user.role]}</Badge></>}>
        <form onSubmit={saveProfile} className="flex flex-col gap-4">
          <Field label="Nom affiché" htmlFor="name">
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          </Field>
          <Field label="Adresse e-mail (identifiant de connexion)" htmlFor="email">
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          {emailChanged && (
            <Field label="Mot de passe actuel" htmlFor="cur-email" hint="Requis pour changer d'identifiant de connexion.">
              <Input id="cur-email" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
            </Field>
          )}
          <div>
            <Button type="submit" disabled={saving}>{saving ? <Loader2 className="animate-spin" /> : <Save />} Enregistrer</Button>
          </div>
        </form>
      </Section>
      <Section title="Mot de passe" description="Au moins 10 caractères. Les autres appareils connectés seront déconnectés.">
        <form onSubmit={changePassword} className="flex flex-col gap-4">
          <Field label="Mot de passe actuel" htmlFor="pw-cur">
            <Input id="pw-cur" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nouveau mot de passe" htmlFor="pw-new">
              <Input id="pw-new" type="password" autoComplete="new-password" minLength={10} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
            </Field>
            <Field label="Confirmation" htmlFor="pw-confirm">
              <Input id="pw-confirm" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
            </Field>
          </div>
          <div>
            <Button type="submit" variant="secondary" disabled={pwSaving || !pw.current || !pw.next}>
              {pwSaving && <Loader2 className="animate-spin" />} Changer le mot de passe
            </Button>
          </div>
        </form>
      </Section>
      <Section title="Session" description="Pour changer de profil, déconnectez-vous puis connectez-vous avec un autre compte.">
        <Button variant="secondary" onClick={logout}><LogOut /> Se déconnecter</Button>
      </Section>
    </>
  );
}

type TriState = "inherit" | "on" | "off";
const toTri = (v: boolean | null): TriState => (v === null ? "inherit" : v ? "on" : "off");
const fromTri = (v: TriState): boolean | null => (v === "inherit" ? null : v === "on");

function AiTab({ preferences, app, isAdmin }: Props) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [reachable, setReachable] = useState(true);
  const [defaultModel, setDefaultModel] = useState(preferences.defaultModel ?? "inherit");
  const [thinking, setThinking] = useState<TriState>(toTri(preferences.thinkingDefault));
  const [clarify, setClarify] = useState<TriState>(toTri(preferences.clarificationsEnabled));
  const [webSearch, setWebSearch] = useState<TriState>(toTri(preferences.webSearchDefault));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ models: ModelInfo[]; provider: { reachable: boolean } }>("/api/models")
      .then((d) => {
        setModels(d.models);
        setReachable(d.provider.reachable);
      })
      .catch(() => setReachable(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      await api("/api/me/settings", {
        method: "PATCH",
        json: { defaultModel: defaultModel === "inherit" ? null : defaultModel, thinkingDefault: fromTri(thinking), clarificationsEnabled: fromTri(clarify), webSearchDefault: fromTri(webSearch) },
      });
      toast.success("Préférences enregistrées.");
    } catch (err) {
      toast.error(errMsg(err, "Enregistrement impossible."));
    } finally {
      setSaving(false);
    }
  }

  const onOff = (v: boolean) => (v ? "activé" : "désactivé");
  const modelMissing = defaultModel !== "inherit" && models !== null && !models.some((m) => m.id === defaultModel);

  return (
    <>
      <Section title="Préférences personnelles" description="Elles s'appliquent à vos nouvelles conversations et priment sur les réglages de l'application.">
        <div className="flex flex-col gap-5">
          <Field
            label="Modèle par défaut"
            hint={modelMissing ? <span className="text-warning-foreground">Ce modèle n&apos;est plus détecté sur le serveur.</span> : `Par défaut de l'application : ${app.defaultModel ?? "premier modèle détecté"}.`}
          >
            <Select value={defaultModel} onValueChange={setDefaultModel}>
              <SelectTrigger className="w-full sm:w-96"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Utiliser le défaut de l&apos;application</SelectItem>
                {modelMissing && <SelectItem value={defaultModel}>{defaultModel} (indisponible)</SelectItem>}
                {models?.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Thinking par défaut" hint="Uniquement pour les modèles qui prennent en charge le raisonnement ; modifiable à chaque message.">
            <Select value={thinking} onValueChange={(v) => setThinking(v as TriState)}>
              <SelectTrigger className="w-full sm:w-96"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Défaut de l&apos;application ({onOff(app.thinkingDefault)})</SelectItem>
                <SelectItem value="on">Activé</SelectItem>
                <SelectItem value="off">Désactivé</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Questions de précision" hint="L'IA peut proposer des questions avec des réponses à choisir lorsque votre demande est ambiguë.">
            <Select value={clarify} onValueChange={(v) => setClarify(v as TriState)}>
              <SelectTrigger className="w-full sm:w-96"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Défaut de l&apos;application ({onOff(app.clarificationsEnabled)})</SelectItem>
                <SelectItem value="on">Activées</SelectItem>
                <SelectItem value="off">Désactivées</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Recherche Web automatique"
            hint={app.webSearchEnabled ? "État initial du bouton « Recherche » dans vos nouvelles conversations. Activée, l'IA cherche sur Internet seulement quand la question le nécessite." : "La recherche Web est actuellement désactivée par l'administration."}
          >
            <Select value={webSearch} onValueChange={(v) => setWebSearch(v as TriState)} disabled={!app.webSearchEnabled}>
              <SelectTrigger className="w-full sm:w-96"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Défaut de l&apos;application ({onOff(app.webSearchAutoDefault)})</SelectItem>
                <SelectItem value="on">Activée</SelectItem>
                <SelectItem value="off">Désactivée</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div>
            <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="animate-spin" /> : <Save />} Enregistrer</Button>
          </div>
        </div>
      </Section>
      <Section title="Serveur IA" description="Le serveur IA est commun à tous les utilisateurs et configuré par l'administration.">
        <Panel className="flex flex-col gap-3 text-sm">
          <p className="flex items-center gap-2">
            <Server className="size-4 text-muted-foreground" /> {app.providerLabel}
            <Badge variant={reachable ? "success" : "warning"}>{reachable ? "Joignable" : "Injoignable"}</Badge>
          </p>
          <p className="text-muted-foreground">
            La détection des modèles est effectuée par le serveur de l&apos;application, jamais par votre navigateur : un navigateur ne peut pas
            découvrir les modèles installés sur un autre appareil. L&apos;adresse que vous utilisez pour ouvrir IATrano est donc indépendante de
            celle du moteur IA.
          </p>
          {isAdmin && (
            <Button asChild variant="secondary" size="sm" className="w-fit bg-background">
              <Link href="/admin/ai">Configurer le serveur IA</Link>
            </Button>
          )}
        </Panel>
      </Section>
    </>
  );
}

type SessionRow = { id: string; userAgent: string | null; ip: string | null; createdAt: string; lastUsedAt: string; current: boolean };

function describeAgent(ua: string | null) {
  if (!ua) return "Appareil inconnu";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows" : /Mac OS/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl/i.test(ua) ? "curl" : "Navigateur";
  return [browser, os].filter(Boolean).join(" · ");
}

function SessionsTab() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const load = () => api<{ sessions: SessionRow[] }>("/api/me/sessions").then((d) => setSessions(d.sessions)).catch(() => setSessions([]));
  useEffect(() => {
    void load();
  }, []);

  async function revoke(body: { sessionId?: string; others?: boolean }) {
    try {
      await api("/api/me/sessions", { method: "DELETE", json: body });
      toast.success("Session(s) révoquée(s).");
      void load();
    } catch (err) {
      toast.error(errMsg(err, "Révocation impossible."));
    }
  }

  return (
    <Section
      title="Sessions actives"
      description="Appareils actuellement connectés à votre compte."
      actions={sessions && sessions.length > 1 ? <Button variant="secondary" size="sm" onClick={() => revoke({ others: true })}>Déconnecter les autres</Button> : null}
    >
      {!sessions ? (
        <Loader2 className="animate-spin text-muted-foreground" />
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 rounded-2xl bg-muted px-4 py-3">
              <Laptop className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="flex items-center gap-2 font-medium">
                  {describeAgent(s.userAgent)} {s.current && <Badge variant="success">Cette session</Badge>}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  Dernière activité {formatDate(s.lastUsedAt)}{s.ip && s.ip !== "local" ? ` · ${s.ip}` : ""}
                </p>
              </div>
              {!s.current && <Button variant="ghost" size="sm" onClick={() => revoke({ sessionId: s.id })}>Révoquer</Button>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function AppearanceTab() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const options = [
    { value: "light", label: "Clair", icon: Sun },
    { value: "dark", label: "Sombre", icon: Moon },
    { value: "system", label: "Système", icon: Monitor },
  ];
  const map: Record<string, string> = { system: "SYSTEM", light: "LIGHT", dark: "DARK" };
  return (
    <Section title="Thème" description="Le mode Système suit le réglage de votre appareil.">
      <div className="grid grid-cols-3 gap-2 sm:w-fit">
        {options.map(({ value, label, icon: Icon }) => {
          const active = mounted && theme === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setTheme(value);
                void api("/api/me/settings", { method: "PATCH", json: { theme: map[value] } }).catch(() => {});
              }}
              className={cn(
                "flex flex-col items-center gap-2 rounded-2xl px-6 py-4 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                active ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-accent",
              )}
            >
              <Icon className="size-5" />
              {label}
            </button>
          );
        })}
      </div>
    </Section>
  );
}
