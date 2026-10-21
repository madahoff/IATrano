import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Contrôle de santé (Docker / Dokploy) : vérifie le processus et la base. Le serveur IA est
// volontairement exclu : son indisponibilité ne doit pas faire redémarrer l'application.
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", database: "ok", time: new Date().toISOString() });
  } catch {
    return Response.json({ status: "error", database: "unreachable" }, { status: 503 });
  }
}
