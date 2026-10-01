interface Named {
  id: string;
  name: string;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longer names first, so "@Astra-2" is not read as "@Astra" when both exist.
const byLength = <T extends { name: string }>(items: T[]) =>
  items.toSorted((a, b) => b.name.length - a.name.length);

/** Members whose `@name` appears in the body. */
export function findMentions(body: string, members: Named[]): string[] {
  let rest = body;
  const ids: string[] = [];
  for (const member of byLength(members)) {
    const token = `@${member.name}`;
    if (!rest.includes(token)) continue;
    ids.push(member.id);
    rest = rest.split(token).join(' ');
  }
  return ids;
}

/** Splits a body into plain text and `@name` tokens for highlighting. */
export function mentionSegments(body: string, names: string[]) {
  if (!names.length) return [{ text: body, mention: false }];
  const tokens = byLength(names.map((name) => ({ name }))).map((n) => escape(n.name));
  // The capturing group keeps each token at an odd index of the split.
  return body
    .split(new RegExp(`(@(?:${tokens.join('|')}))`))
    .map((text, index) => ({ text, mention: index % 2 === 1 }))
    .filter((segment) => segment.text);
}

// "@" right after an ASCII word, as in an email address, does not start a mention; after CJK
// text or punctuation it does.
export const mentionBoundary = /[A-Za-z0-9_.]/;

/** The `@query` being typed right before the caret, if any. */
export function mentionQuery(text: string, caret: number) {
  const match = /(?:^|[^A-Za-z0-9_.])@([^\s@]{0,40})$/.exec(text.slice(0, caret));
  if (!match) return undefined;
  const query = match[1] ?? '';
  return { start: caret - query.length - 1, query };
}
