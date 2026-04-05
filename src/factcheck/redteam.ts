import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import type { Finding, RedTeamChallenge, EvidenceGrade } from '../knowledge/schema.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { FetchCache } from '../tokens/cache.js';
import type { TokenBudget } from '../tokens/budget.js';
import type { SkillEngine } from '../learning/skills.js';
import { webSearch } from '../tools/search.js';
import { crawl4aiScrape } from '../tools/crawl4ai.js';

/**
 * Red Team system — adversarial stress testing of findings.
 *
 * Think of this as the defense attorney. It assumes every finding is wrong
 * and tries to prove it. Findings that survive are battle-hardened.
 *
 * Attacks:
 * 1. ALTERNATIVE EXPLANATIONS — what else could explain this evidence?
 * 2. LOGICAL FALLACY SCAN — correlation≠causation, post hoc, cherry-picking
 * 3. SOURCE BIAS ANALYSIS — are the sources biased or captured?
 * 4. WEAKEST LINK — find the single point of failure
 * 5. STEELMAN THE OPPOSITION — build the strongest counter-argument
 */
export class RedTeam {
  private client: Anthropic;
  private model: string;

  constructor(
    private store: KnowledgeStore,
    private cache: FetchCache,
    private skills: SkillEngine,
    private budget: TokenBudget,
    options?: { client?: Anthropic; model?: string },
  ) {
    this.client = options?.client ?? new Anthropic();
    this.model = options?.model ?? 'claude-sonnet-4-20250514';
  }

