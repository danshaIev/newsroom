import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { KnowledgeStore } from './knowledge/store.js';
import { DeltaComputer } from './knowledge/delta.js';
import { ContextBuilder } from './tokens/context.js';
import { TokenTracker } from './tokens/budget.js';
import { FetchCache } from './tokens/cache.js';
import { PatternLearner } from './patterns/learner.js';
import { AgentRegistry } from './agents/registry.js';
import { BaseAgent, type AgentContext } from './agents/base.js';
import type { SubjectConfig } from './config.js';

const DEFAULT_TOKEN_BUDGET = 50_000;

export class Orchestrator {
  private store: KnowledgeStore;
  private delta: DeltaComputer;
  private contextBuilder: ContextBuilder;
  private tokenTracker: TokenTracker;
  private cache: FetchCache;
  private patterns: PatternLearner;
  private registry: AgentRegistry;
  private client: Anthropic;

  constructor(
    private projectDir: string,
    private config: SubjectConfig,
    private definitionsDir: string,
  ) {
    this.store = new KnowledgeStore(projectDir);
    this.delta = new DeltaComputer(this.store);
    this.contextBuilder = new ContextBuilder(this.store);
    this.tokenTracker = new TokenTracker();
    this.cache = new FetchCache(projectDir);
    this.patterns = new PatternLearner(projectDir);
    this.registry = new AgentRegistry(definitionsDir);
    this.client = new Anthropic();
  }

  async runWave(options: {
    wave: number;
    agents?: string[];
    focus?: string;
    tokenBudget?: number;
  }): Promise<void> {
    const { wave, focus, tokenBudget = DEFAULT_TOKEN_BUDGET } = options;
    const agentTypes = options.agents ?? this.registry.types();

    console.log(chalk.bold(`\n=== Wave ${wave} ===`));
    console.log(`Subject: ${this.config.name}`);
    console.log(`Agents: ${agentTypes.join(', ')}`);
    console.log(`Token budget: ${tokenBudget.toLocaleString()} per agent`);
    if (focus) console.log(`Focus: ${focus}`);
    console.log();

    // Phase 1: Plan — gap analysis + pattern guidance
    const existingCount = this.store.allFindings().length;
    const staleCount = this.delta.staleItems().length;
    console.log(chalk.dim(`Knowledge: ${existingCount} findings (${staleCount} stale)`));
    console.log(chalk.dim(`Patterns: ${this.patterns.digest().split('\n').length} learned observations`));
    console.log();

    // Phase 2: Execute — parallel agents
    const results = await Promise.allSettled(
      agentTypes.map(async (type) => {
        const def = this.registry.get(type);
        if (!def) {
          console.log(chalk.red(`Unknown agent type: ${type}`));
          return [];
        }

        const budget = this.tokenTracker.createBudget(type, tokenBudget);
        const ctx: AgentContext = {
          subject: this.config.name,
          focus,
          wave,
          knowledge: this.store,
          contextBuilder: this.contextBuilder,
          delta: this.delta,
          patterns: this.patterns,
          budget,
          cache: this.cache,
          client: this.client,
        };

        console.log(chalk.blue(`[${type}] Starting research...`));
        const agent = new BaseAgent(def, ctx);
        const output = await agent.research();
        console.log(chalk.green(`[${type}] Found ${output.findings.length} findings (${output.tokensUsed} tokens)`));
        return output.findings;
      })
    );

    // Phase 3: Ingest — add findings to knowledge store
    let newFindings = 0;
    let duplicates = 0;
    const allFindings = results.flatMap(r =>
      r.status === 'fulfilled' ? r.value : []
    );

    for (const finding of allFindings) {
      const added = this.store.addFinding(finding);
      if (added) newFindings++;
      else duplicates++;
    }

    console.log(chalk.bold(`\nWave ${wave} Results:`));
    console.log(`  New findings: ${newFindings}`);
    console.log(`  Duplicates skipped: ${duplicates}`);
    console.log(`  Total in store: ${this.store.allFindings().length}`);

    // Phase 4: Learn — extract patterns
    this.patterns.learn(allFindings, wave);
    console.log(chalk.dim(`  Patterns updated`));

    // Phase 5: Summarize — update index
    this.store.writeIndex();

    // Token report
    this.tokenTracker.endWave();
    console.log(chalk.dim(`\n${this.tokenTracker.report()}`));
    console.log(chalk.dim(this.cache.stats()));
  }

  async runMultipleWaves(count: number, options: { agents?: string[]; focus?: string }) {
    for (let i = 1; i <= count; i++) {
      await this.runWave({ wave: i, ...options });
      if (i < count) {
        console.log(chalk.dim('\n--- Preparing next wave (patterns applied) ---\n'));
      }
    }
  }

  getStore(): KnowledgeStore {
    return this.store;
  }

  getPatterns(): PatternLearner {
    return this.patterns;
  }
}
