/**
 * Web search via Brave Search API. Set BRAVE_API_KEY env var.
 * Falls back to a no-op if no key is set.
 */
export async function webSearch(query: string): Promise<string> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    return `[No BRAVE_API_KEY set. Search query: "${query}"]`;
  }

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
  });

  if (!res.ok) return `[Search failed: ${res.status}]`;

  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };

  const results = data.web?.results ?? [];
  if (results.length === 0) return '[No results found]';

  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
    .join('\n\n');
}

export async function webFetch(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'newsroom/0.1 (research tool)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return `[Fetch failed: ${res.status}]`;
    const text = await res.text();
    // Rough HTML to text: strip tags, collapse whitespace
    const clean = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Truncate to ~4000 chars to save tokens
    return clean.slice(0, 4000);
  } catch (e) {
    return `[Fetch error: ${e instanceof Error ? e.message : 'unknown'}]`;
  }
}
