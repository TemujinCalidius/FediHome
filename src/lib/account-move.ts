import { prisma } from "./db";
import { getIdentity, getSiteUrl } from "./identity";
import { assertPublicHost } from "./url-guard";
import { signedGet, deliverToFollowers } from "./http-signatures";

/**
 * Leaving FediHome: `movedTo` plus an outbound `Move` (#347).
 *
 * The "no lock-in" promise made real — take your FOLLOWERS to another server.
 * The handshake is two-sided and both sides must agree:
 *
 *   1. On the NEW account, the owner adds `alsoKnownAs: ["<this actor>"]`.
 *   2. Here, `movedTo` is set and a `Move` goes out to every follower.
 *   3. Each receiving server fetches BOTH ends and re-points its follow only if
 *      the new actor's `alsoKnownAs` names this one.
 *
 * STEP 3 IS WHY THIS IS NOT A RENAME, and it is the thing the UI has to make
 * unmissable: this instance must keep serving while followers migrate. A `Move`
 * published from a domain the owner no longer controls cannot be verified, so
 * nothing moves — and those followers are unrecoverable by any later action.
 * FEP-7628 asks servers to keep serving `movedTo` for at least a year.
 *
 * WHAT MOVES: followers, and only followers. Posts, the owner's own following
 * list, blocks and mutes do not transfer — the same limits Mastodon has, for the
 * same reasons.
 *
 * The keypair needs no attention. `ActorKeys` is a single `main` row and `keyId`
 * is derived from the current identity at use time, so a `Move` signed by the
 * old key from the old domain is exactly what the handshake wants.
 */

export const MOVED_TO_KEY = "identity.movedTo";
export const MOVED_AT_KEY = "identity.movedAt";
export const MOVE_ACTIVITY_ID_KEY = "identity.moveActivityId";

/**
 * How long before a DIFFERENT destination may be set, matching Mastodon.
 *
 * It bounds the damage of a mistake rather than preventing one: every server
 * that already honoured the first Move has re-pointed its follow, and a second
 * hop is a second chance for a server to be down and lose the follower for good.
 * Cancelling and re-sending the SAME move are both always allowed — the cooldown
 * is on changing your mind about where you went, not on fixing a delivery.
 */
export const MOVE_COOLDOWN_DAYS = 30;

const ACTOR_FETCH_TIMEOUT_MS = 8000;

/**
 * Strip trailing slashes without a regex.
 *
 * `/\/+$/` looks harmless but backtracks quadratically on a long run of slashes
 * followed by anything else — and these strings come straight out of a REMOTE
 * actor document, so a hostile server could send 100KB of slashes and burn CPU
 * in our inbox. Caught by CodeQL (js/polynomial-redos). A character scan is O(n)
 * and cannot backtrack.
 *
 * Moved here with the rest of the Move verification (#347) rather than copied:
 * writing this module produced a `.replace(/\/+$/, "")` on the first attempt,
 * which is the exact expression that was removed.
 */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return s.slice(0, end);
}

/** Compare actor ids the way a remote server does — exact, bar a trailing slash. */
export function sameActor(a: string, b: string): boolean {
  return stripTrailingSlashes(a) === stripTrailingSlashes(b);
}

export interface MoveActorDoc {
  inbox: string | null;
  username: string;
  domain: string;
  displayName: string | null;
  avatarUrl: string | null;
  alsoKnownAs: string[];
}

/**
 * Fetch an actor for Move verification, including `alsoKnownAs`.
 *
 * `signedGet`, not a plain guarded read: an instance running authorized fetch
 * (Mastodon's secure mode) answers an unsigned actor request with 401, and
 * silently failing to verify would mean silently refusing every move involving
 * such a server — inbound or outbound.
 *
 * Shared with the inbound half (#339) on purpose. The alsoKnownAs check is the
 * security property in both directions, and two copies of a security check is
 * one copy too many.
 */
