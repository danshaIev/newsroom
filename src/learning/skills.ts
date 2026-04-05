import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Finding } from '../knowledge/schema.js';
import { wordSimilarity, extractDomain } from '../utils/similarity.js';
import { atomicWriteFileSync } from '../utils/fs.js';

/**
 * A Skill is a learned micro-behavior that an agent develops through experience.
 * Like a soccer player's free kick curve — it activates automatically when
 * the situation matches, and improves with each successful use.
 */
export interface Skill {
  id: string;
  agent: string;
  name: string;
  /** When this skill fires: a natural-language situation description */
  trigger: string;
  /** What the agent should do when triggered */
  action: string;
  /** How often this skill produced good results (0-1) */
  successRate: number;
  /** Total times this skill has been applied */
  uses: number;
  /** Total times it led to STRONG+ findings */
  successes: number;
  /** When was this skill first learned */
  learnedAt: string;
  /** Last time it was used */
  lastUsed: string;
  /** Confidence grows with use — low confidence skills are suggestions, high ones are instincts */
  confidence: number;
  /** Tags/domains this skill is relevant to */
  domains: string[];
}

/**
 * Per-agent profile that tracks expertise, skills, and effectiveness.
 * Persists across waves AND across investigations.
 */
export interface AgentProfile {
  agent: string;
  /** Total investigations this agent has participated in */
  totalInvestigations: number;
  /** Total findings produced */
  totalFindings: number;
  /** Findings at STRONG or BULLETPROOF grade */
  strongFindings: number;
  /** Findings per 1000 tokens — efficiency metric */
  findingsPerKToken: number;
  /** Source domains ranked by reliability for this agent */
  sourceTrust: Record<string, { score: number; uses: number }>;
  /** Search strategies ranked by effectiveness */
  strategyScores: Record<string, { score: number; uses: number }>;
  /** Topics/tags this agent has expertise in */
  topicExpertise: Record<string, { score: number; findings: number }>;
  /** The agent's learned skills — the core ML feature */
  skills: Skill[];
  /** Last updated */
  updated: string;
}

/**
 * SkillEngine — the self-learning system.
 * After each wave, analyzes what worked and develops/refines skills.
 * Skills are injected into agent system prompts so behavior evolves naturally.
 */
export class SkillEngine {
  private profiles: Map<string, AgentProfile> = new Map();
  private dir: string;
  private skillCounter = 0;

