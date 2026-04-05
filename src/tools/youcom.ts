/**
 * You.com API integration for agent tools.
 * Provides search, deep research, and content extraction.
 * Free tier works without API key; key unlocks higher rate limits.
 */

import { circuits } from '../utils/circuit-breaker.js';

const YOU_API_BASE = 'https://api.you.com';
const youCircuit = circuits.get('youcom');

function getApiKey(): string | undefined {
  return process.env.YDC_API_KEY;
}

function authHeaders(): Record<string, string> {
  const key = getApiKey();
  return key
    ? { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

interface YouSearchResult {
  title: string;
  url: string;
  description: string;
  snippets?: string[];
}

/**
 * Web + news search with filtering.
 * Better than Brave for investigative queries — supports site filtering,
 * date ranges, and news-specific search.
 */
export async function youSearch(query: string, options?: {
  numResults?: number;
  country?: string;
  searchType?: 'web' | 'news';
}): Promise<string> {
  const numResults = options?.numResults ?? 8;
  const searchType = options?.searchType ?? 'web';

  if (!youCircuit.canExecute()) {
    return `[You.com circuit open — service temporarily unavailable]`;
  }

  try {
    const params = new URLSearchParams({
      query,
      num_web_results: String(numResults),
    });
    if (options?.country) params.set('country', options.country);

    const endpoint = searchType === 'news'
      ? `${YOU_API_BASE}/api/news`
      : `${YOU_API_BASE}/api/search`;

    const res = await fetch(`${endpoint}?${params}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      youCircuit.recordFailure();
      return `[You.com search failed: ${res.status}]`;
    }

    youCircuit.recordSuccess();

    const data = await res.json() as {
      hits?: YouSearchResult[];
      news?: Array<{ title: string; url: string; description: string }>;
    };

    const results = data.hits ?? data.news ?? [];
    if (results.length === 0) return '[No results found]';

    return results
      .map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description || r.snippets?.[0] || ''}`)
      .join('\n\n');
  } catch (e) {
    youCircuit.recordFailure();
    return `[You.com search error: ${e instanceof Error ? e.message : 'unknown'}]`;
  }
}

/**
 * Deep research with synthesized, citation-backed answers.
 * This is the killer feature — it does multi-step research and returns
 * a synthesized answer with inline citations.
 *
 * Effort levels: lite (fast) → standard → deep → exhaustive (thorough)
 */
export async function youResearch(query: string, options?: {
  effort?: 'lite' | 'standard' | 'deep' | 'exhaustive';
}): Promise<{ answer: string; citations: Array<{ url: string; title: string }> }> {
  const effort = options?.effort ?? 'deep';

  if (!youCircuit.canExecute()) {
    return { answer: `[You.com circuit open — service temporarily unavailable]`, citations: [] };
  }

  try {
    const res = await fetch(`${YOU_API_BASE}/api/research`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ query, effort }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      youCircuit.recordFailure();
      return { answer: `[You.com research failed: ${res.status}]`, citations: [] };
    }

    youCircuit.recordSuccess();

    const data = await res.json() as {
      answer?: string;
      search_results?: Array<{ url: string; title: string; snippets?: string[] }>;
      citations?: Array<{ url: string; title: string }>;
    };

    const citations = data.citations ?? data.search_results?.map(r => ({
      url: r.url, title: r.title,
    })) ?? [];

    return {
      answer: data.answer ?? '[No answer generated]',
      citations,
    };
  } catch (e) {
    youCircuit.recordFailure();
    return {
      answer: `[You.com research error: ${e instanceof Error ? e.message : 'unknown'}]`,
      citations: [],
    };
  }
}

/**
 * Extract full page content from URL as markdown.
 * Backup/complement to Crawl4AI for when headless browser isn't needed.
 */
export async function youContents(url: string): Promise<string> {
  try {
    const params = new URLSearchParams({ url, format: 'markdown' });
    const res = await fetch(`${YOU_API_BASE}/api/contents?${params}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return `[You.com contents failed: ${res.status}]`;

    const data = await res.json() as { content?: string; markdown?: string };
    return data.content ?? data.markdown ?? '[No content extracted]';
  } catch (e) {
    return `[You.com contents error: ${e instanceof Error ? e.message : 'unknown'}]`;
  }
}
