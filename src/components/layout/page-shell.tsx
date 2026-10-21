import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/common/logo";
import { cn } from "@/lib/utils";

/** Mise en page commune des espaces Paramètres et Administration (hors chat). */
export function PageShell({
  title,
  subtitle,
  nav,
  children,
}: {
  title: string;
  subtitle?: string;
  nav?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-2 px-3 md:px-5">
        <Button variant="ghost" size="icon" asChild aria-label="Retour au chat">
          <Link href="/">
            <ArrowLeft />
          </Link>
        </Button>
        <Logo className="size-7" />
        <div className="min-w-0">
          <p className="truncate text-sm leading-tight font-semibold">{title}</p>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {nav && (
          <nav className="shrink-0 overflow-x-auto px-3 pb-2 md:w-60 md:overflow-visible md:px-4 md:pt-2" aria-label={`Navigation ${title}`}>
            {nav}
          </nav>
        )}
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 pt-2 pb-16 md:px-8 md:pt-4">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function NavLinks({ items, active }: { items: Array<{ href: string; label: string; icon: React.ReactNode }>; active: string }) {
  return (
    <ul className="flex gap-1 md:flex-col">
      {items.map((it) => {
        const isActive = active === it.href;
        return (
          <li key={it.href}>
            <Link
              href={it.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex h-10 items-center gap-2.5 rounded-full px-4 text-sm whitespace-nowrap outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 md:rounded-xl [&_svg]:size-4",
                isActive ? "bg-muted font-medium" : "text-muted-foreground",
              )}
            >
              {it.icon}
              {it.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function Section({ title, description, children, actions }: { title: string; description?: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="py-6 first:pt-2">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-3xl bg-muted p-4 md:p-5", className)}>{children}</div>;
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