  constructor(projectDir: string) {
    this.dir = join(projectDir, '.newsroom', 'profiles');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  private load() {
    const indexPath = join(this.dir, 'profiles.json');
    if (!existsSync(indexPath)) return;
    const data = JSON.parse(readFileSync(indexPath, 'utf-8')) as AgentProfile[];
    for (const profile of data) {
      this.profiles.set(profile.agent, profile);
      const maxId = profile.skills.reduce((max, s) => {
        const num = parseInt(s.id.replace('SK', ''));
        return num > max ? num : max;
      }, 0);
      if (maxId > this.skillCounter) this.skillCounter = maxId;
    }
  }

  private persist() {
    const data = [...this.profiles.values()];
    atomicWriteFileSync(join(this.dir, 'profiles.json'), JSON.stringify(data, null, 2));
    atomicWriteFileSync(join(this.dir, 'skills.md'), this.allSkillsDigest());
  }

  /** Get or create a profile for an agent */
  getProfile(agent: string): AgentProfile {
    if (!this.profiles.has(agent)) {
      this.profiles.set(agent, {
        agent,
        totalInvestigations: 0,
        totalFindings: 0,
        strongFindings: 0,
        findingsPerKToken: 0,
        sourceTrust: {},
        strategyScores: {},
        topicExpertise: {},
        skills: [],
        updated: new Date().toISOString(),
      });
    }
    return this.profiles.get(agent)!;
  }

  /**
   * Core learning loop — called after each wave.
   * Analyzes findings to develop and refine skills.
   */
  learn(agent: string, findings: Finding[], tokensUsed: number, wave: number) {
    const profile = this.getProfile(agent);
    profile.totalInvestigations++;
    profile.totalFindings += findings.length;
    profile.updated = new Date().toISOString();

    const strong = findings.filter(f => f.evidence === 'STRONG' || f.evidence === 'BULLETPROOF');
    profile.strongFindings += strong.length;
    profile.findingsPerKToken = profile.totalFindings / Math.max(1, (tokensUsed / 1000));

    // Update source trust
    for (const f of findings) {
      const isStrong = f.evidence === 'STRONG' || f.evidence === 'BULLETPROOF';
      for (const s of f.sources) {
        const domain = extractDomain(s.url);
        const trust = profile.sourceTrust[domain] ?? { score: 0.5, uses: 0 };
        trust.uses++;
        // Exponential moving average — recent results weighted more
        const weight = 0.3;
        trust.score = trust.score * (1 - weight) + (isStrong ? 1 : 0.2) * weight;
        profile.sourceTrust[domain] = trust;
      }
    }

    // Update topic expertise
    for (const f of findings) {
      for (const tag of f.tags) {
        const expertise = profile.topicExpertise[tag] ?? { score: 0, findings: 0 };
        expertise.findings++;
        expertise.score = Math.min(1, expertise.findings / 10); // Maxes at 10 findings
        profile.topicExpertise[tag] = expertise;
      }
    }

    // Develop new skills from patterns in this wave's findings
    this.developSkills(agent, findings, wave);

    // Reinforce existing skills that were relevant this wave
    this.reinforceSkills(agent, findings);

    // Decay unused skills slightly
    this.decaySkills(agent);

    this.persist();
  }

  /**
   * Generate the skills context that gets injected into an agent's system prompt.
   * Only includes high-confidence skills relevant to the current focus.
   */
  buildSkillContext(agent: string, focus?: string, tags?: string[]): string {
    const profile = this.getProfile(agent);
    if (profile.skills.length === 0 && Object.keys(profile.sourceTrust).length === 0) {
      return '## Agent Skills\nNo skills developed yet. This is your first investigation.';
    }

    const sections: string[] = ['## Agent Skills & Instincts\n'];

    // Top trusted sources
    const trustedSources = Object.entries(profile.sourceTrust)
      .filter(([, v]) => v.score > 0.6 && v.uses >= 2)
      .sort(([, a], [, b]) => b.score - a.score)
      .slice(0, 8);
    if (trustedSources.length > 0) {
      sections.push('### Trusted Sources (prioritize these)');
      sections.push(...trustedSources.map(([domain, v]) =>
        `- ${domain} (reliability: ${Math.round(v.score * 100)}%, used ${v.uses}x)`
      ));
    }

    // Topic expertise
    const expertise = Object.entries(profile.topicExpertise)
      .filter(([, v]) => v.score > 0.3)
      .sort(([, a], [, b]) => b.score - a.score)
      .slice(0, 5);
    if (expertise.length > 0) {
      sections.push('\n### Your Expertise');
      sections.push(...expertise.map(([topic, v]) =>
        `- ${topic}: ${Math.round(v.score * 100)}% mastery (${v.findings} findings)`
      ));
    }

    // Active skills — the key feature
    // Filter to relevant skills based on focus/tags
    const relevantSkills = this.getRelevantSkills(agent, focus, tags);
    const instincts = relevantSkills.filter(s => s.confidence >= 0.7);
    const developing = relevantSkills.filter(s => s.confidence >= 0.3 && s.confidence < 0.7);

    if (instincts.length > 0) {
      sections.push('\n### Instincts (ALWAYS apply these — they work)');
      for (const skill of instincts) {
        sections.push(`- **${skill.name}**: When ${skill.trigger} → ${skill.action} (${Math.round(skill.successRate * 100)}% success, ${skill.uses} uses)`);
      }
    }

    if (developing.length > 0) {
      sections.push('\n### Developing Skills (try these when relevant)');
      for (const skill of developing) {
        sections.push(`- ${skill.name}: When ${skill.trigger} → ${skill.action} (${Math.round(skill.successRate * 100)}% success, ${skill.uses} uses)`);
      }
    }

    // Efficiency note
    sections.push(`\n### Performance: ${profile.findingsPerKToken.toFixed(1)} findings/1K tokens | ${profile.totalInvestigations} investigations`);

    return sections.join('\n');
  }

  /** Get skills relevant to current context */
  private getRelevantSkills(agent: string, focus?: string, tags?: string[]): Skill[] {
    const profile = this.getProfile(agent);
    return profile.skills
      .filter(s => {
        // Always include high-confidence skills
        if (s.confidence >= 0.7) return true;
        // Include domain-relevant skills
        if (tags && s.domains.some(d => tags.includes(d))) return true;
        // Include if trigger matches focus
        if (focus && s.trigger.toLowerCase().includes(focus.toLowerCase())) return true;
        // Include recent skills
        const daysSinceUsed = (Date.now() - new Date(s.lastUsed).getTime()) / (1000 * 60 * 60 * 24);
        return daysSinceUsed < 7;
      })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 12);
  }

