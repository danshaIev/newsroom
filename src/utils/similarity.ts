/**
 * Shared text similarity utilities.
 * Used by knowledge store (dedup), delta computer (gap detection),
 * skill engine (skill matching), and pattern learner.
 */

/** Word-overlap similarity (Jaccard-ish). Returns 0-1. */
export function wordSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  return intersection.size / Math.max(wordsA.size, wordsB.size);
}

/** Extract domain from URL, stripping www. prefix. */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}
