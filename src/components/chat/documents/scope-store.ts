// Sélection des documents interrogés par la conversation en cours (client). Partagée entre le sélecteur
// (DocumentScopeButton) et l'envoi des messages (useChat), sans dépendre de la mise en page du chat.

type Scope = { projectId: string | null; documentIds: string[] | null };

let scope: Scope = { projectId: null, documentIds: null };
const listeners = new Set<() => void>();

export function getDocumentScope(): Scope {
  return scope;
}

/** `documentIds` null : ne rien transmettre (la conversation garde sa sélection) ; [] : tous les documents. */
export function setDocumentScope(next: Scope) {
  scope = next;
  for (const l of listeners) l();
}

export function subscribeDocumentScope(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