  /**
   * Develop new skills from patterns in findings.
   * This is the core "learning" — recognizing repeatable patterns.
   */
  private developSkills(agent: string, findings: Finding[], wave: number) {
    const profile = this.getProfile(agent);
    const strong = findings.filter(f => f.evidence === 'STRONG' || f.evidence === 'BULLETPROOF');

    // Skill: Source combination patterns
    // If multiple strong findings came from the same source combination, that's a skill
    const sourceCombos = new Map<string, Finding[]>();
    for (const f of strong) {
      const domains = f.sources.map(s => extractDomain(s.url)).sort().join('+');
      if (!sourceCombos.has(domains)) sourceCombos.set(domains, []);
      sourceCombos.get(domains)!.push(f);
    }
    for (const [combo, comboFindings] of sourceCombos) {
      if (comboFindings.length >= 2) {
        const tags = [...new Set(comboFindings.flatMap(f => f.tags))];
        this.addOrReinforceSkill(profile, {
          name: `Cross-reference ${combo.replace(/\+/g, ' × ')}`,
          trigger: `investigating ${tags.join(' or ')}`,
          action: `Cross-reference ${combo.replace(/\+/g, ' and ')} — this combination consistently produces strong findings`,
          domains: tags,
        });
      }
    }

    // Skill: Tag-specific search patterns
    // If a tag consistently produces strong findings, develop expertise
    const tagSuccess = new Map<string, number>();
    for (const f of strong) {
      for (const tag of f.tags) {
        tagSuccess.set(tag, (tagSuccess.get(tag) ?? 0) + 1);
      }
    }
    for (const [tag, count] of tagSuccess) {
      if (count >= 2) {
        this.addOrReinforceSkill(profile, {
          name: `${tag} specialist`,
          trigger: `researching topics related to ${tag}`,
          action: `Dig deeper on ${tag} — you have a track record here. Use your trusted sources and look for cross-references with related tags.`,
          domains: [tag],
        });
      }
    }

    // Skill: Evidence escalation
    // If findings started as CIRCUMSTANTIAL and were upgraded, learn that pattern
    const upgraded = findings.filter(f =>
      f.evidence === 'STRONG' && f.sources.length >= 3
    );
    if (upgraded.length >= 2) {
      const domains = [...new Set(upgraded.flatMap(f => f.tags))];
      this.addOrReinforceSkill(profile, {
        name: 'Multi-source verification',
        trigger: 'finding circumstantial evidence that needs strengthening',
        action: 'Gather 3+ independent sources to escalate evidence grade. Focus on primary sources (government databases, official filings) over secondary sources (news articles).',
        domains,
      });
    }

    // Skill: High-impact detection
    const critical = findings.filter(f => f.impact === 'CRITICAL' && f.evidence !== 'DEVELOPING');
    if (critical.length >= 1) {
      for (const f of critical) {
        this.addOrReinforceSkill(profile, {
          name: `Red flag: ${f.tags[0] ?? 'critical'} pattern`,
          trigger: `encountering ${f.tags.join(' + ')} patterns`,
          action: `This is a known high-impact area. Prioritize thorough sourcing and check for timeline correlations. Previous critical finding: "${f.claim.slice(0, 80)}"`,
          domains: f.tags,
        });
      }
    }
  }

  /** Reinforce skills that were relevant to this wave's findings */
  private reinforceSkills(agent: string, findings: Finding[]) {
    const profile = this.getProfile(agent);
    const tags = new Set(findings.flatMap(f => f.tags));
    const strong = findings.filter(f => f.evidence === 'STRONG' || f.evidence === 'BULLETPROOF');
    const strongTags = new Set(strong.flatMap(f => f.tags));

    for (const skill of profile.skills) {
      const relevant = skill.domains.some(d => tags.has(d));
      if (!relevant) continue;

      skill.uses++;
      skill.lastUsed = new Date().toISOString();

      const successful = skill.domains.some(d => strongTags.has(d));
      if (successful) {
        skill.successes++;
      }
      skill.successRate = skill.successes / Math.max(1, skill.uses);
      skill.confidence = this.computeConfidence(skill);
    }
  }

