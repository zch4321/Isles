type Named = { id: string; name: string };
const compactId = (id: string) => id.replaceAll('-', '');

/** Short IDs only disambiguate display names; tool addresses remain full UUIDs. */
function uniquePrefix(id: string, peers: string[]) {
  const value = compactId(id);
  let length = Math.min(8, value.length);
  while (
    length < value.length &&
    peers.some((other) => other !== id && compactId(other).startsWith(value.slice(0, length)))
  )
    length++;
  return value.slice(0, length);
}

export function nameLabels(entries: Named[], format = (name: string) => name) {
  const names = new Map(entries.map(({ id, name }) => [id, name]));
  const peers = new Map<string, string[]>();
  for (const [id, name] of names) peers.set(name, [...(peers.get(name) ?? []), id]);
  return new Map(
    [...names].map(([id, name]) => {
      const sameName = peers.get(name)!;
      return [id, `${format(name)}${sameName.length > 1 ? `#${uniquePrefix(id, sameName)}` : ''}`];
    }),
  );
}
