import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { ApiError } from "@/lib/errors";
import { MAX_FILE_BYTES, parseContactsCsv, previewCsvHeaders, CONTACT_FIELDS } from "@/lib/csv";
import { addContactsToCampaign } from "@/lib/campaign";
import { audit } from "@/lib/audit";
import { z } from "zod";

/**
 * POST /api/contacts/import
 * Multipart form upload: `file` (CSV) + optional `campaignId` + optional
 * `mapping` JSON + `dryRun` flag.
 *
 * Limits: 10 MB, 50 000 rows. Validation happens per-row before anything is
 * written; duplicates are resolved by database constraints, not by the client.
 */
export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();

  const form = await req.formData();
  const file = form.get("file");
  const campaignId = form.get("campaignId")?.toString();
  const mappingRaw = form.get("mapping")?.toString();
  const dryRun = form.get("dryRun")?.toString() === "true";

  if (!(file instanceof File)) throw ApiError.badRequest("A CSV file is required.");
  if (file.size > MAX_FILE_BYTES) {
    throw ApiError.badRequest(`File too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).`);
  }
  if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
    throw ApiError.badRequest("Only .csv files are accepted.");
  }

  const text = await file.text();
  const { headers, sample } = previewCsvHeaders(text, 3);

  let mapping: Partial<Record<(typeof CONTACT_FIELDS)[number], string>> = {};
  if (mappingRaw) {
    const parsed = z
      .object(
        Object.fromEntries(CONTACT_FIELDS.map((f) => [f, z.string().max(200).optional()])) as Record<
          (typeof CONTACT_FIELDS)[number],
          z.ZodOptional<z.ZodString>
        >,
      )
      .parse(JSON.parse(mappingRaw));
    mapping = parsed as typeof mapping;
  } else {
    const { detectMapping } = await import("@/lib/csv");
    mapping = detectMapping(headers);
  }

  const parsed = parseContactsCsv(text, mapping);

  if (dryRun) {
    return json({
      dryRun: true,
      headers,
      sample,
      detectedMapping: mapping,
      total: parsed.total,
      valid: parsed.valid.length,
      invalid: parsed.invalid.slice(0, 50),
      duplicatesInFile: parsed.duplicatesInFile,
    });
  }

  if (parsed.valid.length === 0) {
    throw ApiError.badRequest("No valid rows found in the CSV.", { invalid: parsed.invalid.slice(0, 20) });
  }

  let campaign = null;
  if (campaignId) {
    campaign = await prisma.campaign.findFirst({ where: { id: campaignId, userId: user.id } });
    if (!campaign) throw ApiError.notFound("Campaign not found.");
  }

  const batch = await prisma.importBatch.create({
    data: {
      userId: user.id,
      campaignId: campaign?.id ?? null,
      filename: file.name.slice(0, 300),
      status: "PROCESSING",
      totalRows: parsed.total,
      invalidRows: parsed.invalid.length,
    },
  });

  try {
    let result = { added: 0, duplicates: 0, invalid: 0, heldForTimezone: 0 };
    if (campaign) {
      result = await addContactsToCampaign(campaign, parsed.valid, batch.id);
    } else {
      const created = await prisma.contact.createMany({
        data: parsed.valid.map((r) => ({
          userId: user.id,
          email: r.email,
          emailNormalized: r.emailNormalized,
          firstName: r.firstName ?? null,
          lastName: r.lastName ?? null,
          company: r.company ?? null,
          website: r.website ?? null,
          title: r.title ?? null,
          timeZone: r.timeZone ?? null,
          country: r.country ?? null,
        })),
        skipDuplicates: true,
      });
      result = { added: created.count, duplicates: parsed.valid.length - created.count, invalid: parsed.invalid.length, heldForTimezone: 0 };
    }

    await prisma.importBatch.update({
      where: { id: batch.id },
      data: {
        status: "COMPLETED",
        importedRows: result.added,
        duplicateRows: result.duplicates + parsed.duplicatesInFile,
        completedAt: new Date(),
      },
    });

    await audit(prisma, {
      userId: user.id,
      action: "contacts.import",
      entityType: "ImportBatch",
      entityId: batch.id,
      metadata: { filename: file.name, campaignId: campaign?.id, ...result },
    });

    return json({ batchId: batch.id, ...result, invalidPreview: parsed.invalid.slice(0, 50) }, { status: 201 });
  } catch (err) {
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: "FAILED", error: (err as Error).message.slice(0, 1000), completedAt: new Date() },
    });
    throw err;
  }
});
