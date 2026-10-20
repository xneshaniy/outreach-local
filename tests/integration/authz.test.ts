import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH } from "@/app/api/campaigns/[id]/route";
import { prisma } from "@/lib/db";
import { requireCampaign, requireContact } from "@/lib/auth/guards";
import { createSessionToken } from "@/lib/auth/session";
import {
  createTestCampaign,
  createTestContact,
  createTestUser,
  dbEnabled,
  preflight,
  resetDatabase,
} from "./helpers";

/**
 * Spec §3: real authentication + per-workspace authorization.
 *  - no session cookie      -> 401
 *  - owner's session        -> 200
 *  - another user's session -> 404 (existence of foreign resources is not leaked)
 *  - invalidated session    -> 401 (sessionVersion bump in the DB)
 *  - cross-origin write     -> 403 (CSRF guard)
 */

// The session cookie is read through next/headers; mock only the cookie jar.
const cookieJar = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "eop_session" && cookieJar.token ? { name: "eop_session", value: cookieJar.token } : undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

function get(id: string) {
  return GET(new NextRequest(`http://localhost:3000/api/campaigns/${id}`), { params: Promise.resolve({ id }) });
}

function patch(id: string, body: unknown, headers: Record<string, string> = {}) {
  return PATCH(
    new NextRequest(`http://localhost:3000/api/campaigns/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      duplex: "half",
    } as never),
    { params: Promise.resolve({ id }) },
  );
}

async function sessionFor(user: { id: string; email: string; sessionVersion: number }) {
  return createSessionToken({ sub: user.id, email: user.email, sv: user.sessionVersion });
}

describe.runIf(dbEnabled)("authentication and workspace isolation", () => {
  beforeAll(preflight);
  beforeEach(async () => {
    await resetDatabase();
    cookieJar.token = null;
  });

  it("returns 401 without a session cookie", async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id);
    const res = await get(campaign.id);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns 401 for a forged/tampered token", async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id);
    const valid = await sessionFor(user);
    cookieJar.token = `${valid.slice(0, -4)}AAAA`;
    const res = await get(campaign.id);
    expect(res.status).toBe(401);
  });

  it("lets the owner read and rename their campaign", async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id);
    cookieJar.token = await sessionFor(user);

    const read = await get(campaign.id);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { campaign: { id: string }; stats: { total: number } };
    expect(readBody.campaign.id).toBe(campaign.id);
    expect(readBody.stats.total).toBe(0);

    const renamed = await patch(campaign.id, { name: "Renamed campaign" });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { campaign: { name: string } }).campaign.name).toBe("Renamed campaign");
  });

  it("hides other workspaces' campaigns behind a 404 (no existence leak)", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const aliceCampaign = await createTestCampaign(alice.id);

    cookieJar.token = await sessionFor(bob);
    const res = await get(aliceCampaign.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

    // And a foreign campaign cannot be renamed either.
    const write = await patch(aliceCampaign.id, { name: "Hijacked" });
    expect(write.status).toBe(404);
    const unchanged = await prisma.campaign.findUnique({ where: { id: aliceCampaign.id } });
    expect(unchanged?.name).toBe("Integration campaign");
  });

  it("rejects a session whose sessionVersion was invalidated in the database", async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id);
    const staleToken = await sessionFor(user); // sv = 0

    // e.g. "log out everywhere" / password change
    await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: 1 } });

    cookieJar.token = staleToken;
    expect((await get(campaign.id)).status).toBe(401);
  });

  it("rejects cross-origin state-changing requests (CSRF guard)", async () => {
    const user = await createTestUser();
    const campaign = await createTestCampaign(user.id);
    cookieJar.token = await sessionFor(user);

    const res = await patch(campaign.id, { name: "Phished" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    const unchanged = await prisma.campaign.findUnique({ where: { id: campaign.id } });
    expect(unchanged?.name).toBe("Integration campaign");
  });

  it("scopes the ownership guards by user id", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const aliceCampaign = await createTestCampaign(alice.id);
    const aliceContact = await createTestContact(alice.id);

    await expect(requireCampaign(alice.id, aliceCampaign.id)).resolves.toMatchObject({ id: aliceCampaign.id });
    await expect(requireCampaign(bob.id, aliceCampaign.id)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(requireContact(bob.id, aliceContact.id)).rejects.toMatchObject({ status: 404 });
    await expect(requireContact(alice.id, aliceContact.id)).resolves.toMatchObject({ id: aliceContact.id });
  });
});
