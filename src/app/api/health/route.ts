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
    // Managed Postgres (Neon, Supabase, ...) suspends idle instances; the first
    // connection after a suspension can take a while. Retry briefly so a
    // healthy-but-cold database is not reported as down.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await prisma.$queryRaw`SELECT 1`;
        database = "up";
        depth = await queueDepth();
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
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