export async function fetchActorForMove(actorUri: string): Promise<MoveActorDoc | null> {
  if (!(await assertPublicHost(actorUri))) return null;
  try {
    const res = await signedGet(actorUri, ACTOR_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const actor = await res.json();
    const aka = actor.alsoKnownAs;
    return {
      inbox: typeof actor.inbox === "string" ? actor.inbox : null,
      username: actor.preferredUsername || "unknown",
      domain: new URL(actorUri).hostname,
      displayName: actor.name || null,
      avatarUrl: actor.icon?.url || null,
      alsoKnownAs: (Array.isArray(aka) ? aka : aka ? [aka] : []).filter(
        (v: unknown): v is string => typeof v === "string",
      ),
    };
  } catch {
    return null;
  }
}

/* ------------------------------- state ------------------------------- */

export interface MoveState {
  /** The destination actor URI, or null when this account hasn't moved. */
  movedTo: string | null;
  /** When the move was declared (ISO), or null. */
  movedAt: string | null;
  /**
   * The `Move` activity's id. STABLE, and stored for that reason: the retry
   * queue is keyed `@@unique([activityId, inbox])`, so a regenerated id would
   * make every retry a fresh activity that the queue can't dedupe and that
   * remote servers would process again from scratch.
   */
  activityId: string | null;
  /** Days left before a DIFFERENT destination may be set. 0 when free. */
  cooldownDaysLeft: number;
}

/** Just the destination — the hot path, read on every actor render. */
export async function getMovedTo(): Promise<string | null> {
  try {
    const row = await prisma.siteSetting.findUnique({ where: { key: MOVED_TO_KEY } });
    const v = row?.value?.trim();
    return v ? v : null;
  } catch {
    // A database blip must not silently un-move the account: an actor document
    // that drops `movedTo` tells every remote server the move was reverted.
    // Returning null here is the safe direction only because the alternative —
    // throwing — would 500 the actor document entirely, which is worse.
    return null;
  }
}

export async function getMoveState(now: Date = new Date()): Promise<MoveState> {
  const rows = await prisma.siteSetting.findMany({
    where: { key: { in: [MOVED_TO_KEY, MOVED_AT_KEY, MOVE_ACTIVITY_ID_KEY] } },
  });
  const o = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const movedTo = o[MOVED_TO_KEY]?.trim() || null;
  const movedAt = o[MOVED_AT_KEY]?.trim() || null;

  let cooldownDaysLeft = 0;
  if (movedTo && movedAt) {
    const at = new Date(movedAt);
    if (!isNaN(at.getTime())) {
      const elapsedDays = (now.getTime() - at.getTime()) / 86_400_000;
      cooldownDaysLeft = Math.max(0, Math.ceil(MOVE_COOLDOWN_DAYS - elapsedDays));
    }
  }

  return {
    movedTo,
    movedAt,
    activityId: o[MOVE_ACTIVITY_ID_KEY]?.trim() || null,
    cooldownDaysLeft,
  };
}

/** Has this account declared a move? Used to refuse new posts. */
export async function hasMoved(): Promise<boolean> {
  return (await getMovedTo()) !== null;
}

/* ------------------------------ verify ------------------------------- */

export type MoveCheck =
  | { ok: true; target: string; actor: MoveActorDoc }
  | { ok: false; reason: string };

/**
 * Everything a receiving server will check, checked here first.
 *
 * Sending an unverifiable `Move` is not a harmless no-op. Followers stay where
 * they are, the owner is told nothing, and they find out months later when the
 * old instance is already gone — by which point there is no action that
 * recovers them. Refusing to send is the only useful answer.
 */
export async function verifyMoveTarget(rawTarget: string): Promise<MoveCheck> {
  const target = rawTarget.trim();
  if (!target) return { ok: false, reason: "Enter the address of the account you're moving to." };

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return {
      ok: false,
      reason:
        "That isn't a full account address. It needs to be the actor URL of the " +
        "new account — usually something like https://example.social/users/you.",
    };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "The new account's address must be an http(s) URL." };
  }

  const self = `${getSiteUrl()}/ap/actor`;
  if (sameActor(target, self)) {
    return { ok: false, reason: "That's this account. Enter the account you're moving to." };
  }

  const actor = await fetchActorForMove(target);
  if (!actor) {
    return {
      ok: false,
      reason:
        "Couldn't read that account. Check the address, and make sure the new " +
        "server is reachable — it has to be, for the move to be verified.",
    };
  }
  if (!actor.inbox) {
    return { ok: false, reason: "That address doesn't look like a Fediverse account (it has no inbox)." };
  }

  // THE check, and the reason this function exists. Every receiving server does
  // exactly this and refuses the Move if it fails.
  if (!actor.alsoKnownAs.some((alias) => sameActor(alias, self))) {
    return {
      ok: false,
      reason:
        `The new account doesn't list this one as an alias yet. On ${url.hostname}, ` +
        `add ${self} to its "aliases" (alsoKnownAs) and try again — without it, ` +
        `every server will refuse the move and your followers stay here.`,
    };
  }

  return { ok: true, target, actor };
}

