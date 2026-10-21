-- =============================================================================
-- Email Outreach Platform - Supabase bootstrap
-- =============================================================================
--
-- Run this ONCE in the Supabase SQL Editor:
--   Supabase -> your project -> SQL Editor -> New query -> paste -> Run
--
-- It creates the whole schema and records the migrations, so a later
--   npx prisma migrate deploy
-- reports "no pending migrations to apply" instead of applying them twice.
--
-- Generated from prisma/migrations (6 migrations).
-- Do not edit by hand - regenerate with:
--   node scripts/generate-supabase-bootstrap.mjs
-- =============================================================================

BEGIN;

-- Prisma's migration bookkeeping.
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    id VARCHAR(36) NOT NULL,
    checksum VARCHAR(64) NOT NULL,
    finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL,
    logs TEXT,
    rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    applied_steps_count INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY (id)
);

-- =============================================================================
-- migration: 20260101000000_init
-- =============================================================================
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE "SenderProvider" AS ENUM ('GOOGLE', 'SMTP');
CREATE TYPE "SenderStatus" AS ENUM ('CONNECTED', 'PAUSED', 'DISCONNECTED', 'ERROR');
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "RecipientStatus" AS ENUM ('PENDING', 'HELD_TZ', 'SCHEDULED', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED');
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'CLAIMED', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED', 'AMBIGUOUS');
CREATE TYPE "AttemptStatus" AS ENUM ('SUCCESS', 'TRANSIENT_FAILURE', 'PERMANENT_FAILURE', 'AMBIGUOUS');
CREATE TYPE "ProviderKind" AS ENUM ('GMAIL', 'SMTP');
CREATE TYPE "ContactStatus" AS ENUM ('ACTIVE', 'UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED', 'INVALID');
CREATE TYPE "SuppressionScope" AS ENUM ('GLOBAL', 'CAMPAIGN');
CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBE', 'BOUNCE', 'HARD_BOUNCE', 'COMPLAINT', 'MANUAL', 'LIST_UNSUBSCRIBE');
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "TzFallbackMode" AS ENUM ('HOLD', 'FALLBACK');
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'INVALID_SIGNATURE');

-- CreateTable: User
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "role" "Role" NOT NULL DEFAULT 'OWNER',
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "minDaysBetweenContacts" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateTable: SenderAccount
CREATE TABLE "SenderAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "SenderProvider" NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "SenderStatus" NOT NULL DEFAULT 'CONNECTED',
    "dailyCap" INTEGER NOT NULL DEFAULT 100,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT false,
    "smtpUsername" TEXT,
    "smtpPasswordEnc" TEXT,
    "googleSubject" TEXT,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenExpiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SenderAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SenderAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SenderAccount_userId_email_key" ON "SenderAccount"("userId", "email");
CREATE INDEX "SenderAccount_userId_status_idx" ON "SenderAccount"("userId", "status");

-- CreateTable: EmailTemplate
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmailTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: Contact
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "company" TEXT,
    "website" TEXT,
    "title" TEXT,
    "timeZone" TEXT,
    "country" TEXT,
    "customFields" JSONB,
    "status" "ContactStatus" NOT NULL DEFAULT 'ACTIVE',
    "consentAt" TIMESTAMP(3),
    "consentSource" TEXT,
    "lastSentAt" TIMESTAMP(3),
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Contact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- One contact per user per normalized email (duplicate prevention, layer 1).
CREATE UNIQUE INDEX "Contact_userId_emailNormalized_key" ON "Contact"("userId", "emailNormalized");
CREATE INDEX "Contact_userId_status_idx" ON "Contact"("userId", "status");
CREATE INDEX "Contact_userId_createdAt_idx" ON "Contact"("userId", "createdAt");

