import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import { approveComment, rejectComment } from "./_actions/comments";
import { reply, editReply, backfillReplies } from "./_actions/replies";
import { fediDm, bskyDm, markDmRead, markAllDmsRead } from "./_actions/dms";
import { follow, unfollow, unfollowByUri, block } from "./_actions/fedi-graph";
import { like, boost } from "./_actions/fedi-interactions";
import { bskyReply, syncGraph, bskyFollow, bskyUnfollow } from "./_actions/bluesky";

// Admin actions, extracted from a single 1,000+ line `switch` (#11) into the
// per-domain handlers under `_actions/`. This route is now just the auth + CSRF
// preamble and a thin delegating switch — behaviour is unchanged.
//
// A literal `switch` (rather than a key→handler lookup table) is intentional:
// it dispatches only to the exact action names, so a crafted action value can't
// resolve to an unintended target — the case bodies just forward to the
// extracted handlers, which is also why CodeQL sees no dynamic dispatch here.
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { action } = body;

  switch (action) {
    case "approve_comment": return approveComment(body);
    case "reject_comment": return rejectComment(body);
    case "reply": return reply(body);
    case "edit_reply": return editReply(body);
    case "backfill_replies": return backfillReplies();
    case "dm_reply":
    case "dm_new_fedi": return fediDm(body);
    case "bsky_dm_reply":
    case "bsky_dm_new": return bskyDm(body);
    case "mark_dm_read": return markDmRead(body);
    case "mark_all_dms_read": return markAllDmsRead();
    case "follow": return follow(body);
    case "unfollow": return unfollow(body);
    case "unfollow_by_uri": return unfollowByUri(body);
    case "block": return block(body);
    case "like": return like(body);
    case "boost": return boost(body);
    case "bsky_reply": return bskyReply(body);
    case "sync_bluesky_graph": return syncGraph();
    case "bsky_follow": return bskyFollow(body);
    case "bsky_unfollow": return bskyUnfollow(body);
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}
