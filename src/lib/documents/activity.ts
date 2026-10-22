// Priorité aux conversations : les traitements documentaires qui sollicitent le LLM (analyse, synthèse,
// vision) attendent qu'aucune réponse ne soit en cours de génération dans ce processus, pour ne pas
// ralentir le chat sur un serveur IA unique (un seul GPU).

const g = globalThis as unknown as { __iatranoChatActive?: { count: number; lastEnd: number } };
const state = (g.__iatranoChatActive ??= { count: 0, lastEnd: 0 });

export function chatStarted() {
  state.count++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    state.count = Math.max(0, state.count - 1);
    state.lastEnd = Date.now();
  };
}

export function chatBusy() {
  // Courte marge après une réponse : les tâches de suivi (titre, mémoire) passent avant l'analyse.
  return state.count > 0 || Date.now() - state.lastEnd < 3000;
}

/** Attend que le chat soit inactif (au plus maxWaitMs, puis continue pour ne jamais bloquer indéfiniment). */
export async function waitForChatIdle(signal?: AbortSignal, maxWaitMs = 10 * 60_000) {
  const started = Date.now();
  while (chatBusy() && Date.now() - started < maxWaitMs) {
    if (signal?.aborted) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
