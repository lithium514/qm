export function parseAllowFrom(raw: string | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const entry = part.trim().toLowerCase().replace(/^@+/, "");
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

export function normalizeAllowFrom(entries: readonly unknown[] | undefined): string[] {
  if (!entries) return [];
  return parseAllowFrom(entries.filter((e) => typeof e === "string").join(","));
}
