import Anthropic from '@anthropic-ai/sdk';
import type { Finding } from '../knowledge/schema.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { TokenBudget } from '../tokens/budget.js';
import type { ContextBuilder } from '../tokens/context.js';
import type { FetchCache } from '../tokens/cache.js';
import type { DeltaComputer } from '../knowledge/delta.js';
import type { PatternLearner } from '../patterns/learner.js';
import type { SkillEngine } from '../learning/skills.js';
import { parseFindings } from '../utils/parsing.js';

export interface AgentDefinition {
  name: string;
  type: string;
  description: string;
  systemPrompt: string;
  dataSources: string[];
  searchStrategies: string[];
  outputFormat: 'findings' | 'analysis' | 'report';
}

export interface AgentContext {
  subject: string;
  focus?: string;
  wave: number;
  model: string;
  knowledge: KnowledgeStore;
  contextBuilder: ContextBuilder;
  delta: DeltaComputer;
  patterns: PatternLearner;
  skills: SkillEngine;
  budget: TokenBudget;
  cache: FetchCache;
  client: Anthropic;
}

export interface AgentOutput {
  findings: Finding[];
  tokensUsed: number;
  searchesPerformed: number;
  cacheHits: number;
}

/**
 * Base agent. All specialized agents extend this.
 * Handles: token budgets, delta checks, pattern reading, structured output.
 */
export class BaseAgent {
  protected def: AgentDefinition;
  protected ctx: AgentContext;

  constructor(definition: AgentDefinition, context: AgentContext) {
    this.def = definition;
    this.ctx = context;
  }

  async research(): Promise<AgentOutput> {
    const knowledgeSummary = this.ctx.contextBuilder.build(0);
    const patternDigest = this.ctx.patterns.digest(this.def.type);

    const systemPrompt = this.buildSystemPrompt(knowledgeSummary, patternDigest);

    const userPrompt = this.buildUserPrompt();

    const response = await this.ctx.client.messages.create({
      model: this.ctx.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: this.getTools(),
    });

    const tokensUsed = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
    this.ctx.budget.track('research', tokensUsed);

    const findings = this.parseFindingsFromResponse(response);

    return {
      findings,
      tokensUsed,
      searchesPerformed: 0,
      cacheHits: 0,
    };
  }

  protected buildSystemPrompt(knowledge: string, patterns: string): string {
    return `You are a ${this.def.type} research agent. ${this.def.description}

## Your Data Sources
${this.def.dataSources.map(d => `- ${d}`).join('\n')}

## Search Strategies
${this.def.searchStrategies.map(s => `- ${s}`).join('\n')}

## Current Knowledge (L0 Summary)
${knowledge}

## Learned Patterns
${patterns}

## Output Rules
- Return findings as JSON array
- Each finding needs: claim, evidence grade, sources with URLs, tags
- Check existing knowledge before researching — don't duplicate
- Be concise. Every token counts.`;
  }

  protected buildUserPrompt(): string {
    const focus = this.ctx.focus ? `\nFocus area: ${this.ctx.focus}` : '';
    return `Research subject: ${this.ctx.subject}${focus}
Wave: ${this.ctx.wave}
Token budget remaining: ${this.ctx.budget.remaining}

Return your findings as a JSON array. Each finding: { "claim": "...", "evidence": "STRONG", "impact": "HIGH", "sources": [{"url": "...", "title": "...", "grade": "A"}], "tags": ["tag1"] }`;
  }

  protected getTools(): Anthropic.Tool[] {
    return [
      {
        name: 'web_search',
        description: 'Search the web for information. Check cache first.',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
      },
    ];
  }

  protected parseFindingsFromResponse(response: Anthropic.Message): Finding[] {
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    return parseFindings(text, {
      agentType: this.def.type,
      wave: this.ctx.wave,
      nextId: () => this.ctx.knowledge.nextFindingId(),
    });
  }
}
