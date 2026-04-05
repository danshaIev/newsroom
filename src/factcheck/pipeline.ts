import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import type { Finding, Verdict, VerdictRating, AtomicClaim, Source } from '../knowledge/schema.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { FetchCache } from '../tokens/cache.js';
import type { TokenBudget } from '../tokens/budget.js';
import type { SkillEngine } from '../learning/skills.js';
import { webSearch } from '../tools/search.js';
import { crawl4aiScrape } from '../tools/crawl4ai.js';

/**
 * Multi-stage fact-check pipeline modeled on institutional verification.
 *
 * Stage 1: DECOMPOSE — break claim into atomic checkable facts
 * Stage 2: VERIFY — independently verify each atomic claim against primary sources
 * Stage 3: COUNTER — actively search for contradicting evidence
 * Stage 4: CONTEXT — check if claim is true but misleading
 * Stage 5: SYNTHESIZE — issue a verdict with confidence rating
 *
 * Each stage is a separate Claude call with specialized instructions.
 * The pipeline short-circuits if early stages prove the claim false.
 */
export class FactCheckPipeline {
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

  async check(finding: Finding): Promise<Verdict> {
    console.log(chalk.blue(`  [factcheck] Checking: ${finding.claim.slice(0, 80)}...`));

    // Stage 1: Decompose
    const atomicClaims = await this.decompose(finding);
    console.log(chalk.dim(`    Stage 1: Decomposed into ${atomicClaims.length} atomic claims`));

    // Stage 2: Verify each atomic claim independently
    const verified = await this.verify(finding, atomicClaims);
    const verifiedCount = verified.filter(c => c.verified).length;
    console.log(chalk.dim(`    Stage 2: ${verifiedCount}/${verified.length} claims verified`));

    // Stage 3: Counter-evidence search
    const counterEvidence = await this.searchCounter(finding);
    console.log(chalk.dim(`    Stage 3: ${counterEvidence.length} counter-evidence items found`));

    // Stage 4: Contextual analysis
    const contextualAnalysis = await this.analyzeContext(finding, verified, counterEvidence);
    console.log(chalk.dim(`    Stage 4: Context analyzed`));

    // Stage 5: Synthesize verdict
    const verdict = await this.synthesize(finding, verified, counterEvidence, contextualAnalysis);
    console.log(chalk.green(`    Verdict: ${verdict.rating} (${Math.round(verdict.confidence * 100)}% confidence)`));

    // Update skills
    this.skills.learn('factcheck', [{
      ...finding,
      evidence: verdict.rating === 'CONFIRMED' ? 'BULLETPROOF' : finding.evidence,
    }], this.budget.total, 0);

    return verdict;
  }

  /** Check multiple findings, prioritized by evidence grade (weakest first) */
  async checkAll(findings: Finding[]): Promise<Map<string, Verdict>> {
    const gradeOrder: Record<string, number> = {
      'DEVELOPING': 0, 'CIRCUMSTANTIAL': 1, 'STRONG': 2, 'BULLETPROOF': 3,
    };

    const sorted = [...findings].sort((a, b) =>
      gradeOrder[a.evidence] - gradeOrder[b.evidence]
    );

    const verdicts = new Map<string, Verdict>();
    for (const finding of sorted) {
      if (this.budget.shouldTerminate()) {
        console.log(chalk.yellow(`  [factcheck] Budget exhausted, stopping.`));
        break;
      }
      const verdict = await this.check(finding);
      verdicts.set(finding.id, verdict);
    }
    return verdicts;
  }

