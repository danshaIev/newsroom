import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Finding, Entity, Relationship, KnowledgeEntry, EvidenceGrade } from './schema.js';

export class KnowledgeStore {
  private dir: string;
  private findingsPath: string;
  private entitiesPath: string;
  private relationsPath: string;
  private indexPath: string;

  private findings: Map<string, Finding> = new Map();
  private entities: Map<string, Entity> = new Map();
  private relationships: Map<string, Relationship> = new Map();

  constructor(projectDir: string) {
    this.dir = join(projectDir, '.newsroom', 'knowledge');
    this.findingsPath = join(this.dir, 'findings.jsonl');
    this.entitiesPath = join(this.dir, 'entities.jsonl');
    this.relationsPath = join(this.dir, 'relationships.jsonl');
    this.indexPath = join(this.dir, 'index.json');

    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  private load() {
    this.findings = this.loadJsonl(this.findingsPath);
    this.entities = this.loadJsonl(this.entitiesPath);
    this.relationships = this.loadJsonl(this.relationsPath);
  }

  private loadJsonl<T extends { id: string }>(path: string): Map<string, T> {
    const map = new Map<string, T>();
    if (!existsSync(path)) return map;
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      const item = JSON.parse(line) as T;
      map.set(item.id, item);
    }
    return map;
  }

  private append(path: string, data: unknown) {
    appendFileSync(path, JSON.stringify(data) + '\n');
  }

  addFinding(finding: Finding): boolean {
    const existing = this.findDuplicate(finding);
    if (existing) {
      if (this.shouldUpgrade(existing, finding)) {
        existing.evidence = finding.evidence;
        existing.sources.push(...finding.sources);
        existing.updated = new Date().toISOString();
        existing.relatedFindings.push(...finding.relatedFindings);
        this.rebuild();
        return true;
      }
      return false;
    }
    this.findings.set(finding.id, finding);
    this.append(this.findingsPath, finding);
    return true;
  }

  addEntity(entity: Entity) {
    if (this.entities.has(entity.id)) return false;
    this.entities.set(entity.id, entity);
    this.append(this.entitiesPath, entity);
    return true;
  }

  addRelationship(rel: Relationship) {
    this.relationships.set(rel.id, rel);
    this.append(this.relationsPath, rel);
    return true;
  }

  private findDuplicate(finding: Finding): Finding | undefined {
    for (const existing of this.findings.values()) {
      if (this.claimSimilarity(existing.claim, finding.claim) > 0.8) {
        return existing;
      }
    }
    return undefined;
  }

  private claimSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    return intersection.size / Math.max(wordsA.size, wordsB.size);
  }

  private shouldUpgrade(existing: Finding, incoming: Finding): boolean {
    const grades: EvidenceGrade[] = ['DEVELOPING', 'CIRCUMSTANTIAL', 'STRONG', 'BULLETPROOF'];
    return grades.indexOf(incoming.evidence) > grades.indexOf(existing.evidence);
  }

  private rebuild() {
    writeFileSync(this.findingsPath, [...this.findings.values()].map(f => JSON.stringify(f)).join('\n') + '\n');
  }

  /** L0 summary: ~500 tokens. Used as default agent context. */
  summary(): string {
    const stats = {
      findings: this.findings.size,
      entities: this.entities.size,
      relationships: this.relationships.size,
      bulletproof: [...this.findings.values()].filter(f => f.evidence === 'BULLETPROOF').length,
      strong: [...this.findings.values()].filter(f => f.evidence === 'STRONG').length,
    };
    const topFindings = [...this.findings.values()]
      .sort((a, b) => {
        const grades: EvidenceGrade[] = ['DEVELOPING', 'CIRCUMSTANTIAL', 'STRONG', 'BULLETPROOF'];
        return grades.indexOf(b.evidence) - grades.indexOf(a.evidence);
      })
      .slice(0, 10)
      .map(f => `- [${f.evidence}] ${f.claim}`)
      .join('\n');

    return `# Knowledge Store Summary
Findings: ${stats.findings} (${stats.bulletproof} bulletproof, ${stats.strong} strong)
Entities: ${stats.entities} | Relationships: ${stats.relationships}

## Top Findings
${topFindings}`;
  }

  /** L1: Key findings list with sources. ~2000 tokens. */
  findingsList(filter?: { agent?: string; grade?: EvidenceGrade; tags?: string[] }): Finding[] {
    let results = [...this.findings.values()];
    if (filter?.agent) results = results.filter(f => f.agent === filter.agent);
    if (filter?.grade) results = results.filter(f => f.evidence === filter.grade);
    if (filter?.tags) results = results.filter(f => filter.tags!.some(t => f.tags.includes(t)));
    return results;
  }

  /** L2: Full evidence chain for a specific finding. */
  getFinding(id: string): Finding | undefined {
    return this.findings.get(id);
  }

  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  allFindings(): Finding[] {
    return [...this.findings.values()];
  }

  allEntities(): Entity[] {
    return [...this.entities.values()];
  }

  allRelationships(): Relationship[] {
    return [...this.relationships.values()];
  }

  /** Check what's stale and needs re-verification */
  staleFindings(): Finding[] {
    const now = new Date();
    return [...this.findings.values()].filter(f => new Date(f.staleAfter) < now);
  }

  /** Generate next finding ID */
  nextFindingId(): string {
    return `F${String(this.findings.size + 1).padStart(3, '0')}`;
  }

  nextEntityId(): string {
    return `E${String(this.entities.size + 1).padStart(3, '0')}`;
  }

  nextRelationshipId(): string {
    return `R${String(this.relationships.size + 1).padStart(3, '0')}`;
  }

  /** Write materialized index for fast lookups */
  writeIndex() {
    const index = {
      findings: Object.fromEntries(
        [...this.findings.entries()].map(([id, f]) => [id, { claim: f.claim, evidence: f.evidence, tags: f.tags }])
      ),
      entities: Object.fromEntries(
        [...this.entities.entries()].map(([id, e]) => [id, { name: e.name, type: e.type }])
      ),
      updated: new Date().toISOString(),
    };
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
  }
}
