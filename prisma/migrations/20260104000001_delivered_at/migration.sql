-- Confirmed delivery timestamp.
--
-- NULL means "not known": the Gmail API and plain SMTP do not report
-- per-message delivery, so this column stays empty until a delivery webhook
-- confirms it. The reporting layer never guesses a value.
ALTER TABLE "SendJob" ADD COLUMN "deliveredAt" TIMESTAMP(3);
CREATE INDEX "SendJob_campaignId_deliveredAt_idx" ON "SendJob"("campaignId", "deliveredAt");
