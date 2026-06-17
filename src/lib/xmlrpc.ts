/**
 * Non-backtracking value extraction for the XML-RPC (MetaWeblog) endpoint.
 *
 * The payloads we accept are simple and flat, so values are located by scanning
 * for tag delimiters with `indexOf` rather than with regular expressions. This
 * is linear in the input length and immune to the polynomial backtracking
 * (ReDoS) that lazy/greedy regex tag-matching invites on hostile input. Callers
 * should still bound the overall request size as defence-in-depth.
 */

/** Text between the first `<tag>` and the following `</tag>`, or null if unpaired. */
export function between(xml: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = xml.indexOf(open);
  if (start === -1) return null;
  const from = start + open.length;
  const end = xml.indexOf(close, from);
  if (end === -1) return null;
  return xml.slice(from, end);
}

/** Inner text of every `<tag>…</tag>` block, in document order. */
export function allBlocks(xml: string, tag: string): string[] {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const start = xml.indexOf(open, i);
    if (start === -1) break;
    const from = start + open.length;
    const end = xml.indexOf(close, from);
    if (end === -1) break;
    out.push(xml.slice(from, end));
    i = end + close.length;
  }
  return out;
}

/**
 * Strip tags in a single linear pass — equivalent to `replace(/<[^>]+>/g, "")`
 * but without the backtracking, and it also drops a dangling unclosed `<…`
 * (the regex would leave it behind, which is the incomplete-sanitization risk).
 */
export function stripTags(s: string): string {
  let out = "";
  let inTag = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inTag) {
      if (ch === "<") inTag = true;
      else out += ch;
    } else if (ch === ">") {
      inTag = false;
    }
  }
  return out;
}

/** Return `s` only if it fully matches the (anchored, ReDoS-safe) pattern. */
function onlyIf(s: string | null, pattern: RegExp): string | null {
  return s !== null && pattern.test(s) ? s : null;
}

/**
 * The value of the `index`-th `<param>` (those carrying a `<value>`), preferring
 * `<string>` then a digits-only `<int>`, falling back to tag-stripped text.
 */
export function extractParam(xml: string, index: number): string {
  const params = allBlocks(xml, "param").filter((p) => p.includes("<value>"));
  const val = params[index];
  if (val === undefined) return "";
  const str = between(val, "string");
  if (str !== null) return str;
  const int = onlyIf(between(val, "int"), /^\d+$/);
  if (int !== null) return int;
  return stripTags(val).trim();
}

/**
 * Flatten a `<struct>` into a name→value map. Per member, the value is the
 * `<string>` (preferred), else a digits-only `<int>`, else a single-digit
 * `<boolean>`. An empty `<string></string>` falls through to int/boolean, and
 * nameless members are skipped — matching the original regex behaviour.
 */
export function extractStruct(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const member of allBlocks(xml, "member")) {
    const name = between(member, "name");
    if (!name) continue;
    result[name] =
      between(member, "string") ||
      onlyIf(between(member, "int"), /^\d+$/) ||
      onlyIf(between(member, "boolean"), /^\d$/) ||
      "";
  }
  return result;
}
