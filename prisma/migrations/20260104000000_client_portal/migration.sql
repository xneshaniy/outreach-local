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

-- AlterTable: Campaign — per-campaign tracking switches
ALTER TABLE "Campaign" ADD COLUMN "trackingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN "clickTrackingEnabled" BOOLEAN NOT NULL DEFAULT false;
