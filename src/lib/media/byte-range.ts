/** A single byte range; multiple ranges are deliberately unsupported. */
export function parseByteRange(value: string | null, size: number) {
  if (!value) return null;
  if (!Number.isSafeInteger(size) || size <= 0 || value.length > 100)
    throw new Error("Invalid range");
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) throw new Error("Invalid range");
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    throw new Error("Invalid range");
  if (first === undefined) {
    if (!last) throw new Error("Invalid suffix");
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== undefined && last < first))
    throw new Error("Unsatisfiable range");
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}
