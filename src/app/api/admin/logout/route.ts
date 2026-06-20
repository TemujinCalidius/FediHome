import { NextRequest, NextResponse } from "next/server";
import { deleteAdminSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  // Revoke the persisted session so the cookie can't be reused even if its
  // HMAC still validates, then clear it from the browser. (#14)
  await deleteAdminSession(req.cookies.get("sl_admin")?.value);

  const response = NextResponse.json({ success: true });
  response.cookies.set("sl_admin", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return response;
}
