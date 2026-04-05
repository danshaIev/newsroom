import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { SkillEngine } from '../src/learning/skills.js';
import type { Finding } from '../src/knowledge/schema.js';

const TEST_DIR = join(process.cwd(), '.test-skills-tmp');

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'F001',
    claim: 'Test claim',
    evidence: 'STRONG',
    impact: 'HIGH',
    sources: [{ url: 'https://example.com', title: 'Example', accessed: new Date().toISOString(), grade: 'A' }],
    agent: 'finint',
    wave: 1,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    staleAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    tags: ['finance', 'trading'],
    relatedFindings: [],
    ...overrides,
  };
}

describe('SkillEngine', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, '.newsroom', 'profiles'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('creates a default profile for unknown agents', () => {
    const engine = new SkillEngine(TEST_DIR);
    const profile = engine.getProfile('finint');
    expect(profile.agent).toBe('finint');
    expect(profile.totalInvestigations).toBe(0);
    expect(profile.skills).toEqual([]);
  });

  it('learns from findings and updates profile stats', () => {
    const engine = new SkillEngine(TEST_DIR);
    const findings = [makeFinding(), makeFinding({ id: 'F002', evidence: 'BULLETPROOF' })];
    engine.learn('finint', findings, 5000, 1);

    const profile = engine.getProfile('finint');
    expect(profile.totalInvestigations).toBe(1);
    expect(profile.totalFindings).toBe(2);
    expect(profile.strongFindings).toBe(2);
    expect(profile.findingsPerKToken).toBeGreaterThan(0);
  });

  it('develops skills from strong findings with shared sources', () => {
    const engine = new SkillEngine(TEST_DIR);
    const findings = [
      makeFinding({ id: 'F001', sources: [
        { url: 'https://sec.gov/filing1', title: 'Filing 1', accessed: '', grade: 'A' },
        { url: 'https://fec.gov/data1', title: 'Data 1', accessed: '', grade: 'A' },
      ]}),
      makeFinding({ id: 'F002', sources: [
        { url: 'https://sec.gov/filing2', title: 'Filing 2', accessed: '', grade: 'A' },
        { url: 'https://fec.gov/data2', title: 'Data 2', accessed: '', grade: 'A' },
      ]}),
    ];
    engine.learn('finint', findings, 5000, 1);

    const profile = engine.getProfile('finint');
    const crossRefSkill = profile.skills.find(s => s.name.includes('Cross-reference'));
    expect(crossRefSkill).toBeDefined();
  });

  it('confidence starts at 0.3 for new skills', () => {
    const engine = new SkillEngine(TEST_DIR);
    const findings = [
      makeFinding({ id: 'F001', tags: ['finance'] }),
      makeFinding({ id: 'F002', tags: ['finance'] }),
    ];
    engine.learn('finint', findings, 5000, 1);

    const profile = engine.getProfile('finint');
    const newSkills = profile.skills.filter(s => s.uses === 1);
    for (const skill of newSkills) {
      expect(skill.confidence).toBe(0.3);
    }
  });

  it('confidence grows with repeated success', () => {
    const engine = new SkillEngine(TEST_DIR);
    // Run multiple waves with successful findings
    for (let wave = 1; wave <= 5; wave++) {
      engine.learn('finint', [
        makeFinding({ id: `F${wave}01`, tags: ['finance'] }),
        makeFinding({ id: `F${wave}02`, tags: ['finance'] }),
      ], 5000, wave);
    }

    const profile = engine.getProfile('finint');
    const topSkill = profile.skills.sort((a, b) => b.confidence - a.confidence)[0];
    expect(topSkill.confidence).toBeGreaterThan(0.5);
  });

  it('persists and loads profiles', () => {
    const engine1 = new SkillEngine(TEST_DIR);
    engine1.learn('finint', [makeFinding()], 5000, 1);

    const engine2 = new SkillEngine(TEST_DIR);
    const profile = engine2.getProfile('finint');
    expect(profile.totalFindings).toBe(1);
  });

  it('builds skill context with instincts and developing sections', () => {
    const engine = new SkillEngine(TEST_DIR);
    // Build up enough history for skills
    for (let wave = 1; wave <= 3; wave++) {
      engine.learn('finint', [
        makeFinding({ id: `F${wave}01` }),
        makeFinding({ id: `F${wave}02` }),
      ], 5000, wave);
    }

    const context = engine.buildSkillContext('finint');
    expect(context).toContain('Agent Skills');
  });
});
