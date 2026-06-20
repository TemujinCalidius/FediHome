import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import { verifyAdmin } from "@/lib/auth";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Run the check-updates script as a background child process so the request returns quickly
  const scriptPath = path.join(process.cwd(), "scripts", "check-updates.ts");
  const child = spawn("npx", ["tsx", scriptPath], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  return NextResponse.json({ started: true });
}