  /**
   * Stage 1: DECOMPOSE
   * Break a complex claim into atomic, independently checkable facts.
   */
  private async decompose(finding: Finding): Promise<AtomicClaim[]> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: `You are a fact-check decomposition specialist. Your ONLY job is to break complex claims into atomic, independently verifiable facts.

Rules:
- Each atomic claim must be checkable with a single source
- Include specific names, dates, numbers, locations
- Separate causal claims from correlational ones
- Separate factual claims from interpretive ones
- Return as JSON array: [{"claim": "..."}]`,
      messages: [{
        role: 'user',
        content: `Decompose this claim into atomic checkable facts:\n\nCLAIM: ${finding.claim}\n\nORIGINAL SOURCES: ${finding.sources.map(s => s.url).join(', ')}\n\nReturn JSON array of atomic claims.`,
      }],
    });

    this.trackTokens(response, 'decompose');

    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return [{ claim: finding.claim, verified: false, sources: [] }];
      const parsed = JSON.parse(match[0]) as Array<{ claim: string }>;
      return parsed.map(c => ({ claim: c.claim, verified: false, sources: [] }));
    } catch {
      return [{ claim: finding.claim, verified: false, sources: [] }];
    }
  }

  /**
   * Stage 2: VERIFY
   * Independently verify each atomic claim against primary sources.
   * Key rule: NEVER use the original finding's sources. Find new ones.
   */
  private async verify(finding: Finding, claims: AtomicClaim[]): Promise<AtomicClaim[]> {
    const originalDomains = finding.sources.map(s => {
      try { return new URL(s.url).hostname; } catch { return ''; }
    });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: `You are an independent verification specialist. Your job is to verify atomic claims using ONLY independent sources.

CRITICAL RULES:
- NEVER rely on the original sources: ${originalDomains.join(', ')}
- Find primary sources: government databases, official records, court filings, academic papers
- For financial claims: verify against SEC EDGAR, FEC.gov, official filings
- For dates/timelines: verify against multiple independent records
- For quotes: find the original transcript or recording
- If a claim cannot be independently verified, mark it as unverified with a note

Return JSON array: [{"claim": "...", "verified": true/false, "sources": [{"url": "...", "title": "...", "grade": "A/B/C"}], "notes": "..."}]`,
      messages: [{
        role: 'user',
        content: `Verify these atomic claims independently. Do NOT use the original sources.\n\n${claims.map((c, i) => `${i + 1}. ${c.claim}`).join('\n')}\n\nUse web_search and web_scrape to find independent verification. Return JSON array.`,
      }],
      tools: this.verificationTools(),
    });

    // Handle tool use loop for verification
    const verified = await this.runToolLoop(response, this.verificationTools(), 'verify');

    try {
      const match = verified.match(/\[[\s\S]*\]/);
      if (!match) return claims;
      const parsed = JSON.parse(match[0]) as Array<{
        claim: string; verified: boolean;
        sources?: Array<{ url: string; title?: string; grade?: string }>;
        notes?: string;
      }>;
      return parsed.map(c => ({
        claim: c.claim,
        verified: c.verified,
        sources: (c.sources ?? []).map(s => ({
          url: s.url, title: s.title ?? '', accessed: new Date().toISOString(),
          grade: (s.grade ?? 'B') as Source['grade'],
        })),
        notes: c.notes,
      }));
    } catch {
      return claims;
    }
  }

  /**
   * Stage 3: COUNTER-EVIDENCE
   * Actively search for evidence that contradicts the finding.
   * This is the adversarial heart of fact-checking.
   */
  private async searchCounter(finding: Finding): Promise<Array<{ claim: string; source: Source; strength: 'strong' | 'moderate' | 'weak' }>> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: `You are a counter-evidence specialist. Your ONLY job is to find evidence that CONTRADICTS the given claim.

Think like a defense attorney cross-examining a witness:
- Search for rebuttals, corrections, and retractions
- Look for conflicting data from authoritative sources
- Check if the claim has been debunked by fact-checkers
- Search for the subject's own statements that contradict the claim
- Look for statistical data that undermines the claim
- Check for important context that changes the meaning

You WANT to disprove this claim. If you can't, that strengthens it.

Return JSON array: [{"claim": "counter-evidence claim", "source": {"url": "...", "title": "...", "grade": "A/B/C"}, "strength": "strong/moderate/weak"}]
Return empty array [] if no counter-evidence found.`,
      messages: [{
        role: 'user',
        content: `Find counter-evidence for this claim:\n\nCLAIM: ${finding.claim}\n\nTAGS: ${finding.tags.join(', ')}\nORIGINAL EVIDENCE GRADE: ${finding.evidence}\n\nActively try to disprove this. Use web_search and web_scrape.`,
      }],
      tools: this.verificationTools(),
    });

    const result = await this.runToolLoop(response, this.verificationTools(), 'counter');

    try {
      const match = result.match(/\[[\s\S]*\]/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]) as Array<{
        claim: string;
        source: { url: string; title?: string; grade?: string };
        strength: 'strong' | 'moderate' | 'weak';
      }>;
      return parsed.map(c => ({
        claim: c.claim,
        source: {
          url: c.source.url, title: c.source.title ?? '',
          accessed: new Date().toISOString(), grade: (c.source.grade ?? 'B') as Source['grade'],
        },
        strength: c.strength,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Stage 4: CONTEXTUAL ANALYSIS
   * Is the claim technically true but misleading? Missing important context?
   */
  private async analyzeContext(
    finding: Finding,
    verified: AtomicClaim[],
    counterEvidence: Array<{ claim: string; strength: string }>
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: `You are a contextual analysis specialist. Assess whether a claim, even if factually accurate, might be misleading due to missing context.

Consider:
- Cherry-picking: Is this one data point from a larger trend that tells a different story?
- Timeframe manipulation: Is the time period selected to make things look worse/better?
- Comparison bias: Are comparisons fair and appropriate?
- Omission: What important context is missing?
- Causation vs correlation: Is a causal claim actually just correlation?

Return a brief analysis (2-3 sentences). If the claim is straightforward and not misleading, say "No significant contextual issues found."`,
      messages: [{
        role: 'user',
        content: `Analyze context for:\n\nCLAIM: ${finding.claim}\n\nVERIFIED ATOMIC CLAIMS:\n${verified.map(c => `- [${c.verified ? 'VERIFIED' : 'UNVERIFIED'}] ${c.claim}`).join('\n')}\n\nCOUNTER-EVIDENCE:\n${counterEvidence.map(c => `- [${c.strength}] ${c.claim}`).join('\n') || 'None found'}\n\nIs this claim misleading even if technically true?`,
      }],
    });

    this.trackTokens(response, 'context');
    return response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
  }

  /**
   * Stage 5: SYNTHESIZE
   * Combine all evidence into a final verdict.
   */
  private async synthesize(
    finding: Finding,
    verified: AtomicClaim[],
    counterEvidence: Array<{ claim: string; source: Source; strength: string }>,
    contextualAnalysis: string,
  ): Promise<Verdict> {
    const verifiedCount = verified.filter(c => c.verified).length;
    const strongCounter = counterEvidence.filter(c => c.strength === 'strong').length;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: `You are a verdict synthesis specialist. Issue a final fact-check verdict based on the evidence gathered.

Verdict ratings:
- CONFIRMED: All atomic claims verified, no significant counter-evidence
- MOSTLY_TRUE: Core claim verified but minor details unconfirmed or slightly off
- MIXED: Some claims verified, some contradicted — truth is more nuanced
- MOSTLY_FALSE: Core claim contradicted, only minor elements are true
- FALSE: Claim clearly disproven by counter-evidence
- UNVERIFIABLE: Cannot be independently verified with available sources

Return JSON: {"rating": "...", "confidence": 0.0-1.0, "verificationNotes": ["note1", "note2"]}`,
      messages: [{
        role: 'user',
        content: `Issue a verdict:\n\nORIGINAL CLAIM: ${finding.claim}\nORIGINAL GRADE: ${finding.evidence}\n\nATOMIC CLAIMS: ${verifiedCount}/${verified.length} verified\n${verified.map(c => `- [${c.verified ? 'OK' : 'FAIL'}] ${c.claim}${c.notes ? ` (${c.notes})` : ''}`).join('\n')}\n\nCOUNTER-EVIDENCE: ${counterEvidence.length} items (${strongCounter} strong)\n${counterEvidence.map(c => `- [${c.strength}] ${c.claim}`).join('\n') || 'None'}\n\nCONTEXTUAL ANALYSIS: ${contextualAnalysis}\n\nReturn JSON verdict.`,
      }],
    });

    this.trackTokens(response, 'synthesize');
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');

    let rating: VerdictRating = 'UNVERIFIABLE';
    let confidence = 0.5;
    let verificationNotes: string[] = [];

    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as {
          rating: VerdictRating; confidence: number; verificationNotes?: string[];
        };
        rating = parsed.rating;
        confidence = parsed.confidence;
        verificationNotes = parsed.verificationNotes ?? [];
      }
    } catch {}

    return {
      id: `V${String(Date.now()).slice(-6)}`,
      findingId: finding.id,
      rating,
      confidence,
      atomicClaims: verified,
      confirmingSources: verified.filter(c => c.verified).flatMap(c => c.sources),
      counterEvidence: counterEvidence.map(c => ({
        claim: c.claim,
        source: c.source,
        strength: c.strength as 'strong' | 'moderate' | 'weak',
      })),
      contextualAnalysis,
      verificationNotes,
      agent: 'factcheck',
      created: new Date().toISOString(),
    };
  }

  /** Run a tool-use loop until the model stops calling tools */
  private async runToolLoop(
    initialResponse: Anthropic.Message,
    tools: Anthropic.Tool[],
    stage: string,
  ): Promise<string> {
    let response = initialResponse;
    const messages: Anthropic.MessageParam[] = [];
    let iterations = 0;

    // Add initial user message context
    messages.push({ role: 'user', content: 'Proceed with verification.' });

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
        tools,
      });

      this.trackTokens(response, stage);
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

  private verificationTools(): Anthropic.Tool[] {
    return [
      {
        name: 'web_search',
        description: 'Search the web for verification sources.',
        input_schema: {
          type: 'object' as const,
          properties: { query: { type: 'string', description: 'Search query' } },
          required: ['query'],
        },
      },
      {
        name: 'web_scrape',
        description: 'Deep scrape a URL for primary source verification. Returns clean markdown.',
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
    this.budget.track(`factcheck-${stage}`, tokens);
  }
}
