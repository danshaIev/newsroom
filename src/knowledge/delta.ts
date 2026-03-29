import type { KnowledgeStore } from './store.js';
import type { ResearchQuestion, Finding } from './schema.js';

/**
 * Computes what we DON'T know yet — the research delta.
 * Agents should only research gaps, never re-research known facts.
 */
export class DeltaComputer {
  constructor(private store: KnowledgeStore) {}

  /** Given research questions, return only those not already answered at sufficient grade */
  computeGaps(questions: ResearchQuestion[]): ResearchQuestion[] {
    const findings = this.store.allFindings();
    return questions.filter(q => {
      const covered = findings.some(f =>
        this.coversQuestion(f, q) && this.isStrongEnough(f)
      );
      return !covered;
    });
  }

  /** Check if a claim already exists in the store */
  claimExists(claim: string): Finding | undefined {
    return this.store.allFindings().find(f =>
      this.similarity(f.claim, claim) > 0.7
    );
  }

  /** What topics have no findings at all? */
  uncoveredTags(allTags: string[]): string[] {
    const findings = this.store.allFindings();
    const coveredTags = new Set(findings.flatMap(f => f.tags));
    return allTags.filter(t => !coveredTags.has(t));
  }

  /** What findings are stale and need re-verification? */
  staleItems(): Finding[] {
    return this.store.staleFindings();
  }

  private coversQuestion(finding: Finding, question: ResearchQuestion): boolean {
    return this.similarity(finding.claim, question.question) > 0.5 ||
      question.existingFindings.includes(finding.id);
  }

  private isStrongEnough(finding: Finding): boolean {
    return finding.evidence === 'BULLETPROOF' || finding.evidence === 'STRONG';
  }

  private similarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    return intersection.size / Math.max(wordsA.size, wordsB.size);
  }
}
