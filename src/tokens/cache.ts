import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

interface CacheEntry {
  url: string;
  content: string;
  fetched: string;
  ttlMinutes: number;
}

/**
 * Shared web fetch cache. Same URL fetched once across all agents in a wave.
 * Saves tokens AND API calls.
 */
export class FetchCache {
  private cache: Map<string, CacheEntry> = new Map();
  private dir: string;
  private hits = 0;
  private misses = 0;

  constructor(projectDir: string) {
    this.dir = join(projectDir, '.newsroom', 'cache');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  private keyFor(url: string): string {
    return createHash('md5').update(url).digest('hex');
  }

  private load() {
    const indexPath = join(this.dir, 'index.json');
    if (!existsSync(indexPath)) return;
    const entries: CacheEntry[] = JSON.parse(readFileSync(indexPath, 'utf-8'));
    for (const entry of entries) {
      if (!this.isExpired(entry)) {
        this.cache.set(this.keyFor(entry.url), entry);
      }
    }
  }

  get(url: string): string | undefined {
    const entry = this.cache.get(this.keyFor(url));
    if (entry && !this.isExpired(entry)) {
      this.hits++;
      return entry.content;
    }
    this.misses++;
    return undefined;
  }

  set(url: string, content: string, ttlMinutes = 60) {
    const entry: CacheEntry = { url, content, fetched: new Date().toISOString(), ttlMinutes };
    this.cache.set(this.keyFor(url), entry);
    this.persist();
  }

  private isExpired(entry: CacheEntry): boolean {
    const fetched = new Date(entry.fetched).getTime();
    const now = Date.now();
    return now - fetched > entry.ttlMinutes * 60 * 1000;
  }

  private persist() {
    const entries = [...this.cache.values()];
    writeFileSync(join(this.dir, 'index.json'), JSON.stringify(entries, null, 2));
  }

  stats(): string {
    const total = this.hits + this.misses;
    const rate = total > 0 ? Math.round(this.hits / total * 100) : 0;
    return `Cache: ${this.hits} hits, ${this.misses} misses (${rate}% hit rate)`;
  }
}
