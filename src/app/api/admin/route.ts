import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, verifyOrigin, hasScope } from "@/lib/auth";
import { approveComment, rejectComment } from "./_actions/comments";
import { reply, editReply, backfillReplies } from "./_actions/replies";
import { fediDm, bskyDm, markDmRead, markAllDmsRead } from "./_actions/dms";
import { follow, unfollow, unfollowByUri, block, unblock } from "./_actions/fedi-graph";
import { like, boost, unlike, unboost } from "./_actions/fedi-interactions";
import { bskyReply, syncGraph, bskyFollow, bskyUnfollow } from "./_actions/bluesky";
import { updateProfile } from "./_actions/profile";

// Least-privilege scope per action, so a connected app's token only reaches the
// surface it was granted:
//   interact — reversible fediverse actions (like/boost/reply/follow)
//   dm       — read/send direct messages
//   manage   — moderation + maintenance, INCLUDING destructive ops (backfill/
//              sync, comment moderation, and `block` — which deletes the target
//              actor's posts + interactions, so it's not a mere interaction)
// The owner cookie satisfies any of them. An action missing from this map is
// unknown → the switch's default returns 400 (after auth).
const ACTION_SCOPE: Record<string, string> = {
  approve_comment: "manage",
  reject_comment: "manage",
  backfill_replies: "manage",
  sync_bluesky_graph: "manage",
  block: "manage", // unfollows + deletes the actor's posts/interactions → destructive
  unblock: "manage", // reverses block: removes the record + delivers Undo Block
  update_profile: "manage", // edits the owner's public profile + federates actor Update
  reply: "interact",
  edit_reply: "interact",
  follow: "interact",
  unfollow: "interact",
  unfollow_by_uri: "interact",
  like: "interact",
  unlike: "interact",
  boost: "interact",
  unboost: "interact",
  bsky_reply: "interact",
  bsky_follow: "interact",
  bsky_unfollow: "interact",
  dm_reply: "dm",
  dm_new_fedi: "dm",
  bsky_dm_reply: "dm",
  bsky_dm_new: "dm",
  mark_dm_read: "dm",
  mark_all_dms_read: "dm",
};

// Admin actions, extracted from a single 1,000+ line `switch` (#11) into the
// per-domain handlers under `_actions/`. This route is now the auth + CSRF
// preamble, a per-action scope gate, and a thin delegating switch.
//
// A literal `switch` (rather than a key→handler lookup table) is intentional:
// it dispatches only to the exact action names, so a crafted action value can't
// resolve to an unintended target — the case bodies just forward to the
// extracted handlers, which is also why CodeQL sees no dynamic dispatch here.
export async function POST(req: NextRequest) {
  // Authenticate FIRST (cheap, header-only) so an unauthenticated request is
  // rejected before we parse the body. The required scope depends on the action
  // (in the body), so it's gated below, per-action.
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // The cookie is ambient → the web path still needs CSRF; a bearer isn't.
  if (auth.via === "cookie" && !verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const { action } = body;

  // Per-action scope gate for token callers; the owner cookie has full rights.
  // An unknown action isn't in the map → not gated here, and falls through to
  // the switch's 400 default.
  const need = ACTION_SCOPE[action];
  if (auth.via === "bearer" && need && !hasScope(auth.scope, need)) {
    return NextResponse.json({ error: "insufficient_scope" }, { status: 403 });
  }

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
    case "unblock": return unblock(body);
    case "update_profile": return updateProfile(body);
    case "like": return like(body);
    case "unlike": return unlike(body);
    case "boost": return boost(body);
    case "unboost": return unboost(body);
    case "bsky_reply": return bskyReply(body);
    case "sync_bluesky_graph": return syncGraph();
    case "bsky_follow": return bskyFollow(body);
    case "bsky_unfollow": return bskyUnfollow(body);
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}
