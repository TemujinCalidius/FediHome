import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

// Prisma 7 no longer auto-loads .env files. Load them explicitly so the CLI
// (prisma generate / db push / migrate) can find DATABASE_URL. .env.local takes
// precedence (Next.js convention); .env is the fallback.
config({ path: ".env.local" });
config({ path: ".env" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
