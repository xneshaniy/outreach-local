import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle in .next/standalone.
  // Required by the Docker image and for deploying to shared hosting.
  output: "standalone",
  // Prisma client is a native/Node dependency; keep it external to the server bundle.
  serverExternalPackages: ["@prisma/client", "bcryptjs", "googleapis", "nodemailer"],
  experimental: {
    serverActions: {
      bodySizeLimit: "12mb",
    },
    // Limit build concurrency to avoid resource exhaustion on constrained hosts
    workerThreads: false,
    cpus: 1,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // Public, unauthenticated endpoints.
        source: "/api/unsubscribe",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
