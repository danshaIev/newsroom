import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Finding } from '../knowledge/schema.js';
import { extractDomain } from '../utils/similarity.js';
import { atomicWriteFileSync } from '../utils/fs.js';

interface Pattern {
  category: 'source_reliability' | 'search_strategy' | 'cross_reference' | 'subject_specific';
  observation: string;
  confidence: number;
  wave: number;
}

/**
 * ML-first: Extracts patterns from completed waves.
 * patterns.md improves across waves — agents get smarter over time.
 */
export class PatternLearner {
  private patterns: Pattern[] = [];
  private patternsPath: string;
  private rawPath: string;

  constructor(projectDir: string) {
    this.patternsPath = join(projectDir, '.newsroom', 'patterns.md');
    this.rawPath = join(projectDir, '.newsroom', 'patterns.jsonl');
    this.load();
  }

  private load() {
    if (!existsSync(this.rawPath)) return;
    this.patterns = readFileSync(this.rawPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
  }

  /** Extract patterns from a completed wave's findings */
  learn(findings: Finding[], wave: number) {
    const newPatterns: Pattern[] = [];

    // Source reliability: which sources produced high-grade findings?
    const sourceGrades = new Map<string, { a: number; b: number; c: number }>();
    for (const f of findings) {
      for (const s of f.sources) {
        const domain = extractDomain(s.url);
        const counts = sourceGrades.get(domain) ?? { a: 0, b: 0, c: 0 };
        if (s.grade === 'A') counts.a++;
        else if (s.grade === 'B') counts.b++;
        else counts.c++;
        sourceGrades.set(domain, counts);
      }
    }
    for (const [domain, counts] of sourceGrades) {
      if (counts.a >= 2) {
        newPatterns.push({
          category: 'source_reliability',
          observation: `${domain}: highly reliable (${counts.a} Grade-A sources this wave)`,
          confidence: Math.min(1, counts.a / 5),
          wave,
        });
      }
    }

    // Cross-reference patterns: which tag combinations produced findings?
    const tagPairs = new Map<string, number>();
    for (const f of findings) {
      if (f.evidence === 'BULLETPROOF' || f.evidence === 'STRONG') {
        for (let i = 0; i < f.tags.length; i++) {
          for (let j = i + 1; j < f.tags.length; j++) {
            const pair = [f.tags[i], f.tags[j]].sort().join('+');
            tagPairs.set(pair, (tagPairs.get(pair) ?? 0) + 1);
          }
        }
      }
    }
    for (const [pair, count] of tagPairs) {
      if (count >= 2) {
        newPatterns.push({
          category: 'cross_reference',
          observation: `Cross-referencing ${pair.replace('+', ' and ')} yielded ${count} strong+ findings`,
          confidence: Math.min(1, count / 4),
          wave,
        });
      }
    }

    // Subject-specific: high-impact findings become observations
    for (const f of findings) {
      if (f.evidence === 'BULLETPROOF' && f.impact === 'CRITICAL') {
        newPatterns.push({
          category: 'subject_specific',
          observation: `Key finding: ${f.claim}`,
          confidence: 1,
          wave,
        });
      }
    }

    this.patterns.push(...newPatterns);
    this.persist();
  }

  /** Generate compressed digest for agent context (~500 tokens) */
  digest(agentType?: string): string {
    const grouped = {
      source_reliability: this.patterns.filter(p => p.category === 'source_reliability'),
      search_strategy: this.patterns.filter(p => p.category === 'search_strategy'),
      cross_reference: this.patterns.filter(p => p.category === 'cross_reference'),
      subject_specific: this.patterns.filter(p => p.category === 'subject_specific'),
    };

    const sections: string[] = ['# Research Patterns (learned from prior waves)\n'];

    if (grouped.source_reliability.length > 0) {
      sections.push('## Reliable Sources');
      sections.push(...this.topN(grouped.source_reliability, 10).map(p => `- ${p.observation}`));
    }

    if (grouped.search_strategy.length > 0) {
      sections.push('\n## Effective Strategies');
      sections.push(...this.topN(grouped.search_strategy, 5).map(p => `- ${p.observation}`));
    }

    if (grouped.cross_reference.length > 0) {
      sections.push('\n## Productive Cross-References');
      sections.push(...this.topN(grouped.cross_reference, 5).map(p => `- ${p.observation}`));
    }

    if (grouped.subject_specific.length > 0) {
      sections.push('\n## Key Subject Observations');
      sections.push(...this.topN(grouped.subject_specific, 10).map(p => `- ${p.observation}`));
    }

    return sections.join('\n');
  }

  private topN(patterns: Pattern[], n: number): Pattern[] {
    return patterns
      .sort((a, b) => b.confidence - a.confidence || b.wave - a.wave)
      .slice(0, n);
  }

  private persist() {
    atomicWriteFileSync(this.rawPath, this.patterns.map(p => JSON.stringify(p)).join('\n') + '\n');
    atomicWriteFileSync(this.patternsPath, this.digest());
  }
}
