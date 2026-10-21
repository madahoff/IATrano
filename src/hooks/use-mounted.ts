import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** true côté client après hydratation, false pendant le rendu serveur. */
export function useMounted(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
