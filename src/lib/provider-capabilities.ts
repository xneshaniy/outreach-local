/**
 * Provider capabilities.
 *
 * Not every provider reports the same things. This module is the single place
 * that says what a provider can and cannot do, so the UI can label an
 * unavailable metric as unavailable instead of showing a misleading zero.
 */

export type ProviderKind = "GMAIL" | "SMTP" | "MOCK";

export type ProviderCapabilities = {
  /** The provider tells us the message was accepted. */
  acceptsMessages: boolean;
  /** The provider confirms per-message delivery. */
  reportsDelivery: boolean;
  /** The provider reports bounces. */
  reportsBounces: boolean;
  /** The provider reports the recipient's reply. */
  reportsReplies: boolean;
  /** The provider offers its own open tracking. */
  nativeOpenTracking: boolean;
  /** The provider offers its own click tracking. */
  nativeClickTracking: boolean;
  /** The provider can verify a sender identity. */
  verifiesSenderIdentity: boolean;
  /** The provider enforces its own sending limit. */
  hasProviderLimit: boolean;
};

const CAPABILITIES: Record<ProviderKind, ProviderCapabilities> = {
  GMAIL: {
    acceptsMessages: true,
    // The Gmail API does NOT expose per-message delivery for ordinary
    // accounts. It is only known when a delivery webhook confirms it.
    reportsDelivery: false,
    reportsBounces: true,
    // Replies are read by polling the inbox with the gmail.readonly scope.
    reportsReplies: true,
    nativeOpenTracking: false,
    nativeClickTracking: false,
    verifiesSenderIdentity: true,
    hasProviderLimit: true,
  },
  SMTP: {
    acceptsMessages: true,
    reportsDelivery: false,
    // An SMTP server may reject an address at submit time, which is a bounce
    // of sorts, but it cannot report a later bounce.
    reportsBounces: true,
    reportsReplies: false,
    nativeOpenTracking: false,
    nativeClickTracking: false,
    verifiesSenderIdentity: false,
    hasProviderLimit: false,
  },
  MOCK: {
    acceptsMessages: true,
    reportsDelivery: true,
    reportsBounces: true,
    reportsReplies: false,
    nativeOpenTracking: false,
    nativeClickTracking: false,
    verifiesSenderIdentity: false,
    hasProviderLimit: false,
  },
};

export function capabilitiesFor(provider: ProviderKind): ProviderCapabilities {
  return CAPABILITIES[provider] ?? CAPABILITIES.SMTP;
}

/** The metrics a provider cannot supply, for the "not available" labels. */
export function unavailableMetrics(provider: ProviderKind): string[] {
  const caps = capabilitiesFor(provider);
  const out: string[] = [];
  if (!caps.reportsDelivery) out.push("delivered");
  if (!caps.nativeOpenTracking && !caps.reportsReplies) out.push("opens (provider-side)");
  if (!caps.reportsReplies) out.push("replies");
  return out;
}
