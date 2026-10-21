import { z } from "zod";
import { db } from "@/lib/db";
import { json, parseJson, route } from "@/lib/http";
import { requireApiUser } from "@/lib/auth/guard";
import { AppError } from "@/lib/errors";
import { verifyPassword } from "@/lib/auth/password";
import { emailSchema, nameSchema } from "@/lib/users/service";

export const GET = route(async () => {
  const user = await requireApiUser("profile:edit");
  return json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

const schema = z.object({
  name: nameSchema.optional(),
  email: emailSchema.optional(),
  currentPassword: z.string().max(200).optional(),
});

export const PATCH = route(async (req) => {
  const sessionUser = await requireApiUser("profile:edit");
  const input = await parseJson(req, schema);
  const user = await db.user.findUniqueOrThrow({ where: { id: sessionUser.id } });
  if (input.email && input.email !== user.email) {
    // Changer l'identifiant de connexion exige le mot de passe actuel.
    if (!input.currentPassword || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new AppError(403, "invalid_password", "Mot de passe actuel incorrect.");
    }
    const taken = await db.user.findUnique({ where: { email: input.email } });
    if (taken) throw new AppError(409, "email_taken", "Cette adresse e-mail est déjà utilisée.");
  }
  const updated = await db.user.update({
    where: { id: user.id },
    data: { name: input.name, email: input.email },
    select: { id: true, email: true, name: true, role: true },
  });
  return json({ user: updated });
});
