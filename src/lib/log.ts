/**
 * Minimal, zero-dependency structured logger (#17). Emits one JSON line per call
 * — `{ level, ts, msg, ...fields }` — to stdout/stderr, so logs stay greppable
 * and parseable by a log collector without pulling in pino/winston. Server-side.
 *
 * The broad `console.*` → `log.*` migration is intentionally incremental; new
 * server code should prefer this, and `Error` values in `fields` are serialized
 * (name/message/stack) since raw `JSON.stringify(err)` yields `{}`.
 */
type Fields = Record<string, unknown>;
type Level = "info" | "warn" | "error";

function serialize(fields?: Fields): Fields {
  if (!fields) return {};
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
  }
  return out;
}

function emit(level: Level, msg: string, fields?: Fields): void {
  const line = JSON.stringify({ level, ts: new Date().toISOString(), msg, ...serialize(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
