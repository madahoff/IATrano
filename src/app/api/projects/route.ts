import { z } from "zod";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { createProject, listProjects, toProjectDTO } from "@/lib/projects/service";

const schema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(1000).optional(), instructions: z.string().max(8000).optional() });

export const GET = route(async () => {
  const user = await requireApiUser("chat:use");
  return json({ projects: (await listProjects(user.id)).map(toProjectDTO) });
});

export const POST = route(async (req) => {
  const user = await requireApiUser("chat:use");
  const input = await parseJson(req, schema);
  return json({ project: toProjectDTO(await createProject(user.id, input)) }, { status: 201 });
});
