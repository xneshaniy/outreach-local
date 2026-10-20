-- =============================================================================
-- Follow-up jobs: SendJob becomes kind-aware and may exist without a
-- campaign recipient (a follow-up message has no CampaignRecipient row).
-- =============================================================================

-- CreateEnum
CREATE TYPE "SendJobKind" AS ENUM ('ORIGINAL', 'FOLLOW_UP');

-- AlterTable: SendJob
ALTER TABLE "SendJob" ALTER COLUMN "campaignRecipientId" DROP NOT NULL;
ALTER TABLE "SendJob" ADD COLUMN "kind" "SendJobKind" NOT NULL DEFAULT 'ORIGINAL';
ALTER TABLE "SendJob" ADD COLUMN "followUpMessageId" TEXT;
ALTER TABLE "SendJob" ADD COLUMN "subject" TEXT;
ALTER TABLE "SendJob" ADD COLUMN "body" TEXT;
CREATE UNIQUE INDEX "SendJob_followUpMessageId_key" ON "SendJob"("followUpMessageId");
ALTER TABLE "SendJob" ADD CONSTRAINT "SendJob_followUpMessageId_fkey" FOREIGN KEY ("followUpMessageId") REFERENCES "FollowUpMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The follow-up side no longer holds the job FK (the job holds it), so the
-- old column and index are dropped.
ALTER TABLE "FollowUpMessage" DROP CONSTRAINT IF EXISTS "FollowUpMessage_sendJobId_fkey";
DROP INDEX IF EXISTS "FollowUpMessage_sendJobId_key";
ALTER TABLE "FollowUpMessage" DROP COLUMN IF EXISTS "sendJobId";
