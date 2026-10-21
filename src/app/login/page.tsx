import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureBootstrapped } from "@/lib/bootstrap";
import { db } from "@/lib/db";
import { LoginForm } from "@/components/common/login-form";
import { Logo } from "@/components/common/logo";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  await ensureBootstrapped();
  const hasAdmin = (await db.user.count({ where: { role: "SUPERADMIN" } })) > 0;
  return (
    <main className="flex h-full min-h-dvh items-center justify-center overflow-y-auto bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo className="size-11" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Connexion à IATrano</h1>
            <p className="mt-1 text-sm text-muted-foreground">Votre IA locale, privée et auto-hébergée.</p>
          </div>
        </div>
        {!hasAdmin && (
          <p className="mb-4 rounded-2xl bg-warning/15 px-4 py-3 text-sm text-warning-foreground">
            Aucun super-administrateur n&apos;est configuré. Définissez <code>SUPERADMIN_EMAIL</code> et{" "}
            <code>SUPERADMIN_PASSWORD</code> puis redémarrez l&apos;application.
          </p>
        )}
        <LoginForm />
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Les comptes sont créés par un administrateur.
        </p>
      </div>
    </main>
  );
}