-- CreateTable: Campaign
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "templateId" TEXT,
    "body" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "emergencyStopped" BOOLEAN NOT NULL DEFAULT false,
    "windowStartMinute" INTEGER NOT NULL DEFAULT 540,
    "windowEndMinute" INTEGER NOT NULL DEFAULT 1020,
    "sendingDays" INTEGER[] DEFAULT ARRAY[1,2,3,4,5]::INTEGER[],
    "timeZoneFallback" "TzFallbackMode" NOT NULL DEFAULT 'HOLD',
    "fallbackTimeZone" TEXT,
    "dailyLimit" INTEGER,
    "fromName" TEXT,
    "replyTo" TEXT,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Campaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Campaign_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "Campaign_userId_status_idx" ON "Campaign"("userId", "status");
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateTable: CampaignRecipient
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" "RecipientStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "skipReason" TEXT,
    "lastError" TEXT,
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CampaignRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- *** CRITICAL duplicate prevention: one contact per campaign, ever. ***
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_contactId_key" ON "CampaignRecipient"("campaignId", "contactId");
CREATE INDEX "CampaignRecipient_campaignId_status_idx" ON "CampaignRecipient"("campaignId", "status");
CREATE INDEX "CampaignRecipient_campaignId_scheduledAt_idx" ON "CampaignRecipient"("campaignId", "scheduledAt");
CREATE INDEX "CampaignRecipient_status_scheduledAt_idx" ON "CampaignRecipient"("status", "scheduledAt");

