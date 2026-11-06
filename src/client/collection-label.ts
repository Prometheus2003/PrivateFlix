export function collectionLabel(
  collections: ReadonlyArray<{
    id: string;
    name: string;
    parentId: string | null;
  }>,
  id: string,
) {
  const names: string[] = [],
    seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current) && seen.size < 100) {
    seen.add(current);
    const item = collections.find((group) => group.id === current);
    if (!item) break;
    names.unshift(item.name);
    current = item.parentId;
  }
  return names.join(" / ");
}
