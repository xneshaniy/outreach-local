import { prisma } from "../db";
import { ApiError } from "../errors";
import { readSessionToken } from "./session";
import type { User } from "@prisma/client";

/**
 * Authorization guards.
 *
 * Every API route must resolve the authenticated user from the session cookie
 * and verify ownership of every requested resource. There are no hardcoded
 * user IDs anywhere in this codebase.
 */

export async function getCurrentUser(): Promise<User | null> {
  const session = await readSessionToken();
  if (!session) return null;

  const user = await prisma.user.findUnique({ where: { id: session.sub } });
  if (!user) return null;
  // Token issued before a "log out everywhere" / password change -> reject.
  if (user.sessionVersion !== session.sv) return null;
  return user;
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw ApiError.unauthorized();
  return user;
}

/**
 * Fetch a campaign owned by the given user or 404/403.
 * (404 rather than 403 for other users' resources to avoid leaking existence.)
 */
export async function requireCampaign(userId: string, campaignId: string) {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, userId } });
  if (!campaign) throw ApiError.notFound("Campaign not found.");
  return campaign;
}

export async function requireSenderAccount(userId: string, accountId: string) {
  const account = await prisma.senderAccount.findFirst({ where: { id: accountId, userId } });
  if (!account) throw ApiError.notFound("Sender account not found.");
  return account;
}

export async function requireContact(userId: string, contactId: string) {
  const contact = await prisma.contact.findFirst({ where: { id: contactId, userId } });
  if (!contact) throw ApiError.notFound("Contact not found.");
  return contact;
}

export async function requireTemplate(userId: string, templateId: string) {
  const template = await prisma.emailTemplate.findFirst({ where: { id: templateId, userId } });
  if (!template) throw ApiError.notFound("Template not found.");
  return template;
}
