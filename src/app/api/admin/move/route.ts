import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  getMoveState, startMove, resendMove, cancelMove, moveHandle, MOVE_COOLDOWN_DAYS,
} from "@/lib/account-move";

/**
 * Leaving FediHome — `movedTo` plus an outbound `Move` (#347).
 *
 * Cookie-only (`verifyAdmin`, no bearer path), like the aliases and identity
 * routes beside it. Declaring a move tells every follower's server to re-point
 * its follow somewhere else, which is the second half of an account takeover if
 * an app token could do it — and no app has any business doing this.
 *
 * `runtime = "nodejs"` because the delivery path signs requests with the actor
 * key, which needs node:crypto.
 */
export const runtime = "nodejs";

/** Bounded so a malformed body can't become a giant actor fetch. */
const MAX_TARGET_LEN = 500;

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const state = await getMoveState();
  // The follower count is the number this decision is actually about, and it is
  // the one thing the owner cannot look up while deciding.
  const followers = await prisma.fediFollower.count({ where: { accepted: true } }).catch(() => 0);
  return NextResponse.json({
    ...state,
    handle: state.movedTo ? moveHandle(state.movedTo) : null,
    followers,
    cooldownDays: MOVE_COOLDOWN_DAYS,
  });
}

export async function POST(req: NextRequest) {
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const action = typeof body?.action === "string" ? body.action : "start";

  if (action === "cancel") {
    await cancelMove();
    return NextResponse.json({ success: true, ...(await getMoveState()) });
  }

  if (action === "resend") {
    const r = await resendMove();
    if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
    return NextResponse.json({ success: true, ...(await getMoveState()) });
  }

  const target = typeof body?.target === "string" ? body.target : null;
  if (target === null) {
    return NextResponse.json({ error: "target must be a string" }, { status: 400 });
  }
  if (target.length > MAX_TARGET_LEN) {
    return NextResponse.json({ error: "That's too long to be an account address." }, { status: 400 });
  }

  // 400, not 500: every refusal from here is something the owner can act on —
  // a typo, a missing alias on the other end, an unreachable server — and the
  // reason string says which. `startMove` never sends an unverifiable Move.
  const r = await startMove(target);
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });

  const state = await getMoveState();
  return NextResponse.json({
    success: true,
    ...state,
    handle: state.movedTo ? moveHandle(state.movedTo) : null,
  });
}
