-- =============================================================================
-- Features: service profiles, follow-up sequences, replies, dry run,
--            campaign approval/archive, contact tags/source/notes.
-- =============================================================================

-- Enum additions (PostgreSQL 12+ allows ADD VALUE inside a transaction as long
-- as the new value is not used in the same transaction — it is not).
ALTER TYPE "ContactStatus" ADD VALUE IF NOT EXISTS 'REPLIED';
ALTER TYPE "ContactStatus" ADD VALUE IF NOT EXISTS 'INTERESTED';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED');

-- CreateTable: Service
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "targetIndustries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "idealCustomerProfile" TEXT,
    "defaultSubject" TEXT,
    "defaultBody" TEXT,
    "defaultCta" TEXT,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Service_userId_slug_key" ON "Service"("userId", "slug");
CREATE INDEX "Service_userId_isActive_idx" ON "Service"("userId", "isActive");
ALTER TABLE "Service" ADD CONSTRAINT "Service_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: FollowUpSequence
CREATE TABLE "FollowUpSequence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceId" TEXT,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FollowUpSequence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FollowUpSequence_userId_isActive_idx" ON "FollowUpSequence"("userId", "isActive");
ALTER TABLE "FollowUpSequence" ADD CONSTRAINT "FollowUpSequence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUpSequence" ADD CONSTRAINT "FollowUpSequence_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: FollowUpStep
CREATE TABLE "FollowUpStep" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "delayDays" INTEGER NOT NULL DEFAULT 3,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FollowUpStep_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FollowUpStep_sequenceId_order_key" ON "FollowUpStep"("sequenceId", "order");
ALTER TABLE "FollowUpStep" ADD CONSTRAINT "FollowUpStep_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "FollowUpSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: FollowUpMessage
CREATE TABLE "FollowUpMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "campaignId" TEXT,
    "contactId" TEXT NOT NULL,
    "sendJobId" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'SCHEDULED',
    "sentAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FollowUpMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FollowUpMessage_sendJobId_key" ON "FollowUpMessage"("sendJobId");
CREATE INDEX "FollowUpMessage_status_scheduledAt_idx" ON "FollowUpMessage"("status", "scheduledAt");
CREATE INDEX "FollowUpMessage_contactId_idx" ON "FollowUpMessage"("contactId");
CREATE INDEX "FollowUpMessage_campaignId_idx" ON "FollowUpMessage"("campaignId");
CREATE INDEX "FollowUpMessage_userId_status_idx" ON "FollowUpMessage"("userId", "status");
ALTER TABLE "FollowUpMessage" ADD CONSTRAINT "FollowUpMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUpMessage" ADD CONSTRAINT "FollowUpMessage_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "FollowUpSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUpMessage" ADD CONSTRAINT "FollowUpMessage_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "FollowUpStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUpMessage" ADD CONSTRAINT "FollowUpMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUpMessage" ADD CONSTRAINT "FollowUpMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUpMessage" ADD CONSTRAINT "FollowUpMessage_sendJobId_fkey" FOREIGN KEY ("sendJobId") REFERENCES "SendJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: Reply
CREATE TABLE "Reply" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" TEXT,
    "contactId" TEXT,
    "senderAccountId" TEXT,
    "provider" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT,
    "snippet" TEXT,
    "body" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Reply_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Reply_userId_provider_messageId_key" ON "Reply"("userId", "provider", "messageId");
CREATE INDEX "Reply_userId_receivedAt_idx" ON "Reply"("userId", "receivedAt");
CREATE INDEX "Reply_userId_isRead_idx" ON "Reply"("userId", "isRead");
CREATE INDEX "Reply_contactId_idx" ON "Reply"("contactId");
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "SenderAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: Contact — tags / source / notes / reply tracking
ALTER TABLE "Contact" ADD COLUMN "source" TEXT;
ALTER TABLE "Contact" ADD COLUMN "notes" TEXT;
ALTER TABLE "Contact" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Contact" ADD COLUMN "lastRepliedAt" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "repliedCount" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "Contact_userId_source_idx" ON "Contact"("userId", "source");

-- AlterTable: EmailTemplate — link to a service
ALTER TABLE "EmailTemplate" ADD COLUMN "serviceId" TEXT;
CREATE INDEX "EmailTemplate_userId_serviceId_idx" ON "EmailTemplate"("userId", "serviceId");
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: Campaign — service, archive, approval, dry run, follow-ups
ALTER TABLE "Campaign" ADD COLUMN "serviceId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "requiresApproval" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN "approvedBy" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "dryRun" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "followUpSequenceId" TEXT;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_followUpSequenceId_fkey" FOREIGN KEY ("followUpSequenceId") REFERENCES "FollowUpSequence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: SendJob — dry run marker
ALTER TABLE "SendJob" ADD COLUMN "dryRun" BOOLEAN NOT NULL DEFAULT false;
