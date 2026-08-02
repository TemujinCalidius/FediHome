/**
 * A bounded in-memory tail of recent log lines, for the support bundle (#490).
 *
 * FediHome logs to `console` and nowhere else, so an operator without shell
 * access — a PaaS dashboard they can't scroll, a container they can't exec into
 * — has no way to see why something failed. This keeps the last few hundred
 * lines in memory so the bundle can carry them.
 *
 * ON `globalThis`, NOT A MODULE-LEVEL `let`, AND THAT IS LOAD-BEARING.
 * `instrumentation.ts` reaches modules through a *dynamic* import while route
 * handlers import them *statically*, and those resolve to SEPARATE module
 * instances. A plain `let` would be filled by the boot copy and read as
 * permanently empty by the route — so the bundle would ship an empty log tail
 * while every unit test passed. `scheduler.ts` and `storage-usage.ts` both
 * carry this warning; this is the third.
 *
 * REDACTION HAPPENS AT CAPTURE TIME, not only on the way out. The buffer holds
 * arbitrary strings — an @atproto error, a stack trace, a cache key built as
 * `` `${service}|${identifier}:${password}` `` — so a credential can reach it.
 * Scrubbing on the way out would leave the plaintext sitting in process memory
 * until then. Scrubbing here means it is never stored at all.
 *
 * The redaction set is a synchronously-readable snapshot, refreshed by
 * `refreshRedactionSet()` (async: it decrypts database rows). It cannot be
 * resolved per line — that would be a database round-trip per `console.log`.
 * The bundle re-resolves it and runs one more pass over the finished text, so a
 * credential that changed since the last refresh is still caught on the way out.
 */

const MAX_LINES = 500;
/** Long enough for a stack frame, short enough that one line can't be the tail. */
const MAX_LINE_LEN = 2_000;
/**
 * Below this, a "secret" is too short to redact safely: a 4-character value
 * would blank fragments of ordinary words all over the tail and make it useless.
 * A Bluesky app password (`xxxx-xxxx-xxxx-xxxx`) is 19, the shortest real one.
 */
const MIN_SECRET_LEN = 8;

export const REDACTED = "[redacted]";

export interface LogLine {
  at: number;
  level: string;
  text: string;
}

type Store = {
  __fedihomeLogLines?: LogLine[];
  __fedihomeLogTeeInstalled?: boolean;
  __fedihomeLogTeeBusy?: boolean;
  __fedihomeLogSecrets?: string[];
};

const g = globalThis as typeof globalThis & Store;

function lines(): LogLine[] {
  if (!g.__fedihomeLogLines) g.__fedihomeLogLines = [];
  return g.__fedihomeLogLines;
}

/* ---------------------------- redaction ---------------------------- */

/**
 * Replace every known secret with a placeholder.
 *
 * Exported and used in two places on purpose: at capture, and once over the
 * whole assembled bundle. The second pass is what makes a field added to the
 * bundle later unable to bypass this — it doesn't have to know the field exists.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < MIN_SECRET_LEN) continue;
    // split/join rather than a built regex: a credential can contain any
    // character, and escaping it wrongly would either miss it or throw.
    if (out.includes(s)) out = out.split(s).join(REDACTED);
  }
  return out;
}

/** The snapshot the capture path scrubs against. Empty until the first refresh. */
export function currentSecrets(): string[] {
  return g.__fedihomeLogSecrets ?? [];
}

export function setSecrets(secrets: string[]): void {
  // Longest first, so a credential that contains another as a substring is
  // replaced whole rather than being half-blanked into an unmatchable stub.
  g.__fedihomeLogSecrets = [...new Set(secrets.filter((s) => s && s.length >= MIN_SECRET_LEN))]
    .sort((a, b) => b.length - a.length);
}

/* ------------------------------ capture ----------------------------- */

export function recordLine(level: string, text: string): void {
  const clean = redactSecrets(text, currentSecrets());
  const buf = lines();
  buf.push({
    at: Date.now(),
    level,
    text: clean.length > MAX_LINE_LEN ? `${clean.slice(0, MAX_LINE_LEN)}… (truncated)` : clean,
  });
  // Trim from the front — the tail is what matters, and a while-loop rather than
  // a splice keeps this correct if MAX_LINES is ever lowered at runtime.
  while (buf.length > MAX_LINES) buf.shift();
}

export function getRecentLines(limit = MAX_LINES): LogLine[] {
  const buf = lines();
  return buf.slice(Math.max(0, buf.length - limit));
}

/** Testing seam, and what a "clear the tail" control would call. */
export function resetLogBuffer(): void {
  g.__fedihomeLogLines = [];
  g.__fedihomeLogSecrets = [];
}

/* -------------------------- the console tee -------------------------- */

const LEVELS = ["log", "info", "warn", "error"] as const;

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a); // circular, or a getter that throws
      }
    })
    .join(" ");
}

/**
 * Tee `console.*` into the buffer.
 *
 * Teeing rather than migrating ~94 `console.*` call sites to the structured
 * logger: the migration is worth doing on its own merits and is not worth
 * blocking a diagnostic on.
 *
 * Four properties, each of which is a bug if missed:
 *
 *  - **the original is called FIRST**, so stdout is never lost even if the
 *    recorder throws — the logs an operator already relies on must not depend on
 *    this feature working;
 *  - **re-entrancy guard**, since a recorder that logged would recurse forever;
 *  - **try/catch around the recorder**, for the same reason as the first point;
 *  - **idempotent via a `globalThis` flag**, so a dev-server restart or a second
 *    `register()` can't stack wrappers and record each line N times.
 *
 * NOT called at import time, deliberately. An import-time patch would install
 * itself inside any test that imports this module — including `log.test.ts`,
 * which spies on `console` and would then be asserting against a wrapper.
 */
export function installConsoleTee(): boolean {
  if (g.__fedihomeLogTeeInstalled) return false;
  g.__fedihomeLogTeeInstalled = true;

  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const level of LEVELS) {
    const original = target[level].bind(console);
    target[level] = (...args: unknown[]) => {
      original(...args);
      if (g.__fedihomeLogTeeBusy) return;
      g.__fedihomeLogTeeBusy = true;
      try {
        recordLine(level, format(args));
      } catch {
        // A diagnostic must never be able to break logging.
      } finally {
        g.__fedihomeLogTeeBusy = false;
      }
    };
  }
  return true;
}

/** Whether this process installed the tee. */
export function consoleTeeInstalled(): boolean {
  return !!g.__fedihomeLogTeeInstalled;
}
