/**
 * Pre-parsed numeric candidate extraction.
 *
 * Jev's Score primitive rates content on ordered descriptive levels — it
 * cannot extract arbitrary integers like 1200. Instead we find candidate
 * numbers with regex and let Jev select which one (if more than one),
 * then code normalizes the verbatim span.
 *
 * Only numbers of 1–6 digits are considered to avoid noise (very long ids).
 */

const NUMERIC_REGEX = /\b(\d{1,6})\b/g;

/** Returns ordered numeric candidates as verbatim digit strings. */
export function numericCandidates(text: string): string[] {
  return Array.from(text.matchAll(NUMERIC_REGEX), (m) => m[1] ?? "").filter(
    (n) => n.length > 0,
  );
}

/**
 * Decode a candidate choice key like "n3" into the candidate index.
 * Returns undefined if the key is malformed.
 */
export function candidateIndexFromKey(key: string): number | undefined {
  if (!key.startsWith("n") || key.length < 2) return undefined;
  const tail = key.slice(1);
  if (!/^\d+$/.test(tail)) return undefined;
  const idx = Number(tail);
  if (!Number.isInteger(idx) || idx < 0) return undefined;
  return idx;
}
