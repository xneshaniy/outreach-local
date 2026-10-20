import { prisma } from "@/lib/db";

async function main() {
  const rows = await prisma.$queryRaw<Array<{ datname: string }>>`
    SELECT datname FROM pg_database WHERE datname = 'outreach_test'`;
  if (rows.length > 0) {
    console.log("Database outreach_test already exists.");
  } else {
    await prisma.$executeRawUnsafe(`CREATE DATABASE outreach_test`);
    console.log("Database outreach_test created.");
  }
  const all = await prisma.$queryRaw<Array<{ datname: string }>>`SELECT datname FROM pg_database`;
  console.log("Databases:", all.map((r) => r.datname).join(", "));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
