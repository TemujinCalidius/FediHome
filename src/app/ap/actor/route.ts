import { NextResponse } from "next/server";
import { getActorProfile } from "@/lib/federation";

export async function GET() {
  const actor = await getActorProfile();

  return NextResponse.json(actor, {
    headers: {
      "Content-Type": "application/activity+json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
