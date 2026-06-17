import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Prisma 7 no longer auto-loads .env files. Load them explicitly so the CLI
// (prisma generate / db push / migrate) can find DATABASE_URL. .env.local takes
// precedence (Next.js convention); .env is the fallback.
config({ path: ".env.local" });
config({ path: ".env" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // Use process.env directly rather than prisma's env() helper: env() throws
    // eagerly when DATABASE_URL is unset, which breaks `prisma generate` in
    // contexts that don't have a DB (CI, Docker build). Generate doesn't use
    // the URL; db push/migrate get the real value when it's set.
    url: process.env.DATABASE_URL ?? "",
  },
});
