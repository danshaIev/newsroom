import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from '../utils/fs.js';

/**
 * Token/credit optimizer — tracks usage across all services
 * and enforces budgets to prevent overspend.
 *
 * Services tracked:
 * - Claude API (Anthropic) — per-token billing
 * - You.com — credit-based, 100 complimentary credits
 * - Brave Search — per-query
 * - Crawl4AI — free/local, but track for performance
 */

export interface ServiceUsage {
  service: string;
  calls: number;
  tokensOrCredits: number;
  cacheHits: number;
  lastUsed: string;
}

export interface UsageBudget {
  service: string;
  /** Max tokens/credits/calls allowed */
  limit: number;
  /** What we're measuring: 'tokens' | 'credits' | 'calls' */
  unit: 'tokens' | 'credits' | 'calls';
  /** Warn at this percentage */
  warnAt: number;
}

export interface OptimizationRule {
  name: string;
  condition: string;
  action: string;
  savings: string;
}

/**
 * Tracks usage across all API services, enforces budgets,
 * and applies optimization rules to minimize spend.
 */
export class TokenOptimizer {
  private usage: Map<string, ServiceUsage> = new Map();
  private budgets: Map<string, UsageBudget> = new Map();
  private dir: string;
  private sessionStart: string;

  /** Optimization rules — applied automatically */
  private rules: OptimizationRule[] = [
    {
      name: 'Cache-first',
      condition: 'Before any API call',
      action: 'Check FetchCache. Skip API call if cached result exists.',
      savings: '30-60% of search/fetch calls',
    },
    {
      name: 'You.com research throttle',
      condition: 'deep_research effort=exhaustive',
      action: 'Downgrade to effort=deep if budget < 50%. Downgrade to standard if < 25%.',
      savings: '2-5x credits per research call',
    },
    {
      name: 'Crawl4AI over You.com contents',
      condition: 'URL content extraction needed',
      action: 'Use Crawl4AI (free, local) instead of you-contents. Fall back to You.com only if Crawl4AI fails.',
      savings: '1 You.com credit per URL',
    },
    {
      name: 'Brave fallback',
      condition: 'You.com search budget depleted',
      action: 'Fall back to Brave Search API for basic web queries.',
      savings: 'Preserves You.com credits for deep_research',
    },
    {
      name: 'Dedup before search',
      condition: 'Before web_search or you_search',
      action: 'check_knowledge first. Skip search if claim already exists at STRONG+ grade.',
      savings: '15-25% of search calls',
    },
    {
      name: 'Batch compose',
      condition: 'Multiple output formats requested',
      action: 'Share the intelligence brief across formats. Only the formatting call differs.',
      savings: '40% of compose tokens',
    },
  ];

  constructor(projectDir: string) {
    this.dir = join(projectDir, '.newsroom', 'usage');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.sessionStart = new Date().toISOString();
    this.load();
    this.initBudgets();
  }

