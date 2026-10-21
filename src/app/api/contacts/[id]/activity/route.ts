import { NextRequest } from "next/server";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireContact, requireUser } from "@/lib/auth/guards";
import { addNote, listActivity, listNotes } from "@/lib/activity";
import { z } from "zod";

/**
 * GET  /api/contacts/:id/activity — the timeline plus the notes.
 * POST /api/contacts/:id/activity — add a note.
 */
type Ctx = { params: Promise<{ id: string }> };

export const GET = handleApi(async (_req: NextRequest, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  await requireContact(user.id, id);

  const [activities, notes] = await Promise.all([listActivity(id), listNotes(id)]);
  return json({ activities, notes });
});

const noteSchema = z.object({ body: z.string().min(1).max(5000) });

export const POST = handleApi(async (req: NextRequest, ctx: Ctx) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await ctx.params;
  await requireContact(user.id, id);

  const body = noteSchema.parse(await req.json());
  const note = await addNote({ userId: user.id, contactId: id, body: body.body });
  return json({ note }, { status: 201 });
});
