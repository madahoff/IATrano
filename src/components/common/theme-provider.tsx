"use client";

import type { ComponentProps } from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

// next-themes insère un <script> qui applique le thème avant le premier affichage (pas de flash).
// Il n'est utile que dans le HTML rendu par le serveur : côté client, React refuse d'exécuter un script
// rendu par un composant et le signale en console. On le marque alors comme bloc de données
// (type application/json), que React accepte sans avertissement ; le thème est déjà appliqué à ce stade.
const clientScriptProps = typeof window === "undefined" ? undefined : ({ type: "application/json" } as const);

export function ThemeProvider(props: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider scriptProps={clientScriptProps} {...props} />;
}
