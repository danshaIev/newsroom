import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { KnowledgeStore } from '../src/knowledge/store.js';
import type { Finding, Source } from '../src/knowledge/schema.js';

const TEST_DIR = join(process.cwd(), '.test-knowledge-tmp');

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'F001',
    claim: 'Senator Smith received $50,000 in campaign contributions from Big Oil PAC',
    evidence: 'STRONG',
    impact: 'HIGH',
    sources: [{ url: 'https://fec.gov/filing/123', title: 'FEC Filing', accessed: new Date().toISOString(), grade: 'A' as Source['grade'] }],
    agent: 'finint',
    wave: 1,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    staleAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    tags: ['finance', 'campaign'],
    relatedFindings: [],
    ...overrides,
  };
}

describe('KnowledgeStore', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, '.newsroom', 'knowledge'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('adds and retrieves findings', () => {
    const store = new KnowledgeStore(TEST_DIR);
    const finding = makeFinding();
    store.addFinding(finding);
    expect(store.getFinding('F001')).toBeDefined();
    expect(store.allFindings()).toHaveLength(1);
  });

  it('deduplicates findings with >80% word similarity', () => {
    const store = new KnowledgeStore(TEST_DIR);
    store.addFinding(makeFinding({ id: 'F001' }));
    // Nearly identical claim — should be deduplicated
    const dupe = makeFinding({
      id: 'F002',
      claim: 'Senator Smith received $50,000 in large campaign contributions from Big Oil PAC funds',
    });
    const added = store.addFinding(dupe);
    expect(added).toBe(false);
    expect(store.allFindings()).toHaveLength(1);
  });

  it('allows genuinely different findings', () => {
    const store = new KnowledgeStore(TEST_DIR);
    store.addFinding(makeFinding({ id: 'F001' }));
    const different = makeFinding({
      id: 'F002',
      claim: 'Governor Jones signed an executive order banning offshore drilling',
    });
    const added = store.addFinding(different);
    expect(added).toBe(true);
    expect(store.allFindings()).toHaveLength(2);
  });

  it('upgrades evidence grade on duplicate with stronger evidence', () => {
    const store = new KnowledgeStore(TEST_DIR);
    store.addFinding(makeFinding({ id: 'F001', evidence: 'CIRCUMSTANTIAL' }));
    const upgrade = makeFinding({
      id: 'F002',
      evidence: 'BULLETPROOF',
      sources: [{ url: 'https://sec.gov/new', title: 'New Source', accessed: '', grade: 'A' }],
    });
    const added = store.addFinding(upgrade);
    expect(added).toBe(true);
    const f = store.getFinding('F001');
    expect(f?.evidence).toBe('BULLETPROOF');
  });

  it('does NOT downgrade evidence on duplicate with weaker evidence', () => {
    const store = new KnowledgeStore(TEST_DIR);
    store.addFinding(makeFinding({ id: 'F001', evidence: 'STRONG' }));
    const weaker = makeFinding({ id: 'F002', evidence: 'DEVELOPING' });
    const added = store.addFinding(weaker);
    expect(added).toBe(false);
    expect(store.getFinding('F001')?.evidence).toBe('STRONG');
  });

  it('generates sequential finding IDs', () => {
    const store = new KnowledgeStore(TEST_DIR);
    expect(store.nextFindingId()).toBe('F001');
    store.addFinding(makeFinding({ id: 'F001' }));
    expect(store.nextFindingId()).toBe('F002');
  });

  it('persists and reloads from JSONL', () => {
    const store1 = new KnowledgeStore(TEST_DIR);
    store1.addFinding(makeFinding({ id: 'F001' }));
    store1.addFinding(makeFinding({
      id: 'F002',
      claim: 'Completely different claim about different subject',
    }));

    const store2 = new KnowledgeStore(TEST_DIR);
    expect(store2.allFindings()).toHaveLength(2);
  });

  it('produces a summary with stats', () => {
    const store = new KnowledgeStore(TEST_DIR);
    store.addFinding(makeFinding({ id: 'F001', evidence: 'BULLETPROOF' }));
    store.addFinding(makeFinding({
      id: 'F002',
      claim: 'A totally different finding about something else',
      evidence: 'STRONG',
    }));

    const summary = store.summary();
    expect(summary).toContain('Findings: 2');
    expect(summary).toContain('1 bulletproof');
    expect(summary).toContain('1 strong');
  });

  it('writes materialized index', () => {
    const store = new KnowledgeStore(TEST_DIR);
    store.addFinding(makeFinding({ id: 'F001' }));
    store.writeIndex();
    expect(existsSync(join(TEST_DIR, '.newsroom', 'knowledge', 'index.json'))).toBe(true);
  });

  it('indexes verdicts by findingId for O(1) lookup', () => {
    const store = new KnowledgeStore(TEST_DIR);
    store.addFinding(makeFinding({ id: 'F001' }));
    store.addVerdict({
      id: 'V001',
      findingId: 'F001',
      rating: 'CONFIRMED',
      confidence: 0.95,
      atomicClaims: [],
      confirmingSources: [],
      counterEvidence: [],
      verificationNotes: [],
      agent: 'factcheck',
      created: new Date().toISOString(),
    });
    expect(store.getVerdict('F001')).toBeDefined();
    expect(store.getVerdict('F001')?.rating).toBe('CONFIRMED');
    expect(store.getVerdict('F999')).toBeUndefined();
  });

  it('indexes red-team challenges by findingId for O(1) lookup', () => {
    const store = new KnowledgeStore(TEST_DIR);
    store.addFinding(makeFinding({ id: 'F001' }));
    store.addRedTeamChallenge({
      id: 'RT001',
      findingId: 'F001',
      alternativeExplanations: [],
      logicalFallacies: [],
      weakestLink: { description: 'test', recommendation: 'test' },
      survived: true,
      recommendedGrade: 'STRONG',
      agent: 'redteam',
      created: new Date().toISOString(),
    });
    expect(store.getRedTeamChallenge('F001')).toBeDefined();
    expect(store.getRedTeamChallenge('F001')?.survived).toBe(true);
    expect(store.getRedTeamChallenge('F999')).toBeUndefined();
  });

  it('indexes findings by tag for O(1) lookup', () => {
    const store = new KnowledgeStore(TEST_DIR);
    store.addFinding(makeFinding({ id: 'F001', tags: ['finance', 'campaign'] }));
    store.addFinding(makeFinding({
      id: 'F002',
      claim: 'Completely unrelated different finding here',
      tags: ['finance', 'lobby'],
    }));

    const financeFindings = store.findingsByTagIndex('finance');
    expect(financeFindings).toHaveLength(2);

    const lobbyFindings = store.findingsByTagIndex('lobby');
    expect(lobbyFindings).toHaveLength(1);

    const emptyFindings = store.findingsByTagIndex('nonexistent');
    expect(emptyFindings).toHaveLength(0);
  });
});
