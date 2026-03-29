import type { KnowledgeStore } from '../knowledge/store.js';
import type { Finding } from '../knowledge/schema.js';

export type ContextLevel = 0 | 1 | 2;

/**
 * Tiered context builder. Agents get the minimum context needed.
 * L0: ~500 tokens (summary stats + top findings)
 * L1: ~2000 tokens (all findings as compact list)
 * L2: Full evidence chains (only for specific findings)
 */
export class ContextBuilder {
  constructor(private store: KnowledgeStore) {}

  build(level: ContextLevel, options?: { tags?: string[]; findingIds?: string[] }): string {
    switch (level) {
      case 0: return this.store.summary();
      case 1: return this.buildL1(options?.tags);
      case 2: return this.buildL2(options?.findingIds ?? []);
    }
  }

  private buildL1(tags?: string[]): string {
    const findings = this.store.findingsList(tags ? { tags } : undefined);
    if (findings.length === 0) return 'No findings yet.';
    return findings
      .map(f => `[${f.id}] [${f.evidence}] ${f.claim} (${f.sources.length} sources, ${f.tags.join(',')})`)
      .join('\n');
  }

  private buildL2(ids: string[]): string {
    return ids.map(id => {
      const f = this.store.getFinding(id);
      if (!f) return `[${id}] NOT FOUND`;
      return this.formatFullFinding(f);
    }).join('\n\n---\n\n');
  }

  private formatFullFinding(f: Finding): string {
    const sources = f.sources
      .map(s => `  - [${s.grade}] ${s.title}: ${s.url} (${s.accessed})`)
      .join('\n');
    return `## ${f.id}: ${f.claim}
Evidence: ${f.evidence} | Impact: ${f.impact} | Agent: ${f.agent} | Wave: ${f.wave}
Tags: ${f.tags.join(', ')}
Sources:
${sources}
${f.redTeam ? `Red Team: ${f.redTeam}` : ''}
Related: ${f.relatedFindings.join(', ')}`;
  }

  /** Estimate token count (rough: 1 token ≈ 4 chars) */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
