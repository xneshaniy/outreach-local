import { NextRequest } from "next/server";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { mockOutbox, clearMockOutbox } from "@/lib/email/mock";

/**
 * GET    /api/senders/mock — the messages the mock provider accepted.
 * DELETE /api/senders/mock — clear the outbox.
 *
 * The mock provider never touches the network. It is enabled with
 * MOCK_PROVIDER=true, which is the safe way to develop without credentials.
 */
export const GET = handleApi(async () => {
  await requireUser();
  return json({ messages: mockOutbox() });
});

export const DELETE = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  await requireUser();
  clearMockOutbox();
  return json({ ok: true });
});
