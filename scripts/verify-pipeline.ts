/**
 * End-to-end check of the pipeline / CRM / notifications / pre-flight against
 * a running server.
 *
 * Usage: npx tsx scripts/verify-pipeline.ts
 */
import { PrismaClient } from "@prisma/client";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3111";
const PASSWORD = process.env.VERIFY_PASSWORD ?? "ChangeMe123!";

async function main() {
  const prisma = new PrismaClient();

  const owner = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!owner) throw new Error("No owner found - run the seed first.");

  // Sign in as the owner.
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: owner.email, password: PASSWORD }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error(`Login failed (${login.status}).`);
  console.log(`LOGIN      status=${login.status} cookie=yes`);

  const json = async (url: string, init?: RequestInit) => {
    const res = await fetch(`${BASE}${url}`, {
      ...init,
      headers: { cookie, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 200);
    }
    return { status: res.status, body: body as Record<string, unknown> };
  };

  // --- Pipeline stages -----------------------------------------------------
  const stages = await json("/api/pipeline/stages");
  const stageList = (stages.body as { stages: Array<{ id: string; name: string }> }).stages;
  console.log(`STAGES     status=${stages.status} count=${stageList.length}`);

  // --- Contacts: stage + priority -------------------------------------------
  const contacts = await json("/api/contacts?pageSize=1");
  const contactId = (contacts.body as { items: Array<{ id: string; email: string }> }).items[0]?.id;
  if (!contactId) throw new Error("No contact to work with - run the seed first.");

  const target = stageList.find((s) => s.name === "Qualified") ?? stageList[0]!;
  const moved = await json(`/api/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({ stageId: target.id, priority: "HIGH" }),
  });
  console.log(`MOVE       status=${moved.status} -> ${target.name}`);

  // --- Activity timeline ----------------------------------------------------
  const activity = await json(`/api/contacts/${contactId}/activity`);
  const activities = (activity.body as { activities: Array<{ type: string }> }).activities;
  console.log(`ACTIVITY   status=${activity.status} entries=${activities.length}`);

  // --- A note ---------------------------------------------------------------
  const note = await json(`/api/contacts/${contactId}/activity`, {
    method: "POST",
    body: JSON.stringify({ body: "Called on Tuesday - left a message." }),
  });
  console.log(`NOTE       status=${note.status}`);

  // --- Bulk update: preview then apply --------------------------------------
  const preview = await json("/api/contacts/bulk", {
    method: "POST",
    body: JSON.stringify({ mode: "preview", ids: [contactId], changes: { source: "referral" } }),
  });
  const pv = preview.body as { changed: number; preview: Array<{ before: { source: string | null } }> };
  console.log(`BULK PREV  status=${preview.status} changed=${pv.changed}`);
  const applied = await json("/api/contacts/bulk", {
    method: "POST",
    body: JSON.stringify({ mode: "apply", ids: [contactId], changes: { source: "referral" } }),
  });
  console.log(`BULK APPLY status=${applied.status} updated=${(applied.body as { updated: number }).updated}`);

  // --- A task ---------------------------------------------------------------
  const task = await json("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "Send the proposal",
      contactId,
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
    }),
  });
  console.log(`TASK       status=${task.status} (created, already overdue)`);

  // --- Notifications --------------------------------------------------------
  const notifications = await json("/api/notifications");
  const nData = notifications.body as { items: unknown[]; unread: number };
  console.log(`NOTIFY     status=${notifications.status} unread=${nData.unread}`);
  if (nData.items.length > 0) {
    const first = (nData.items[0] as { id: string }).id;
    const read = await json("/api/notifications", {
      method: "PATCH",
      body: JSON.stringify({ ids: [first] }),
    });
    console.log(`NOTIFY RD  status=${read.status} marked=${(read.body as { marked: number }).marked}`);
  }

  // --- Pre-flight -----------------------------------------------------------
  const campaign = await prisma.campaign.findFirst({ where: { userId: owner.id } });
  if (campaign) {
    const pre = await json(`/api/campaigns/${campaign.id}/preflight`);
    const report = (pre.body as { report: { ok: boolean; findings: unknown[]; eligible: number; excluded: number } }).report;
    console.log(
      `PREFLIGHT  status=${pre.status} ok=${report.ok} findings=${report.findings.length} eligible=${report.eligible} excluded=${report.excluded}`,
    );
    for (const f of (report.findings as Array<{ severity: string; message: string }>).slice(0, 4)) {
      console.log(`           ${f.severity}: ${f.message}`);
    }
  }

  // --- Segments -------------------------------------------------------------
  const segment = await json("/api/segments", {
    method: "POST",
    body: JSON.stringify({ name: "Replied leads", filters: { status: ["REPLIED"] } }),
  });
  console.log(`SEGMENT    status=${segment.status}`);

  // --- Dashboard ------------------------------------------------------------
  const dash = await json("/api/dashboard?days=30");
  const d = dash.body as {
    contacts: { total: number; eligible: number };
    messages: { accepted: number; delivered: number | null; replies: number };
    engagement: { uniqueOpens: number; openRate: number | null };
    health: { ok: boolean; problems: unknown[] };
  };
  console.log(`DASHBOARD  status=${dash.status}`);
  console.log(`           contacts=${d.contacts.total} eligible=${d.contacts.eligible}`);
  console.log(`           accepted=${d.messages.accepted} delivered=${d.messages.delivered ?? "n/a"} replies=${d.messages.replies}`);
  console.log(`           openRate=${d.engagement.openRate ?? "n/a"} uniqueOpens=${d.engagement.uniqueOpens}`);
  console.log(`           health.ok=${d.health.ok} problems=${d.health.problems.length}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
