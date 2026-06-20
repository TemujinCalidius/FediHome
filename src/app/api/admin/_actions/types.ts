// The admin POST body is the raw parsed JSON (`await req.json()`), intentionally
// loosely typed: each handler reads and validates the fields it needs, exactly
// as the original monolithic switch did.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdminBody = Record<string, any>;
