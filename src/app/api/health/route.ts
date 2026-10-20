import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { queueDepth } from "@/lib/queue";

/**
 * GET /api/health — lightweight liveness + readiness probe (public).
 * Reports database reachability and queue depth; NEVER exposes secrets.
 */
export async function GET() {
  const startedAt = Date.now();
  let database: "up" | "down" = "down";
  let depth: Record<string, number> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    database = "up";
    depth = await queueDepth();
  } catch {
    database = "down";
  }

  const healthy = database === "up";
  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      version: "0.1.0",
      environment: env.nodeEnv,
      database,
      queue: depth,
      uptimeSeconds: Math.round(process.uptime()),
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
