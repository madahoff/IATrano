"use client";

import { createContext, useContext, useState } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { usePathname } from "next/navigation";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Sidebar } from "./sidebar";

type ShellContextValue = { openMobileNav: () => void; desktopCollapsed: boolean; toggleDesktop: () => void };
const ShellContext = createContext<ShellContextValue | null>(null);
export function useShell() {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell hors de <ChatShell>");
  return ctx;
}

export function ChatShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarPref, setSidebarPref] = useLocalStorage("iatrano:sidebar");
  const desktopCollapsed = sidebarPref === "collapsed";
  const pathname = usePathname();

  // Referme le panneau mobile après une navigation.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setMobileOpen(false);
  }

  const toggleDesktop = () => setSidebarPref(desktopCollapsed ? "open" : "collapsed");

  return (
    <ShellContext.Provider value={{ openMobileNav: () => setMobileOpen(true), desktopCollapsed, toggleDesktop }}>
      <div className="flex h-dvh w-full overflow-hidden bg-background">
        {!desktopCollapsed && (
          <aside className="hidden w-[272px] shrink-0 bg-sidebar md:flex md:flex-col">
            <Sidebar onCollapse={toggleDesktop} />
          </aside>
        )}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-[86vw] max-w-[320px] gap-0 bg-sidebar p-0 md:hidden" showCloseButton={false}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Conversations et compte</SheetDescription>
            <Sidebar onClose={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </ShellContext.Provider>
  );
}
