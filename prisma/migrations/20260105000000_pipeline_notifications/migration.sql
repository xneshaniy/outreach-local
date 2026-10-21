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