-- CreateTable: SendJob
CREATE TABLE "SendJob" (
    "id" TEXT NOT NULL,
    "campaignRecipientId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "errorCode" TEXT,
    "provider" "ProviderKind",
    "senderAccountId" TEXT,
    "providerMessageId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "ambiguousSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SendJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SendJob_campaignRecipientId_fkey" FOREIGN KEY ("campaignRecipientId") REFERENCES "CampaignRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SendJob_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SendJob_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SendJob_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "SenderAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- One logical job per campaign recipient + idempotent enqueues.
CREATE UNIQUE INDEX "SendJob_campaignRecipientId_key" ON "SendJob"("campaignRecipientId");
CREATE UNIQUE INDEX "SendJob_idempotencyKey_key" ON "SendJob"("idempotencyKey");
-- Atomic claim scan index.
CREATE INDEX "SendJob_status_scheduledAt_idx" ON "SendJob"("status", "scheduledAt");
CREATE INDEX "SendJob_campaignId_status_idx" ON "SendJob"("campaignId", "status");
CREATE INDEX "SendJob_userId_status_idx" ON "SendJob"("userId", "status");

-- CreateTable: SendAttempt
CREATE TABLE "SendAttempt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "senderAccountId" TEXT,
    "status" "AttemptStatus" NOT NULL,
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "httpStatus" INTEGER,
    "idempotencyHeader" TEXT,
    "latencyMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "reconciliationNote" TEXT,
    CONSTRAINT "SendAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SendAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SendJob"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SendAttempt_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "SenderAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- No double-accounting of the same attempt.
CREATE UNIQUE INDEX "SendAttempt_jobId_attemptNumber_key" ON "SendAttempt"("jobId", "attemptNumber");
CREATE INDEX "SendAttempt_status_startedAt_idx" ON "SendAttempt"("status", "startedAt");

-- CreateTable: SenderDailyUsage
CREATE TABLE "SenderDailyUsage" (
    "id" TEXT NOT NULL,
    "senderAccountId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "reservedCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SenderDailyUsage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SenderDailyUsage_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "SenderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SenderDailyUsage_senderAccountId_date_key" ON "SenderDailyUsage"("senderAccountId", "date");
CREATE INDEX "SenderDailyUsage_date_idx" ON "SenderDailyUsage"("date");

-- CreateTable: CampaignDailyUsage
CREATE TABLE "CampaignDailyUsage" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CampaignDailyUsage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CampaignDailyUsage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CampaignDailyUsage_campaignId_date_key" ON "CampaignDailyUsage"("campaignId", "date");
CREATE INDEX "CampaignDailyUsage_date_idx" ON "CampaignDailyUsage"("date");

-- CreateTable: Suppression
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "SuppressionScope" NOT NULL DEFAULT 'GLOBAL',
    "campaignId" TEXT,
    "emailNormalized" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Suppression_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Suppression_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Suppression_userId_scope_emailNormalized_idx" ON "Suppression"("userId", "scope", "emailNormalized");
CREATE INDEX "Suppression_campaignId_emailNormalized_idx" ON "Suppression"("campaignId", "emailNormalized");
-- One global suppression per (user, email) and one per (campaign, email).
CREATE UNIQUE INDEX "Suppression_global_email_key" ON "Suppression"("userId", "emailNormalized") WHERE "scope" = 'GLOBAL' AND "campaignId" IS NULL;
CREATE UNIQUE INDEX "Suppression_campaign_email_key" ON "Suppression"("campaignId", "emailNormalized") WHERE "scope" = 'CAMPAIGN' AND "campaignId" IS NOT NULL;

-- CreateTable: UnsubscribeEvent
CREATE TABLE "UnsubscribeEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" TEXT,
    "contactId" TEXT,
    "emailNormalized" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "reason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UnsubscribeEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UnsubscribeEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UnsubscribeEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "UnsubscribeEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "UnsubscribeEvent_userId_createdAt_idx" ON "UnsubscribeEvent"("userId", "createdAt");
CREATE INDEX "UnsubscribeEvent_emailNormalized_createdAt_idx" ON "UnsubscribeEvent"("emailNormalized", "createdAt");

-- CreateTable: WebhookEvent
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "payload" JSONB,
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebhookEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WebhookEvent_provider_externalId_key" ON "WebhookEvent"("provider", "externalId");
CREATE INDEX "WebhookEvent_userId_createdAt_idx" ON "WebhookEvent"("userId", "createdAt");

-- CreateTable: AuditLog
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateTable: ImportBatch
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" TEXT,
    "filename" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ImportBatch_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "ImportBatch_userId_createdAt_idx" ON "ImportBatch"("userId", "createdAt");

-- CreateTable: RateLimit
CREATE TABLE "RateLimit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RateLimit_key_windowStart_key" ON "RateLimit"("key", "windowStart");
CREATE INDEX "RateLimit_windowStart_idx" ON "RateLimit"("windowStart");

-- CreateTable: IdempotencyKey
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "requestHash" TEXT,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IdempotencyKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "IdempotencyKey_userId_key_key" ON "IdempotencyKey"("userId", "key");
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");

-- Record it as applied (checksum = sha256 of the migration file).
INSERT INTO "_prisma_migrations" (
    id,
    checksum,
    migration_name,
    logs,
    rolled_back_at,
    started_at,
    finished_at,
    applied_steps_count
) VALUES (
    '4317a447-645c-ddde-8ddd-1c60eb07ff40',
    'e7b653c019e7a89b54f760b2abbb4bab6ccdba3f036ef228dd5a89150c026917',
    '20260101000000_init',
    NULL,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    1
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- migration: 20260102000000_features
-- =============================================================================
-- =============================================================================
-- Features: service profiles, follow-up sequences, replies, dry run,
--            campaign approval/archive, contact tags/source/notes.
-- =============================================================================

-- Enum additions (PostgreSQL 12+ allows ADD VALUE inside a transaction as long
-- as the new value is not used in the same transaction -- it is not).
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

-- AlterTable: Contact -- tags / source / notes / reply tracking
ALTER TABLE "Contact" ADD COLUMN "source" TEXT;
ALTER TABLE "Contact" ADD COLUMN "notes" TEXT;
ALTER TABLE "Contact" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Contact" ADD COLUMN "lastRepliedAt" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "repliedCount" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "Contact_userId_source_idx" ON "Contact"("userId", "source");

-- AlterTable: EmailTemplate -- link to a service
ALTER TABLE "EmailTemplate" ADD COLUMN "serviceId" TEXT;
CREATE INDEX "EmailTemplate_userId_serviceId_idx" ON "EmailTemplate"("userId", "serviceId");
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: Campaign -- service, archive, approval, dry run, follow-ups
ALTER TABLE "Campaign" ADD COLUMN "serviceId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "requiresApproval" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN "approvedBy" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "dryRun" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "followUpSequenceId" TEXT;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_followUpSequenceId_fkey" FOREIGN KEY ("followUpSequenceId") REFERENCES "FollowUpSequence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: SendJob -- dry run marker
ALTER TABLE "SendJob" ADD COLUMN "dryRun" BOOLEAN NOT NULL DEFAULT false;

-- Record it as applied (checksum = sha256 of the migration file).
INSERT INTO "_prisma_migrations" (
    id,
    checksum,
    migration_name,
    logs,
    rolled_back_at,
    started_at,
    finished_at,
    applied_steps_count
) VALUES (
    '6bf8660f-a619-f65f-8d35-8c12aa55ed4a',
    '9390ea7dc5cdca66b60c50e9dc21e5f84226e9d9c1ea05c10d2a235c931493f0',
    '20260102000000_features',
    NULL,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    1
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- migration: 20260103000000_followup_jobs
-- =============================================================================
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

-- Record it as applied (checksum = sha256 of the migration file).
INSERT INTO "_prisma_migrations" (
    id,
    checksum,
    migration_name,
    logs,
    rolled_back_at,
    started_at,
    finished_at,
    applied_steps_count
) VALUES (
    '6673dd76-78e5-283c-e36a-5a1525fda21c',
    '7e86290d77e303604c3745678d7e9bc6ee3abeb13cc16b69f18ac04c18632dcc',
    '20260103000000_followup_jobs',
    NULL,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    1
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- migration: 20260104000000_client_portal
-- =============================================================================
-- =============================================================================
-- Client portal: client accounts, campaign assignment, open/click tracking.
-- =============================================================================

-- CreateEnum
CREATE TYPE "TrackingEventType" AS ENUM ('OPEN', 'CLICK');

-- CreateEnum
CREATE TYPE "TrackingSource" AS ENUM ('HUMAN', 'PREVIEW', 'BOT');

-- CreateTable: Client
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Client_email_key" ON "Client"("email");
CREATE INDEX "Client_userId_isActive_idx" ON "Client"("userId", "isActive");
ALTER TABLE "Client" ADD CONSTRAINT "Client_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: ClientCampaignAccess
CREATE TABLE "ClientCampaignAccess" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientCampaignAccess_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClientCampaignAccess_clientId_campaignId_key" ON "ClientCampaignAccess"("clientId", "campaignId");
CREATE INDEX "ClientCampaignAccess_campaignId_idx" ON "ClientCampaignAccess"("campaignId");
ALTER TABLE "ClientCampaignAccess" ADD CONSTRAINT "ClientCampaignAccess_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientCampaignAccess" ADD CONSTRAINT "ClientCampaignAccess_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: TrackingEvent
CREATE TABLE "TrackingEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "type" "TrackingEventType" NOT NULL,
    "source" "TrackingSource" NOT NULL DEFAULT 'HUMAN',
    "url" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackingEvent_pkey" PRIMARY KEY ("id")
);
-- The dedupe key is only set on the FIRST event of its kind, so repeats are
-- recorded (for the total) without blocking the insert.
CREATE UNIQUE INDEX "TrackingEvent_dedupeKey_key" ON "TrackingEvent"("dedupeKey");
CREATE INDEX "TrackingEvent_campaignId_type_idx" ON "TrackingEvent"("campaignId", "type");
CREATE INDEX "TrackingEvent_campaignId_contactId_type_idx" ON "TrackingEvent"("campaignId", "contactId", "type");
CREATE INDEX "TrackingEvent_campaignId_createdAt_idx" ON "TrackingEvent"("campaignId", "createdAt");
CREATE INDEX "TrackingEvent_contactId_idx" ON "TrackingEvent"("contactId");
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: Campaign -- per-campaign tracking switches
ALTER TABLE "Campaign" ADD COLUMN "trackingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "clickTrackingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Record it as applied (checksum = sha256 of the migration file).
INSERT INTO "_prisma_migrations" (
    id,
    checksum,
    migration_name,
    logs,
    rolled_back_at,
    started_at,
    finished_at,
    applied_steps_count
) VALUES (
    '1c038417-ccbc-7a6f-69dc-6b35bb473acf',
    'c3ed40c1d6f3c2a349e8d3fd3a968cb458a9fa0e29321c1b397f3b9adcbc0d8e',
    '20260104000000_client_portal',
    NULL,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    1
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- migration: 20260104000001_delivered_at
-- =============================================================================
-- Confirmed delivery timestamp.
--
-- NULL means "not known": the Gmail API and plain SMTP do not report
-- per-message delivery, so this column stays empty until a delivery webhook
-- confirms it. The reporting layer never guesses a value.
ALTER TABLE "SendJob" ADD COLUMN "deliveredAt" TIMESTAMP(3);
CREATE INDEX "SendJob_campaignId_deliveredAt_idx" ON "SendJob"("campaignId", "deliveredAt");

-- Record it as applied (checksum = sha256 of the migration file).
INSERT INTO "_prisma_migrations" (
    id,
    checksum,
    migration_name,
    logs,
    rolled_back_at,
    started_at,
    finished_at,
    applied_steps_count
) VALUES (
    'bf26b36b-61a4-ac38-ac00-2e0f749fc4a9',
    '67632c1bc4773f3b005d8c7079f3837bc7382657fa976ebce494f05e90de4fd7',
    '20260104000001_delivered_at',
    NULL,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    1
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- migration: 20260105000000_pipeline_notifications
-- =============================================================================
-- =============================================================================
-- Lead pipeline, CRM, notifications, template versioning, password reset.
--
-- Additive only: no column is dropped and no data is rewritten.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- The single vocabulary used for reporting, the queue UI and the client portal.
-- "ACCEPTED" means the provider took the message; "DELIVERED" only ever means
-- a delivery event confirmed it. They are never conflated.
CREATE TYPE "MessageStatus" AS ENUM (
  'DRAFT',
  'QUEUED',
  'SCHEDULED',
  'PROCESSING',
  'ACCEPTED',
  'DELIVERED',
  'BOUNCED',
  'FAILED',
  'CANCELLED',
  'REPLIED',
  'UNSUBSCRIBED',
  'SKIPPED'
);

CREATE TYPE "NotificationType" AS ENUM (
  'REPLY',
  'INTERESTED',
  'CAMPAIGN_COMPLETED',
  'CAMPAIGN_FAILED',
  'PROVIDER_DISCONNECTED',
  'QUEUE_FAILURE',
  'IMPORT_COMPLETED',
  'CONFIG_PROBLEM',
  'TASK_DUE',
  'DEAD_LETTER',
  'SYSTEM'
);

CREATE TYPE "ContactActivityType" AS ENUM (
  'CREATED',
  'IMPORTED',
  'UPDATED',
  'EMAIL_SENT',
  'EMAIL_OPENED',
  'EMAIL_CLICKED',
  'REPLIED',
  'UNSUBSCRIBED',
  'BOUNCED',
  'SUPPRESSED',
  'STAGE_CHANGED',
  'PRIORITY_CHANGED',
  'OWNER_CHANGED',
  'NOTE_ADDED',
  'TASK_COMPLETED',
  'CONVERTED'
);

CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

CREATE TYPE "LeadPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

CREATE TYPE "TemplateCategory" AS ENUM (
  'OUTREACH',
  'FOLLOW_UP',
  'INTERESTED',
  'MEETING',
  'PROPOSAL',
  'ONBOARDING',
  'CUSTOM'
);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContactActivity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "type" "ContactActivityType" NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContactActivity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ContactActivity_contactId_createdAt_idx" ON "ContactActivity"("contactId", "createdAt");
CREATE INDEX "ContactActivity_userId_createdAt_idx" ON "ContactActivity"("userId", "createdAt");
ALTER TABLE "ContactActivity" ADD CONSTRAINT "ContactActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactActivity" ADD CONSTRAINT "ContactActivity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContactNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContactNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ContactNote_contactId_createdAt_idx" ON "ContactNote"("contactId", "createdAt");
ALTER TABLE "ContactNote" ADD CONSTRAINT "ContactNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactNote" ADD CONSTRAINT "ContactNote_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contactId" TEXT,
    "campaignId" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Task_userId_status_idx" ON "Task"("userId", "status");
CREATE INDEX "Task_userId_dueAt_idx" ON "Task"("userId", "dueAt");
CREATE INDEX "Task_contactId_idx" ON "Task"("contactId");
ALTER TABLE "Task" ADD CONSTRAINT "Task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LeadStage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isWon" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LeadStage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeadStage_userId_name_key" ON "LeadStage"("userId", "name");
CREATE INDEX "LeadStage_userId_order_idx" ON "LeadStage"("userId", "order");
ALTER TABLE "LeadStage" ADD CONSTRAINT "LeadStage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CampaignSegment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filters" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CampaignSegment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignSegment_userId_name_key" ON "CampaignSegment"("userId", "name");
ALTER TABLE "CampaignSegment" ADD CONSTRAINT "CampaignSegment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "plainTextBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TemplateVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TemplateVersion_templateId_version_key" ON "TemplateVersion"("templateId", "version");
CREATE INDEX "TemplateVersion_templateId_createdAt_idx" ON "TemplateVersion"("templateId", "createdAt");
ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

-- Service: value proposition, qualification criteria, archival.
ALTER TABLE "Service" ADD COLUMN "valueProposition" TEXT;
ALTER TABLE "Service" ADD COLUMN "qualificationCriteria" TEXT;
ALTER TABLE "Service" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;

-- Contact: pipeline stage, priority, owner, industry, archival, conversion.
ALTER TABLE "Contact" ADD COLUMN "industry" TEXT;
ALTER TABLE "Contact" ADD COLUMN "stageId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "priority" "LeadPriority" NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "Contact" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "convertedAt" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "convertedToClientId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Contact_userId_stageId_idx" ON "Contact"("userId", "stageId");
CREATE INDEX "Contact_userId_priority_idx" ON "Contact"("userId", "priority");
CREATE INDEX "Contact_userId_industry_idx" ON "Contact"("userId", "industry");
CREATE INDEX "Contact_userId_isArchived_idx" ON "Contact"("userId", "isArchived");
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "LeadStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- EmailTemplate: category, versioning, plain text, signature, archival.
ALTER TABLE "EmailTemplate" ADD COLUMN "category" "TemplateCategory" NOT NULL DEFAULT 'OUTREACH';
ALTER TABLE "EmailTemplate" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "EmailTemplate" ADD COLUMN "plainTextBody" TEXT;
ALTER TABLE "EmailTemplate" ADD COLUMN "signature" TEXT;
ALTER TABLE "EmailTemplate" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "EmailTemplate_userId_category_idx" ON "EmailTemplate"("userId", "category");

-- Campaign: plain text, signature, segment, pre-flight state.
ALTER TABLE "Campaign" ADD COLUMN "plainTextBody" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "signature" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "segmentId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "preflightCheckedAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "CampaignSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SendJob: dead-letter state.
ALTER TABLE "SendJob" ADD COLUMN "deadLetteredAt" TIMESTAMP(3);
CREATE INDEX "SendJob_deadLetteredAt_idx" ON "SendJob"("deadLetteredAt");

-- Record it as applied (checksum = sha256 of the migration file).
INSERT INTO "_prisma_migrations" (
    id,
    checksum,
    migration_name,
    logs,
    rolled_back_at,
    started_at,
    finished_at,
    applied_steps_count
) VALUES (
    'a2e5bd7b-a3cd-0f5b-bd30-f918348670e4',
    '215b8f322ec79ff6aa9a92fa113782efdbf161fdaca8801e30f80cb921417343',
    '20260105000000_pipeline_notifications',
    NULL,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    1
)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- --------------------------------------------------------------------------
-- Verification. Run this after the script; the counts must be non-zero.
-- --------------------------------------------------------------------------
SELECT
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name <> '_prisma_migrations') AS tables,
    (SELECT count(*) FROM pg_type WHERE typtype = 'e') AS enums,
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public') AS indexes,
    (SELECT count(*) FROM _prisma_migrations) AS migrations;
