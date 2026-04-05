import { validateUrl } from './security.js';
import { circuits, CircuitOpenError } from '../utils/circuit-breaker.js';

const braveCircuit = circuits.get('brave');
const fetchCircuit = circuits.get('web-fetch');

/**
 * Web search via Brave Search API. Set BRAVE_API_KEY env var.
 * Falls back to a no-op if no key is set.
 */
export async function webSearch(query: string): Promise<string> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    return `[No BRAVE_API_KEY set. Search query: "${query}"]`;
  }

  if (!braveCircuit.canExecute()) {
    return `[Brave Search circuit open — service temporarily unavailable]`;
  }

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
    const res = await fetch(url, {
      headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      braveCircuit.recordFailure();
      return `[Search failed: ${res.status}]`;
    }

    braveCircuit.recordSuccess();

    const data = (await res.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string }> };
    };

    const results = data.web?.results ?? [];
    if (results.length === 0) return '[No results found]';

    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
      .join('\n\n');
  } catch (e) {
    braveCircuit.recordFailure();
    return `[Search error: ${e instanceof Error ? e.message : 'unknown'}]`;
  }
}

export async function webFetch(url: string): Promise<string> {
  const urlCheck = validateUrl(url);
  if (!urlCheck.ok) return `[Blocked: ${urlCheck.reason}]`;

  if (!fetchCircuit.canExecute()) {
    return `[Web fetch circuit open — service temporarily unavailable]`;
  }

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'newsroom/0.2 (research tool)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      if (res.status >= 500) fetchCircuit.recordFailure();
      return `[Fetch failed: ${res.status}]`;
    }
    fetchCircuit.recordSuccess();
    const text = await res.text();
    const clean = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return clean.slice(0, 4000);
  } catch (e) {
    fetchCircuit.recordFailure();
    return `[Fetch error: ${e instanceof Error ? e.message : 'unknown'}]`;
  }
}
