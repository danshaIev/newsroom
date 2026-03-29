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

export type KnowledgeEntry =
  | { type: 'finding'; data: Finding }
  | { type: 'entity'; data: Entity }
  | { type: 'relationship'; data: Relationship };

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
