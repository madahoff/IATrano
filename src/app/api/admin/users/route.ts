import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { createUser, createUserSchema, listUsers } from "@/lib/users/service";

export const GET = route(async () => {
  await requireApiUser("users:manage");
  return json({ users: await listUsers() });
});

export const POST = route(async (req) => {
  const actor = await requireApiUser("users:manage");
  const input = await parseJson(req, createUserSchema);
  const id = await createUser(actor, input);
  return json({ id }, { status: 201 });
});
