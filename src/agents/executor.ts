import Anthropic from '@anthropic-ai/sdk';
import type { Finding, Source } from '../knowledge/schema.js';
import type { AgentContext, AgentDefinition, AgentOutput } from './base.js';
import type { TokenBudget } from '../tokens/budget.js';

/**
 * Agentic executor: runs an agent with tool use in a loop.
 * Handles web_search tool calls, caching, and token tracking.
 * Terminates early when budget is exhausted.
 */
export class AgentExecutor {
  private searchCount = 0;
  private cacheHits = 0;

  constructor(
    private def: AgentDefinition,
    private ctx: AgentContext,
  ) {}

  async execute(): Promise<AgentOutput> {
    const knowledgeSummary = this.ctx.contextBuilder.build(0);
    const patternDigest = this.ctx.patterns.digest(this.def.type);
    const delta = this.ctx.delta.computeGaps(
      (this.ctx.focus ? [{ question: this.ctx.focus, priority: 1, existingFindings: [], gap: '' }] : [])
    );

    const system = this.buildSystem(knowledgeSummary, patternDigest);
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: this.buildPrompt(delta) },
    ];

    let findings: Finding[] = [];
    let totalTokens = 0;
    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations && !this.ctx.budget.shouldTerminate()) {
      iterations++;

      const response = await this.ctx.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system,
        messages,
        tools: this.tools(),
      });

      const tokens = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
      totalTokens += tokens;
      this.ctx.budget.track(`iteration-${iterations}`, tokens);

      // Process tool calls
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );

      if (toolUses.length > 0) {
        // Add assistant message
        messages.push({ role: 'assistant', content: response.content });

        // Execute tools and add results
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const tool of toolUses) {
          const result = await this.executeTool(tool);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tool.id,
            content: result,
          });
        }
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // No tool calls — extract findings from text
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text'
      );
      const text = textBlocks.map(b => b.text).join('');
      findings = this.parseFindings(text);

      if (response.stop_reason === 'end_turn') break;
    }

    return {
      findings,
      tokensUsed: totalTokens,
      searchesPerformed: this.searchCount,
      cacheHits: this.cacheHits,
    };
  }

  private async executeTool(tool: Anthropic.ToolUseBlock): Promise<string> {
    if (tool.name === 'web_search') {
      const input = tool.input as { query: string };
      return this.webSearch(input.query);
    }
    if (tool.name === 'check_knowledge') {
      const input = tool.input as { claim: string };
      const existing = this.ctx.delta.claimExists(input.claim);
      if (existing) {
        this.cacheHits++;
        return `ALREADY KNOWN [${existing.evidence}]: ${existing.claim} (${existing.sources.length} sources)`;
      }
      return 'NOT FOUND — this is a research gap, proceed with web search.';
    }
    return 'Unknown tool';
  }

  private async webSearch(query: string): Promise<string> {
    // Check cache first
    const cacheKey = `search:${query}`;
    const cached = this.ctx.cache.get(cacheKey);
    if (cached) {
      this.cacheHits++;
      return cached;
    }

    this.searchCount++;

    // Use Claude's built-in web search via a separate call
    // In production, this would use a search API (Brave, Google, etc.)
    // For now, return a placeholder that the agent can work with
    const result = `[Search results for: "${query}" — use WebSearch tool in Claude Code or integrate a search API]`;
    this.ctx.cache.set(cacheKey, result, 30);
    return result;
  }

  private tools(): Anthropic.Tool[] {
    return [
      {
        name: 'web_search',
        description: 'Search the web. Results are cached — identical queries return cached results.',
        input_schema: {
          type: 'object' as const,
          properties: { query: { type: 'string', description: 'Search query' } },
          required: ['query'],
        },
      },
      {
        name: 'check_knowledge',
        description: 'Check if a claim already exists in the knowledge store. ALWAYS check before searching.',
        input_schema: {
          type: 'object' as const,
          properties: { claim: { type: 'string', description: 'The claim to check' } },
          required: ['claim'],
        },
      },
    ];
  }

  private buildSystem(knowledge: string, patterns: string): string {
    return `You are a ${this.def.type} research agent. ${this.def.description}

## CRITICAL: Token Efficiency Rules
1. ALWAYS use check_knowledge before web_search — never research what's already known
2. Return findings as JSON array — no prose summaries
3. Stop when you have strong findings or budget is low
4. Each finding: { "claim": "...", "evidence": "STRONG|BULLETPROOF|CIRCUMSTANTIAL|DEVELOPING", "impact": "CRITICAL|HIGH|MODERATE|LOW", "sources": [{"url": "...", "title": "...", "grade": "A|B|C"}], "tags": ["tag1"] }

## Data Sources
${this.def.dataSources.map(d => `- ${d}`).join('\n')}

## Search Strategies
${this.def.searchStrategies.map(s => `- ${s}`).join('\n')}

## Current Knowledge (L0)
${knowledge}

## Learned Patterns
${patterns}`;
  }

  private buildPrompt(gaps: Array<{ question: string }>): string {
    const gapList = gaps.length > 0
      ? `\nKnown gaps to investigate:\n${gaps.map(g => `- ${g.question}`).join('\n')}`
      : '';
    return `Research subject: ${this.ctx.subject}
Wave: ${this.ctx.wave}
Token budget remaining: ${this.ctx.budget.remaining}
${this.ctx.focus ? `Focus: ${this.ctx.focus}` : ''}
${gapList}

Use check_knowledge before web_search. Return findings as JSON array when done.`;
  }

  private parseFindings(text: string): Finding[] {
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      const raw = JSON.parse(jsonMatch[0]) as Array<{
        claim: string;
        evidence?: string;
        impact?: string;
        sources?: Array<{ url: string; title?: string; grade?: string }>;
        tags?: string[];
        redTeam?: string;
      }>;

      return raw.map(r => ({
        id: this.ctx.knowledge.nextFindingId(),
        claim: r.claim,
        evidence: (r.evidence || 'DEVELOPING') as Finding['evidence'],
        impact: (r.impact || 'MODERATE') as Finding['impact'],
        sources: (r.sources || []).map(s => ({
          url: s.url,
          title: s.title || '',
          accessed: new Date().toISOString(),
          grade: (s.grade || 'B') as Source['grade'],
        })),
        agent: this.def.type,
        wave: this.ctx.wave,
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
}