  /** Skills decay slightly if not used — prevents stale behavior */
  private decaySkills(agent: string) {
    const profile = this.getProfile(agent);
    const now = Date.now();

    profile.skills = profile.skills.filter(skill => {
      const daysSinceUsed = (now - new Date(skill.lastUsed).getTime()) / (1000 * 60 * 60 * 24);
      // Decay confidence for unused skills
      if (daysSinceUsed > 14) {
        skill.confidence *= 0.95;
      }
      // Remove skills that have decayed below threshold and have low usage
      return skill.confidence > 0.1 || skill.uses >= 5;
    });
  }

  /** Add a new skill or reinforce an existing one if similar */
  private addOrReinforceSkill(profile: AgentProfile, partial: {
    name: string; trigger: string; action: string; domains: string[];
  }) {
    // Check for existing similar skill
    const existing = profile.skills.find(s =>
      wordSimilarity(s.name, partial.name) > 0.6 ||
      (s.domains.length > 0 && partial.domains.length > 0 &&
        s.domains.some(d => partial.domains.includes(d)) && s.trigger === partial.trigger)
    );

    if (existing) {
      existing.uses++;
      existing.successes++;
      existing.lastUsed = new Date().toISOString();
      existing.successRate = existing.successes / existing.uses;
      existing.confidence = this.computeConfidence(existing);
      // Update action if we have a better one
      if (partial.action.length > existing.action.length) {
        existing.action = partial.action;
      }
      // Merge domains
      for (const d of partial.domains) {
        if (!existing.domains.includes(d)) existing.domains.push(d);
      }
    } else {
      profile.skills.push({
        id: `SK${String(++this.skillCounter).padStart(3, '0')}`,
        agent: profile.agent,
        name: partial.name,
        trigger: partial.trigger,
        action: partial.action,
        successRate: 1,
        uses: 1,
        successes: 1,
        learnedAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        confidence: 0.3, // New skills start as "developing"
        domains: partial.domains,
      });
    }
  }

  /** Confidence grows with use and success rate */
  private computeConfidence(skill: Skill): number {
    // Uses contribute to confidence (more experience = more confident)
    const experienceFactor = Math.min(1, skill.uses / 8);
    // Success rate is the primary signal
    const successFactor = skill.successRate;
    // Combined: need both experience AND success
    return Math.min(1, experienceFactor * 0.4 + successFactor * 0.6);
  }

  /** Human-readable digest of all learned skills across agents */
  allSkillsDigest(): string {
    const sections: string[] = ['# Learned Skills & Agent Profiles\n'];

    for (const profile of this.profiles.values()) {
      sections.push(`## ${profile.agent}`);
      sections.push(`Investigations: ${profile.totalInvestigations} | Findings: ${profile.totalFindings} (${profile.strongFindings} strong) | Efficiency: ${profile.findingsPerKToken.toFixed(1)}/1K tokens\n`);

      if (profile.skills.length > 0) {
        const sorted = [...profile.skills].sort((a, b) => b.confidence - a.confidence);
        const instincts = sorted.filter(s => s.confidence >= 0.7);
        const developing = sorted.filter(s => s.confidence >= 0.3 && s.confidence < 0.7);
        const nascent = sorted.filter(s => s.confidence < 0.3);

        if (instincts.length > 0) {
          sections.push('### Instincts');
          instincts.forEach(s => sections.push(`- **${s.name}** (${Math.round(s.confidence * 100)}%): ${s.trigger} → ${s.action.slice(0, 100)}`));
        }
        if (developing.length > 0) {
          sections.push('### Developing');
          developing.forEach(s => sections.push(`- ${s.name} (${Math.round(s.confidence * 100)}%): ${s.trigger}`));
        }
        if (nascent.length > 0) {
          sections.push(`### Nascent (${nascent.length} skills still forming)`);
        }
      }
      sections.push('');
    }

    return sections.join('\n');
  }

  /** Quick stats for CLI display */
  profileSummary(agent: string): string {
    const p = this.getProfile(agent);
    const instincts = p.skills.filter(s => s.confidence >= 0.7).length;
    const developing = p.skills.filter(s => s.confidence >= 0.3 && s.confidence < 0.7).length;
    return `${agent}: ${p.totalFindings} findings, ${instincts} instincts, ${developing} developing skills, ${p.findingsPerKToken.toFixed(1)} findings/1K tokens`;
  }
}
