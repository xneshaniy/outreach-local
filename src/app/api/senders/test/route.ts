import { NextRequest } from "next/server";
import nodemailer from "nodemailer";
import { prisma } from "@/lib/db";
import { handleApi, json, assertSameOrigin } from "@/lib/http";
import { requireUser } from "@/lib/auth/guards";
import { ApiError } from "@/lib/errors";
import { fetchGmailProfile } from "@/lib/email/gmail";
import { decryptSecret } from "@/lib/crypto";

/**
 * POST /api/senders/test — verify that a sender account can actually connect.
 *
 * This is a REAL connection test, not a mock:
 *  - SMTP: opens a connection and authenticates (no message is sent).
 *  - Gmail: calls `users.getProfile` with the stored refresh token.
 *
 * The body accepts either { accountId } (test a saved account) or the raw
 * SMTP details (test before saving).
 */
export const POST = handleApi(async (req: NextRequest) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const body = (await req.json().catch(() => ({}))) as {
    accountId?: string;
    host?: string;
    port?: number;
    secure?: boolean;
    username?: string;
    password?: string;
  };

  // --- Test a saved account -------------------------------------------------
  if (body.accountId) {
    const account = await prisma.senderAccount.findFirst({
      where: { id: body.accountId, userId: user.id },
    });
    if (!account) throw ApiError.notFound("Sender account not found.");

    if (account.provider === "GOOGLE") {
      try {
        const profile = await fetchGmailProfile(account);
        return json({
          ok: true,
          provider: "GMAIL",
          address: profile.email,
          message: "Connected to Gmail successfully.",
        });
      } catch (err) {
        return json(
          {
            ok: false,
            provider: "GMAIL",
            error: (err as Error).message,
            hint: "The Google grant may be expired or revoked. Reconnect the account.",
          },
          { status: 200 },
        );
      }
    }

    if (!account.smtpHost || !account.smtpUsername || !account.smtpPasswordEnc) {
      throw ApiError.badRequest("This SMTP account is missing its host or credentials.");
    }

    try {
      const transporter = nodemailer.createTransport({
        host: account.smtpHost,
        port: account.smtpPort ?? 587,
        secure: account.smtpSecure ?? false,
        auth: {
          user: account.smtpUsername,
          pass: decryptSecret(account.smtpPasswordEnc, `sender:${account.id}:smtpPassword`),
        },
        connectionTimeout: 20_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      });
      await transporter.verify();
      return json({
        ok: true,
        provider: "SMTP",
        address: account.email,
        message: "SMTP connection and authentication succeeded.",
      });
    } catch (err) {
      return json(
        {
          ok: false,
          provider: "SMTP",
          error: (err as Error).message,
          hint: "Check the host, port, security mode and credentials.",
        },
        { status: 200 },
      );
    }
  }

  // --- Test unsaved SMTP details -------------------------------------------
  if (!body.host || !body.username || !body.password) {
    throw ApiError.badRequest("Provide an accountId, or the SMTP host, username and password.");
  }

  try {
    const transporter = nodemailer.createTransport({
      host: body.host,
      port: body.port ?? 587,
      secure: body.secure ?? false,
      auth: { user: body.username, pass: body.password },
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    await transporter.verify();
    return json({
      ok: true,
      provider: "SMTP",
      message: "SMTP connection and authentication succeeded.",
    });
  } catch (err) {
    return json(
      {
        ok: false,
        provider: "SMTP",
        error: (err as Error).message,
        hint: "Check the host, port, security mode and credentials.",
      },
      { status: 200 },
    );
  }
});
