"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";

const MAP = { SYSTEM: "system", LIGHT: "light", DARK: "dark" } as const;

/** Applique le thème enregistré dans le profil (préférence suivie d'un appareil à l'autre). */
export function ThemeSync({ preference }: { preference: keyof typeof MAP | null }) {
  const { theme, setTheme } = useTheme();
  useEffect(() => {
    if (preference && theme && MAP[preference] !== theme) setTheme(MAP[preference]);
    // uniquement au chargement : ensuite, c'est l'utilisateur qui pilote le thème
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preference]);
  return null;
}
