import { json, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { getArtifactDTO } from "@/lib/artifacts/service";

type Ctx = { params: Promise<{ id: string }> };

// Code d'une version et liste de ses versions (panneau d'aperçu). Réservé au propriétaire de la conversation.
export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireApiUser("chat:use");
  return json({ artifact: await getArtifactDTO(user.id, (await params).id) });
});