/* ------------------------------- send -------------------------------- */

function buildMove(target: string, activityId: string): Record<string, unknown> {
  const self = `${getSiteUrl()}/ap/actor`;
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: activityId,
    type: "Move",
    actor: self,
    // `object` is the account being moved — us. Mastodon reads `object` on some
    // paths and `actor` on others, so both are present and identical.
    object: self,
    target,
    to: [`${getSiteUrl()}/ap/followers`],
  };
}

export interface MoveResult {
  ok: boolean;
  target?: string;
  activityId?: string;
  reason?: string;
}

/**
 * Declare the move and fan the `Move` out to every follower.
 *
 * Order matters: `movedTo` is written FIRST. A receiving server fetches this
 * actor to verify, and if it arrives before the row is written it reads an
 * account that hasn't moved and refuses. Writing first costs nothing if the
 * delivery then fails — the state is recoverable and the Move is re-sendable —
 * whereas delivering first is a race that silently loses followers.
 */
export async function startMove(rawTarget: string, now: Date = new Date()): Promise<MoveResult> {
  const state = await getMoveState(now);

  const check = await verifyMoveTarget(rawTarget);
  if (!check.ok) return { ok: false, reason: check.reason };

  if (state.movedTo && !sameActor(state.movedTo, check.target) && state.cooldownDaysLeft > 0) {
    return {
      ok: false,
      reason:
        `You moved this account ${MOVE_COOLDOWN_DAYS - state.cooldownDaysLeft} day(s) ago. ` +
        `Moving somewhere else again is possible in ${state.cooldownDaysLeft} more day(s). ` +
        `You can cancel the current move, or send it again, at any time.`,
    };
  }

  // Reuse the existing id when re-declaring the SAME destination, so a repeat is
  // a redelivery rather than a second activity remote servers process afresh.
  const activityId =
    state.activityId && state.movedTo && sameActor(state.movedTo, check.target)
      ? state.activityId
      : `${getSiteUrl()}/ap/move/${now.getTime()}`;

  await writeMoveState({ movedTo: check.target, movedAt: now.toISOString(), activityId });
  await deliverToFollowers(buildMove(check.target, activityId));

  return { ok: true, target: check.target, activityId };
}

/**
 * Send the same `Move` again.
 *
 * Worth having as its own action rather than relying on the retry queue alone:
 * the queue only knows about inboxes that were tried and failed, and there are
 * two cases it can't cover — a server that accepted the delivery and did nothing
 * with it, and a follower who arrived AFTER the move was declared. Both are
 * fixed by sending it again, and the stable id means every server that already
 * honoured it ignores the repeat.
 */
export async function resendMove(): Promise<MoveResult> {
  const state = await getMoveState();
  if (!state.movedTo || !state.activityId) {
    return { ok: false, reason: "This account hasn't moved anywhere, so there's nothing to re-send." };
  }
  await deliverToFollowers(buildMove(state.movedTo, state.activityId));
  return { ok: true, target: state.movedTo, activityId: state.activityId };
}

/**
 * Un-declare the move.
 *
 * Does NOT bring followers back, and the UI must say so: every server that
 * already honoured the Move has re-pointed its follow to the new account, and
 * nothing here reaches into their database. What it does is stop telling
 * *future* visitors and servers that this account has moved — which is the
 * correct fix for a move declared by mistake, and useless for one that worked.
 */
export async function cancelMove(): Promise<void> {
  await prisma.siteSetting.deleteMany({
    where: { key: { in: [MOVED_TO_KEY, MOVED_AT_KEY, MOVE_ACTIVITY_ID_KEY] } },
  });
}

async function writeMoveState(v: { movedTo: string; movedAt: string; activityId: string }): Promise<void> {
  const rows: [string, string][] = [
    [MOVED_TO_KEY, v.movedTo],
    [MOVED_AT_KEY, v.movedAt],
    [MOVE_ACTIVITY_ID_KEY, v.activityId],
  ];
  for (const [key, value] of rows) {
    await prisma.siteSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
}

/** Human-facing label for the destination, e.g. "@ada@new.example". */
export function moveHandle(target: string): string {
  try {
    const u = new URL(target);
    const name = u.pathname.split("/").filter(Boolean).pop() || getIdentity().fediHandle;
    return `@${name}@${u.hostname}`;
  } catch {
    return target;
  }
}
