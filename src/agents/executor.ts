import Anthropic from '@anthropic-ai/sdk';
import type { Finding } from '../knowledge/schema.js';
import type { AgentContext, AgentDefinition, AgentOutput } from './base.js';
import { webSearch, webFetch } from '../tools/search.js';
import { crawl4aiPooledScrape } from '../tools/crawl4ai.js';
import { youSearch, youResearch } from '../tools/youcom.js';
import { extractPdf } from '../tools/pdf-extract.js';
import { parseFindings } from '../utils/parsing.js';
import { toolInput, assertString, assertOptionalString, assertOptionalBoolean, assertEnum, ToolInputError } from '../utils/validate.js';

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
        model: this.ctx.model,
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
      findings = parseFindings(text, {
        agentType: this.def.type,
        wave: this.ctx.wave,
        nextId: () => this.ctx.knowledge.nextFindingId(),
      });

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
    try {
      const inp = toolInput(tool.input);

      if (tool.name === 'web_search') {
        const query = assertString(inp.query, 'query');
        const cacheKey = `search:${query}`;
        const cached = this.ctx.cache.get(cacheKey);
        if (cached) { this.cacheHits++; return cached; }
        this.searchCount++;
        const result = await webSearch(query);
        this.ctx.cache.set(cacheKey, result, 60);
        return result;
      }
      if (tool.name === 'web_fetch') {
        const url = assertString(inp.url, 'url');
        const cached = this.ctx.cache.get(url);
        if (cached) { this.cacheHits++; return cached; }
        this.searchCount++;
        const result = await webFetch(url);
        this.ctx.cache.set(url, result, 60);
        return result;
      }
      if (tool.name === 'web_scrape') {
        const url = assertString(inp.url, 'url');
        const onlyMainContent = assertOptionalBoolean(inp.onlyMainContent, 'onlyMainContent') ?? true;
        const cacheKey = `scrape:${url}`;
        const cached = this.ctx.cache.get(cacheKey);
        if (cached) { this.cacheHits++; return cached; }
        this.searchCount++;
        const result = await crawl4aiPooledScrape(url, { onlyMainContent });
        const content = result.error
          ? `[Scrape error: ${result.error}]`
          : `# ${result.title ?? ''}\n\n${result.markdown}`;
        this.ctx.cache.set(cacheKey, content, 60);
        return content;
      }
      if (tool.name === 'you_search') {
        const query = assertString(inp.query, 'query');
        const searchType = assertEnum(inp.searchType, 'searchType', ['web', 'news'] as const);
        const cacheKey = `you:${query}:${searchType ?? 'web'}`;
        const cached = this.ctx.cache.get(cacheKey);
        if (cached) { this.cacheHits++; return cached; }
        this.searchCount++;
        const result = await youSearch(query, { searchType });
        this.ctx.cache.set(cacheKey, result, 60);
        return result;
      }
      if (tool.name === 'deep_research') {
        const query = assertString(inp.query, 'query');
        const effort = assertEnum(inp.effort, 'effort', ['lite', 'standard', 'deep', 'exhaustive'] as const);
        const cacheKey = `research:${query}:${effort ?? 'deep'}`;
        const cached = this.ctx.cache.get(cacheKey);
        if (cached) { this.cacheHits++; return cached; }
        this.searchCount++;
        const result = await youResearch(query, { effort });
        const formatted = `${result.answer}\n\nCitations:\n${result.citations.map(c => `- ${c.title}: ${c.url}`).join('\n')}`;
        this.ctx.cache.set(cacheKey, formatted, 120);
        return formatted;
      }
      if (tool.name === 'pdf_extract') {
        const source = assertString(inp.source, 'source');
        const cacheKey = `pdf:${source}`;
        const cached = this.ctx.cache.get(cacheKey);
        if (cached) { this.cacheHits++; return cached; }
        this.searchCount++;
        const result = await extractPdf(source);
        const content = result.error
          ? `[PDF error: ${result.error}]`
          : `[${result.pages} pages]\n\n${result.text}`;
        this.ctx.cache.set(cacheKey, content, 120);
        return content;
      }
      if (tool.name === 'check_knowledge') {
        const claim = assertString(inp.claim, 'claim');
        const existing = this.ctx.delta.claimExists(claim);
        if (existing) {
          this.cacheHits++;
          return `ALREADY KNOWN [${existing.evidence}]: ${existing.claim} (${existing.sources.length} sources)`;
        }
        return 'NOT FOUND — research gap, proceed with web search.';
      }
      return 'Unknown tool';
    } catch (e) {
      if (e instanceof ToolInputError) {
        return `[Tool input error: ${e.message}]`;
      }
      throw e;
    }
  }

  private tools(): Anthropic.Tool[] {
    return [
      {
        name: 'check_knowledge',
        description: 'Check if a claim already exists in the knowledge store. ALWAYS use before web_search.',
        input_schema: {
          type: 'object' as const,
          properties: { claim: { type: 'string', description: 'The claim to check' } },
          required: ['claim'],
        },
      },
      {
        name: 'web_search',
        description: 'Search the web. Results are cached.',
        input_schema: {
          type: 'object' as const,
          properties: { query: { type: 'string', description: 'Search query' } },
          required: ['query'],
        },
      },
      {
        name: 'web_fetch',
        description: 'Quick fetch a URL (raw text, no JS). Use web_scrape for better results on complex pages.',
        input_schema: {
          type: 'object' as const,
          properties: { url: { type: 'string', description: 'URL to fetch' } },
          required: ['url'],
        },
      },
      {
        name: 'web_scrape',
        description: 'Deep scrape a URL using a headless browser. Returns clean markdown with JS-rendered content. Use this for complex pages, SPAs, and pages with dynamic content. Slower than web_fetch but much higher quality.',
        input_schema: {
          type: 'object' as const,
          properties: {
            url: { type: 'string', description: 'URL to scrape' },
            onlyMainContent: { type: 'boolean', description: 'Strip navigation/ads, keep only main content (default: true)' },
          },
          required: ['url'],
        },
      },
      {
        name: 'you_search',
        description: 'Search via You.com — better than web_search for investigative queries. Supports news-specific search. Use for finding recent news, filtering by topic, and investigative queries.',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search query' },
            searchType: { type: 'string', enum: ['web', 'news'], description: 'Search type: web (default) or news for recent coverage' },
          },
          required: ['query'],
        },
      },
      {
        name: 'deep_research',
        description: 'AI-powered deep research via You.com. Returns a synthesized answer with citations. Use for complex investigative questions that need multi-source synthesis. Much more thorough than basic search — use when you need a comprehensive answer, not just links.',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Research question — be specific and detailed' },
            effort: { type: 'string', enum: ['lite', 'standard', 'deep', 'exhaustive'], description: 'Research depth: lite (fast) → exhaustive (thorough). Default: deep' },
          },
          required: ['query'],
        },
      },
      {
        name: 'pdf_extract',
        description: 'Extract text from a PDF file (URL or local path). Use for SEC filings, financial disclosures, court documents, government reports. Returns full text content.',
        input_schema: {
          type: 'object' as const,
          properties: {
            source: { type: 'string', description: 'PDF URL (https://...) or local file path' },
          },
          required: ['source'],
        },
      },
    ];
  }

  private buildSystem(knowledge: string, patterns: string): string {
    const skillContext = this.ctx.skills.buildSkillContext(
      this.def.type,
      this.ctx.focus,
      this.ctx.focus ? [this.ctx.focus] : undefined
    );

    return `You are a ${this.def.type} research agent. ${this.def.description}

## CRITICAL: Token Efficiency Rules
1. ALWAYS use check_knowledge before web_search — never research what's already known
2. Return findings as JSON array — no prose summaries
3. Stop when you have strong findings or budget is low
4. Each finding: { "claim": "...", "evidence": "STRONG|BULLETPROOF|CIRCUMSTANTIAL|DEVELOPING", "impact": "CRITICAL|HIGH|MODERATE|LOW", "sources": [{"url": "...", "title": "...", "grade": "A|B|C"}], "tags": ["tag1"] }
5. Use web_scrape for important primary sources (government databases, SEC filings, court records). Use web_fetch for quick checks.
6. Use deep_research for complex questions that need multi-source synthesis (e.g., "What are the financial ties between X and Y?"). It returns citations.
7. Use you_search with searchType:"news" for recent news coverage. Use web_search for general queries.

## Data Sources
${this.def.dataSources.map(d => `- ${d}`).join('\n')}

## Search Strategies
${this.def.searchStrategies.map(s => `- ${s}`).join('\n')}

## Current Knowledge (L0)
${knowledge}

## Learned Patterns
${patterns}

${skillContext}`;
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

}
