export type EvidenceGrade = 'BULLETPROOF' | 'STRONG' | 'CIRCUMSTANTIAL' | 'DEVELOPING';
export type ImpactRating = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW';

export interface Source {
  url: string;
  title: string;
  accessed: string;
  grade: 'A' | 'B' | 'C' | 'D';
}

export interface Finding {
  id: string;
  claim: string;
  evidence: EvidenceGrade;
  impact: ImpactRating;
  sources: Source[];
  agent: string;
  wave: number;
  created: string;
  updated: string;
  staleAfter: string;
  tags: string[];
  relatedFindings: string[];
  redTeam?: string;
}

export interface Entity {
  id: string;
  name: string;
  type: 'person' | 'organization' | 'company' | 'government' | 'fund' | 'other';
  attributes: Record<string, string | number | boolean>;
  created: string;
}

export interface Relationship {
  id: string;
  from: string;
  to: string;
  type: string;
  evidence: string[];
  attributes: Record<string, string | number>;
  created: string;
}

/** Fact-check verdict — institutional-grade assessment of a finding */
export type VerdictRating = 'CONFIRMED' | 'MOSTLY_TRUE' | 'MIXED' | 'MOSTLY_FALSE' | 'FALSE' | 'UNVERIFIABLE';

export interface AtomicClaim {
  claim: string;
  verified: boolean;
  sources: Source[];
  counterEvidence?: string;
  notes?: string;
}

export interface Verdict {
  id: string;
  findingId: string;
  rating: VerdictRating;
  confidence: number;
  /** The original claim decomposed into atomic checkable facts */
  atomicClaims: AtomicClaim[];
  /** Independent sources that confirm the finding (not from original) */
  confirmingSources: Source[];
  /** Sources/evidence that contradict the finding */
  counterEvidence: Array<{ claim: string; source: Source; strength: 'strong' | 'moderate' | 'weak' }>;
  /** Was the claim true but misleading in context? */
  contextualAnalysis?: string;
  /** Timeline/number verification notes */
  verificationNotes: string[];
  /** Who issued this verdict */
  agent: string;
  created: string;
}

/** Red-team challenge — adversarial stress test of a finding */
export interface RedTeamChallenge {
  id: string;
  findingId: string;
  /** Alternative explanations for the evidence */
  alternativeExplanations: Array<{ explanation: string; plausibility: 'high' | 'medium' | 'low' }>;
  /** Logical fallacies detected in the reasoning */
  logicalFallacies: Array<{ fallacy: string; description: string }>;
  /** Bias in source selection */
  sourceBias?: string;
  /** The weakest link in the evidence chain */
  weakestLink: { description: string; recommendation: string };
  /** Overall survivability — did the finding survive red-teaming? */
  survived: boolean;
  /** Recommended evidence grade after red-teaming */
  recommendedGrade: EvidenceGrade;
  agent: string;
  created: string;
}

export type KnowledgeEntry =
  | { type: 'finding'; data: Finding }
  | { type: 'entity'; data: Entity }
  | { type: 'relationship'; data: Relationship }
  | { type: 'verdict'; data: Verdict }
  | { type: 'redteam'; data: RedTeamChallenge };

export interface ResearchQuestion {
  question: string;
  priority: number;
  existingFindings: string[];
  gap: string;
}

export interface WaveSummary {
  wave: number;
  findingsAdded: number;
  entitiesAdded: number;
  tokensUsed: number;
  topFindings: string[];
  timestamp: string;
}
