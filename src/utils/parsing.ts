import type { Finding, Source } from '../knowledge/schema.js';
import { safeJsonExtract } from '../tools/security.js';

/**
 * Shared finding parser. Extracts structured findings from LLM text output.
 * Used by both AgentExecutor and BaseAgent.
 */
export function parseFindings(
  text: string,
  opts: { agentType: string; wave: number; nextId: () => string },
): Finding[] {
  try {
    const jsonMatch = safeJsonExtract(text, 'array');
    if (!jsonMatch) return [];
    const raw = JSON.parse(jsonMatch) as Array<{
      claim: string;
      evidence?: string;
      impact?: string;
      sources?: Array<{ url: string; title?: string; grade?: string }>;
      tags?: string[];
      redTeam?: string;
    }>;

    return raw.map(r => ({
      id: opts.nextId(),
      claim: r.claim,
      evidence: (r.evidence || 'DEVELOPING') as Finding['evidence'],
      impact: (r.impact || 'MODERATE') as Finding['impact'],
      sources: (r.sources || []).map(s => ({
        url: s.url,
        title: s.title || '',
        accessed: new Date().toISOString(),
        grade: (s.grade || 'B') as Source['grade'],
      })),
      agent: opts.agentType,
      wave: opts.wave,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      staleAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      tags: r.tags || [],
      relatedFindings: [],
      redTeam: r.redTeam,
    }));
  } catch {
    return [];
  }
}
