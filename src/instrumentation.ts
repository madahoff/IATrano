export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Configuration validée dès le démarrage : une variable invalide (AUTH_SECRET trop court en production…)
    // arrête le processus avec un message clair au lieu d'échouer à la première requête.
    const { env } = await import("@/lib/env");
    try {
      env();
    } catch (err) {
      console.error(`[config] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const { ensureBootstrapped } = await import("@/lib/bootstrap");
    await ensureBootstrapped();
    // File de traitement des documents (reprend aussi les traitements interrompus par un redémarrage).
    const { startDocumentWorker } = await import("@/lib/documents/worker");
    startDocumentWorker();
  }
}