  async challenge(finding: Finding): Promise<RedTeamChallenge> {
    console.log(chalk.red(`  [redteam] Challenging: ${finding.claim.slice(0, 80)}...`));

    // Get all related findings for context
    const relatedFindings = this.store.allFindings()
      .filter(f => f.id !== finding.id && f.tags.some(t => finding.tags.includes(t)))
      .slice(0, 5);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: this.buildRedTeamSystem(),
      messages: [{
        role: 'user',
        content: this.buildChallenge(finding, relatedFindings),
      }],
      tools: this.tools(),
    });

    // Run tool loop for adversarial research
    const result = await this.runToolLoop(response);
    this.trackTokens(response, 'redteam');

    const challenge = this.parseChallenge(finding, result);

    // Log results
    const icon = challenge.survived ? chalk.green('SURVIVED') : chalk.red('FAILED');
    console.log(`    ${icon} — ${challenge.alternativeExplanations.length} alt explanations, ${challenge.logicalFallacies.length} fallacies, grade: ${challenge.recommendedGrade}`);

    return challenge;
  }

  /** Challenge all findings at a given grade or higher */
  async challengeAll(findings: Finding[], options?: {
    minGrade?: EvidenceGrade;
  }): Promise<Map<string, RedTeamChallenge>> {
    const gradeOrder: Record<string, number> = {
      'DEVELOPING': 0, 'CIRCUMSTANTIAL': 1, 'STRONG': 2, 'BULLETPROOF': 3,
    };
    const minGrade = options?.minGrade ?? 'CIRCUMSTANTIAL';
    const targets = findings.filter(f => gradeOrder[f.evidence] >= gradeOrder[minGrade]);

    // Prioritize highest-impact findings
    targets.sort((a, b) => {
      const impactOrder: Record<string, number> = { 'CRITICAL': 3, 'HIGH': 2, 'MODERATE': 1, 'LOW': 0 };
      return impactOrder[b.impact] - impactOrder[a.impact];
    });

    const challenges = new Map<string, RedTeamChallenge>();
    for (const finding of targets) {
      if (this.budget.shouldTerminate()) {
        console.log(chalk.yellow(`  [redteam] Budget exhausted.`));
        break;
      }
      const challenge = await this.challenge(finding);
      challenges.set(finding.id, challenge);
    }
    return challenges;
  }

  private buildRedTeamSystem(): string {
    return `You are an elite adversarial analyst — the red team. Your MISSION is to break findings.

You are the defense attorney. You assume every finding is wrong until proven right. Your job is to find every possible weakness, alternative explanation, and logical flaw.

## Your Attacks

### 1. Alternative Explanations
For every finding, generate at least 2 alternative explanations for the evidence:
- Coincidence / statistical noise
- Reverse causation
- Common cause (both caused by a third factor)
- Systemic/structural explanations (it's the system, not the individual)
- Selective reporting / survivorship bias
Rate each: high/medium/low plausibility

### 2. Logical Fallacy Detection
Scan for:
- Post hoc ergo propter hoc (after, therefore because)
- Correlation ≠ causation
- Cherry-picking data
- Hasty generalization (too few examples)
- Appeal to authority (source reputation ≠ truth)
- Ecological fallacy (group patterns applied to individuals)
- Composition/division fallacies

### 3. Source Bias Analysis
- Are all sources from the same political/ideological perspective?
- Are any sources known to have an agenda?
- Is there circular sourcing (sources citing each other)?
- Is this based on anonymous sources?

### 4. Weakest Link
Find the single point of failure:
- What one fact, if wrong, would collapse the entire finding?
- What assumption hasn't been verified?
- What's the most fragile part of the evidence chain?

### 5. Steelman Opposition
Build the STRONGEST possible counter-argument. Not a strawman — a steelman.

## Output Format
Return JSON:
{
  "alternativeExplanations": [{"explanation": "...", "plausibility": "high/medium/low"}],
  "logicalFallacies": [{"fallacy": "name", "description": "how it applies"}],
  "sourceBias": "analysis or null",
  "weakestLink": {"description": "...", "recommendation": "what would fix this"},
  "steelmanCounter": "the strongest case against this finding",
  "survived": true/false,
  "recommendedGrade": "BULLETPROOF/STRONG/CIRCUMSTANTIAL/DEVELOPING"
}

IMPORTANT: Be BRUTAL but FAIR. Don't manufacture weaknesses that don't exist. If a finding is genuinely solid, say so — and explain why it survived. A finding that survives red-teaming is stronger than one that was never challenged.`;
  }

  private buildChallenge(finding: Finding, related: Finding[]): string {
    const sourceList = finding.sources
      .map(s => `- [${s.grade}] ${s.title}: ${s.url}`)
      .join('\n');

    const relatedContext = related.length > 0
      ? `\n\nRELATED FINDINGS:\n${related.map(f => `- [${f.evidence}] ${f.claim}`).join('\n')}`
      : '';

    return `RED TEAM THIS FINDING:

CLAIM: ${finding.claim}
EVIDENCE GRADE: ${finding.evidence}
IMPACT: ${finding.impact}
AGENT: ${finding.agent}
TAGS: ${finding.tags.join(', ')}

SOURCES:
${sourceList}

${finding.redTeam ? `PREVIOUS RED TEAM NOTES: ${finding.redTeam}` : ''}
${relatedContext}

Use web_search and web_scrape to find counter-evidence, check source reliability, and test alternative explanations. Then return your challenge as JSON.`;
  }

  private parseChallenge(finding: Finding, text: string): RedTeamChallenge {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return this.defaultChallenge(finding);
      const parsed = JSON.parse(match[0]) as {
        alternativeExplanations?: Array<{ explanation: string; plausibility: string }>;
        logicalFallacies?: Array<{ fallacy: string; description: string }>;
        sourceBias?: string;
        weakestLink?: { description: string; recommendation: string };
        survived?: boolean;
        recommendedGrade?: string;
      };

      return {
        id: `RT${String(Date.now()).slice(-6)}`,
        findingId: finding.id,
        alternativeExplanations: (parsed.alternativeExplanations ?? []).map(e => ({
          explanation: e.explanation,
          plausibility: e.plausibility as 'high' | 'medium' | 'low',
        })),
        logicalFallacies: parsed.logicalFallacies ?? [],
        sourceBias: parsed.sourceBias ?? undefined,
        weakestLink: parsed.weakestLink ?? { description: 'No critical weakness found', recommendation: 'Finding appears solid' },
        survived: parsed.survived ?? true,
        recommendedGrade: (parsed.recommendedGrade ?? finding.evidence) as EvidenceGrade,
        agent: 'redteam',
        created: new Date().toISOString(),
      };
    } catch {
      return this.defaultChallenge(finding);
    }
  }

  private defaultChallenge(finding: Finding): RedTeamChallenge {
    return {
      id: `RT${String(Date.now()).slice(-6)}`,
      findingId: finding.id,
      alternativeExplanations: [],
      logicalFallacies: [],
      weakestLink: { description: 'Unable to analyze', recommendation: 'Manual review needed' },
      survived: true,
      recommendedGrade: finding.evidence,
      agent: 'redteam',
      created: new Date().toISOString(),
    };
  }

  private async runToolLoop(initialResponse: Anthropic.Message): Promise<string> {
    let response = initialResponse;
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Proceed with red team analysis.' },
    ];
    let iterations = 0;

    while (iterations < 8) {
      iterations++;
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );

      if (toolUses.length === 0) {
        return response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text).join('');
      }

      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tool of toolUses) {
        const result = await this.executeTool(tool);
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: result });
      }
      messages.push({ role: 'user', content: toolResults });

      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        messages,
        tools: this.tools(),
      });
      this.trackTokens(response, 'redteam-loop');
    }

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text).join('');
  }

  private async executeTool(tool: Anthropic.ToolUseBlock): Promise<string> {
    if (tool.name === 'web_search') {
      const input = tool.input as { query: string };
      const cacheKey = `search:${input.query}`;
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
      const result = await webSearch(input.query);
      this.cache.set(cacheKey, result, 60);
      return result;
    }
    if (tool.name === 'web_scrape') {
      const input = tool.input as { url: string };
      const cacheKey = `scrape:${input.url}`;
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
      const result = await crawl4aiScrape(input.url);
      const content = result.error ? `[Error: ${result.error}]` : result.markdown;
      this.cache.set(cacheKey, content, 60);
      return content;
    }
    return 'Unknown tool';
  }

  private tools(): Anthropic.Tool[] {
    return [
      {
        name: 'web_search',
        description: 'Search for counter-evidence, fact-checks, and rebuttals.',
        input_schema: {
          type: 'object' as const,
          properties: { query: { type: 'string', description: 'Search query — bias toward finding counter-evidence' } },
          required: ['query'],
        },
      },
      {
        name: 'web_scrape',
        description: 'Deep scrape a URL to examine source quality and find counter-evidence.',
        input_schema: {
          type: 'object' as const,
          properties: { url: { type: 'string', description: 'URL to scrape' } },
          required: ['url'],
        },
      },
    ];
  }

  private trackTokens(response: Anthropic.Message, stage: string) {
    const tokens = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
    this.budget.track(stage, tokens);
  }
}