  private load() {
    const path = join(this.dir, 'usage.json');
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, 'utf-8')) as ServiceUsage[];
    for (const u of data) this.usage.set(u.service, u);
  }

  private persist() {
    atomicWriteFileSync(
      join(this.dir, 'usage.json'),
      JSON.stringify([...this.usage.values()], null, 2),
    );
  }

  private initBudgets() {
    // Default budgets — user can override
    if (!this.budgets.has('youcom')) {
      this.budgets.set('youcom', {
        service: 'youcom',
        limit: 100, // complimentary credits
        unit: 'credits',
        warnAt: 0.7,
      });
    }
    if (!this.budgets.has('claude')) {
      this.budgets.set('claude', {
        service: 'claude',
        limit: 5_000_000, // ~$15 worth at Sonnet rates
        unit: 'tokens',
        warnAt: 0.8,
      });
    }
    if (!this.budgets.has('brave')) {
      this.budgets.set('brave', {
        service: 'brave',
        limit: 2000, // free tier monthly
        unit: 'calls',
        warnAt: 0.8,
      });
    }
  }

  /** Record a service call */
  track(service: string, amount: number, wasCacheHit = false) {
    const existing = this.usage.get(service) ?? {
      service, calls: 0, tokensOrCredits: 0, cacheHits: 0, lastUsed: '',
    };
    existing.calls++;
    if (wasCacheHit) {
      existing.cacheHits++;
    } else {
      existing.tokensOrCredits += amount;
    }
    existing.lastUsed = new Date().toISOString();
    this.usage.set(service, existing);
    this.persist();

    // Check budget warnings
    this.checkBudget(service);
  }

  /** Check if we should use a service or fall back */
  shouldUse(service: string): { ok: boolean; fallback?: string; reason?: string } {
    const budget = this.budgets.get(service);
    const usage = this.usage.get(service);
    if (!budget || !usage) return { ok: true };

    const pctUsed = usage.tokensOrCredits / budget.limit;

    if (pctUsed >= 1) {
      return {
        ok: false,
        fallback: this.getFallback(service),
        reason: `${service} budget exhausted (${usage.tokensOrCredits}/${budget.limit} ${budget.unit})`,
      };
    }

    if (pctUsed >= 0.9) {
      return {
        ok: true,
        reason: `${service} at ${Math.round(pctUsed * 100)}% — conserve usage`,
      };
    }

    return { ok: true };
  }

  /** Get recommended effort level based on remaining budget */
  recommendedEffort(service: string): 'lite' | 'standard' | 'deep' | 'exhaustive' {
    const budget = this.budgets.get(service);
    const usage = this.usage.get(service);
    if (!budget || !usage) return 'deep';

    const pctRemaining = 1 - (usage.tokensOrCredits / budget.limit);
    if (pctRemaining > 0.5) return 'exhaustive';
    if (pctRemaining > 0.25) return 'deep';
    if (pctRemaining > 0.1) return 'standard';
    return 'lite';
  }

  private getFallback(service: string): string | undefined {
    const fallbacks: Record<string, string> = {
      'youcom': 'brave',
      'brave': 'youcom',
    };
    return fallbacks[service];
  }

  private checkBudget(service: string) {
    const budget = this.budgets.get(service);
    const usage = this.usage.get(service);
    if (!budget || !usage) return;

    const pct = usage.tokensOrCredits / budget.limit;
    if (pct >= budget.warnAt && pct < budget.warnAt + 0.05) {
      console.warn(`⚠️  ${service}: ${Math.round(pct * 100)}% of budget used (${usage.tokensOrCredits}/${budget.limit} ${budget.unit})`);
    }
    if (pct >= 0.95) {
      console.warn(`🔴 ${service}: CRITICAL — ${Math.round(pct * 100)}% of budget used. Switching to fallbacks.`);
    }
  }

  /** Update a budget limit */
  setBudget(service: string, limit: number, unit: 'tokens' | 'credits' | 'calls') {
    this.budgets.set(service, { service, limit, unit, warnAt: 0.7 });
  }

  /** Full usage report */
  report(): string {
    const lines: string[] = ['# Usage Report\n'];

    for (const [service, usage] of this.usage) {
      const budget = this.budgets.get(service);
      const pct = budget ? Math.round((usage.tokensOrCredits / budget.limit) * 100) : 0;
      const bar = budget ? this.progressBar(pct) : '';

      lines.push(`## ${service}`);
      lines.push(`  Calls: ${usage.calls} (${usage.cacheHits} cache hits, ${usage.calls > 0 ? Math.round(usage.cacheHits / usage.calls * 100) : 0}% hit rate)`);
      lines.push(`  Used: ${usage.tokensOrCredits.toLocaleString()}${budget ? ` / ${budget.limit.toLocaleString()} ${budget.unit}` : ''}`);
      if (bar) lines.push(`  Budget: ${bar} ${pct}%`);
      lines.push('');
    }

    // Optimization recommendations
    lines.push('## Active Optimizations');
    for (const rule of this.rules) {
      lines.push(`  - **${rule.name}**: ${rule.action} (saves ${rule.savings})`);
    }

    return lines.join('\n');
  }

  /** Compact one-liner for CLI output */
  compactReport(): string {
    return [...this.usage.values()]
      .map(u => {
        const budget = this.budgets.get(u.service);
        const pct = budget ? `${Math.round(u.tokensOrCredits / budget.limit * 100)}%` : '';
        return `${u.service}: ${u.tokensOrCredits.toLocaleString()}${budget ? `/${budget.limit.toLocaleString()}` : ''} ${pct} (${u.cacheHits} cached)`;
      })
      .join(' | ');
  }

  private progressBar(pct: number): string {
    const filled = Math.round(pct / 5);
    const empty = 20 - filled;
    const color = pct > 90 ? '🔴' : pct > 70 ? '🟡' : '🟢';
    return `${color} [${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
  }
}
