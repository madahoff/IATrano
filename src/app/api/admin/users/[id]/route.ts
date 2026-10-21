import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { deleteUser, updateUser, updateUserSchema } from "@/lib/users/service";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, { params }) => {
  const actor = await requireApiUser("users:manage");
  const input = await parseJson(req, updateUserSchema);
  await updateUser(actor, (await params).id, input);
  return json({ ok: true });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const actor = await requireApiUser("users:manage");
  await deleteUser(actor, (await params).id);
  return json({ ok: true });
});
