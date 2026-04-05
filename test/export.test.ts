import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { KnowledgeStore } from '../src/knowledge/store.js';
import { exportCsv } from '../src/report/export.js';
import type { Finding } from '../src/knowledge/schema.js';

const TEST_DIR = join(process.cwd(), '.test-export-tmp');

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'F001',
    claim: 'Test claim with, commas and "quotes"',
    evidence: 'STRONG',
    impact: 'HIGH',
    sources: [{ url: 'https://example.com', title: 'Example', accessed: new Date().toISOString(), grade: 'A' }],
    agent: 'finint',
    wave: 1,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    staleAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    tags: ['finance'],
    relatedFindings: [],
    ...overrides,
  };
}

describe('CSV Export', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, '.newsroom', 'knowledge'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('exports findings with headers', () => {
    const store = new KnowledgeStore(TEST_DIR);
    store.addFinding(makeFinding());
    const csv = exportCsv(store, 'findings');
    const lines = csv.split('\n');
    expect(lines[0]).toContain('id,claim,evidence');
    expect(lines).toHaveLength(2);
  });

  it('escapes commas and quotes in CSV', () => {
    const store = new KnowledgeStore(TEST_DIR);
    store.addFinding(makeFinding({ claim: 'Has "quotes" and, commas' }));
    const csv = exportCsv(store, 'findings');
    expect(csv).toContain('"Has ""quotes"" and, commas"');
  });

  it('includes verdict and redteam badges', () => {
    const store = new KnowledgeStore(TEST_DIR);
    store.addFinding(makeFinding());
    store.addVerdict({
      id: 'V001', findingId: 'F001', rating: 'CONFIRMED', confidence: 0.95,
      atomicClaims: [], confirmingSources: [], counterEvidence: [],
      verificationNotes: [], agent: 'factcheck', created: new Date().toISOString(),
    });
    const csv = exportCsv(store, 'findings');
    expect(csv).toContain('CONFIRMED');
  });

  it('exports empty store gracefully', () => {
    const store = new KnowledgeStore(TEST_DIR);
    const csv = exportCsv(store, 'findings');
    const lines = csv.split('\n');
    expect(lines).toHaveLength(1); // Just the header
  });

  it('exports all types', () => {
    const store = new KnowledgeStore(TEST_DIR);
    store.addFinding(makeFinding());
    const csv = exportCsv(store, 'all');
    expect(csv).toContain('# FINDINGS');
    expect(csv).toContain('# ENTITIES');
    expect(csv).toContain('# RELATIONSHIPS');
    expect(csv).toContain('# VERDICTS');
  });
});
