import type { KnowledgeStore } from '../knowledge/store.js';

/**
 * Export knowledge store data to CSV format.
 * Supports findings, entities, verdicts, and red-team challenges.
 */

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function row(values: string[]): string {
  return values.map(escapeCsv).join(',');
}

export function exportFindings(store: KnowledgeStore): string {
  const lines = [
    row(['id', 'claim', 'evidence', 'impact', 'agent', 'wave', 'tags', 'sources', 'created', 'verdict', 'redteam']),
  ];

  for (const f of store.allFindings()) {
    const verdict = store.getVerdict(f.id);
    const rt = store.getRedTeamChallenge(f.id);
    lines.push(row([
      f.id,
      f.claim,
      f.evidence,
      f.impact,
      f.agent,
      String(f.wave),
      f.tags.join('; '),
      f.sources.map(s => s.url).join('; '),
      f.created,
      verdict ? `${verdict.rating} (${Math.round(verdict.confidence * 100)}%)` : '',
      rt ? (rt.survived ? 'SURVIVED' : 'FAILED') : '',
    ]));
  }

  return lines.join('\n');
}

export function exportEntities(store: KnowledgeStore): string {
  const lines = [
    row(['id', 'name', 'type', 'attributes', 'created']),
  ];

  for (const e of store.allEntities()) {
    lines.push(row([
      e.id,
      e.name,
      e.type,
      JSON.stringify(e.attributes),
      e.created,
    ]));
  }

  return lines.join('\n');
}

export function exportRelationships(store: KnowledgeStore): string {
  const lines = [
    row(['id', 'from', 'to', 'type', 'evidence', 'created']),
  ];

  for (const r of store.allRelationships()) {
    lines.push(row([
      r.id,
      r.from,
      r.to,
      r.type,
      r.evidence.join('; '),
      r.created,
    ]));
  }

  return lines.join('\n');
}

export function exportVerdicts(store: KnowledgeStore): string {
  const lines = [
    row(['id', 'findingId', 'rating', 'confidence', 'atomicClaims', 'confirmingSources', 'counterEvidence', 'created']),
  ];

  for (const v of store.allVerdicts()) {
    lines.push(row([
      v.id,
      v.findingId,
      v.rating,
      String(Math.round(v.confidence * 100)),
      `${v.atomicClaims.filter(c => c.verified).length}/${v.atomicClaims.length} verified`,
      String(v.confirmingSources.length),
      `${v.counterEvidence.length} (${v.counterEvidence.filter(c => c.strength === 'strong').length} strong)`,
      v.created,
    ]));
  }

  return lines.join('\n');
}

export type ExportType = 'findings' | 'entities' | 'relationships' | 'verdicts' | 'all';

export function exportCsv(store: KnowledgeStore, type: ExportType): string {
  switch (type) {
    case 'findings': return exportFindings(store);
    case 'entities': return exportEntities(store);
    case 'relationships': return exportRelationships(store);
    case 'verdicts': return exportVerdicts(store);
    case 'all':
      return [
        '# FINDINGS',
        exportFindings(store),
        '',
        '# ENTITIES',
        exportEntities(store),
        '',
        '# RELATIONSHIPS',
        exportRelationships(store),
        '',
        '# VERDICTS',
        exportVerdicts(store),
      ].join('\n');
  }
}
