import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { createLogger } from './utils/logger.js';
import { KnowledgeStore } from './knowledge/store.js';
import { DeltaComputer } from './knowledge/delta.js';
import { ContextBuilder } from './tokens/context.js';
import { TokenTracker } from './tokens/budget.js';
import { FetchCache } from './tokens/cache.js';
import { PatternLearner } from './patterns/learner.js';
import { AgentRegistry } from './agents/registry.js';
import { AgentManager } from './agents/manager.js';
import { SkillEngine } from './learning/skills.js';
import { TokenOptimizer } from './tokens/optimizer.js';
import type { AgentContext } from './agents/base.js';
import type { SubjectConfig, ProjectConfig } from './config.js';

const DEFAULT_TOKEN_BUDGET = 50_000;

export class Orchestrator {
  private store: KnowledgeStore;
  private delta: DeltaComputer;
  private contextBuilder: ContextBuilder;
  private tokenTracker: TokenTracker;
  private cache: FetchCache;
  private patterns: PatternLearner;
  private registry: AgentRegistry;
  private manager: AgentManager;
  private skills: SkillEngine;
  private optimizer: TokenOptimizer;
  private client: Anthropic;
  private log = createLogger('orchestrator');

  private model: string;

  constructor(
    private projectDir: string,
    private config: SubjectConfig,
    private definitionsDir: string,
    settings?: ProjectConfig['settings'],
  ) {
    this.model = settings?.model ?? 'claude-sonnet-4-20250514';
    this.store = new KnowledgeStore(projectDir);
    this.delta = new DeltaComputer(this.store);
    this.contextBuilder = new ContextBuilder(this.store);
    this.tokenTracker = new TokenTracker();
    this.cache = new FetchCache(projectDir);
    this.patterns = new PatternLearner(projectDir);
    this.registry = new AgentRegistry(definitionsDir);
    this.manager = new AgentManager();
    this.skills = new SkillEngine(projectDir);
    this.optimizer = new TokenOptimizer(projectDir);
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

    this.log.info({ wave, agents: agentTypes, tokenBudget, focus }, `Wave ${wave} starting`);
    console.log(chalk.bold(`\n=== Wave ${wave} ===`));
    console.log(`Subject: ${this.config.name}`);
    console.log(`Agents: ${agentTypes.join(', ')}`);
    console.log(`Token budget: ${tokenBudget.toLocaleString()} per agent`);
    if (focus) console.log(`Focus: ${focus}`);
    console.log();

    // Phase 1: Plan — gap analysis + pattern guidance + skill review
    const existingCount = this.store.allFindings().length;
    const staleCount = this.delta.staleItems().length;
    console.log(chalk.dim(`Knowledge: ${existingCount} findings (${staleCount} stale)`));
    console.log(chalk.dim(`Patterns: ${this.patterns.digest().split('\n').length} learned observations`));

    // Show skill status for each agent
    for (const type of agentTypes) {
      const profile = this.skills.getProfile(type);
      const instincts = profile.skills.filter(s => s.confidence >= 0.7).length;
      const developing = profile.skills.filter(s => s.confidence >= 0.3 && s.confidence < 0.7).length;
      if (instincts > 0 || developing > 0) {
        console.log(chalk.dim(`Skills [${type}]: ${instincts} instincts, ${developing} developing`));
      }
    }
    console.log();

    // Phase 2: Execute — parallel agents via AgentManager
    const agentConfigs = agentTypes.map(type => {
      const def = this.registry.get(type);
      if (!def) {
        console.log(chalk.red(`Unknown agent type: ${type}`));
        return null;
      }

      const budget = this.tokenTracker.createBudget(type, tokenBudget);
      const ctx: AgentContext = {
        subject: this.config.name,
        focus,
        wave,
        model: this.model,
        knowledge: this.store,
        contextBuilder: this.contextBuilder,
        delta: this.delta,
        patterns: this.patterns,
        skills: this.skills,
        budget,
        cache: this.cache,
        client: this.client,
      };

      return { def, ctx };
    }).filter((c): c is { def: NonNullable<typeof c>['def']; ctx: AgentContext } => c !== null);

    const results = await this.manager.launchParallel(
      agentConfigs as Array<{ def: NonNullable<(typeof agentConfigs)[0]>['def']; ctx: AgentContext }>,
      { maxRetries: 1 }
    );

    // Phase 3: Ingest — add findings to knowledge store
    let newFindings = 0;
    let duplicates = 0;

    for (const [agentType, output] of results) {
      for (const finding of output.findings) {
        const added = this.store.addFinding(finding);
        if (added) newFindings++;
        else duplicates++;
      }

      // Phase 4: Learn — update skills and patterns per agent
      this.skills.learn(agentType, output.findings, output.tokensUsed, wave);
    }

    this.log.info({ wave, newFindings, duplicates, total: this.store.allFindings().length }, `Wave ${wave} complete`);
    console.log(chalk.bold(`\nWave ${wave} Results:`));
    console.log(`  New findings: ${newFindings}`);
    console.log(`  Duplicates skipped: ${duplicates}`);
    console.log(`  Total in store: ${this.store.allFindings().length}`);

    // Pattern learning (cross-agent)
    const allFindings = [...results.values()].flatMap(o => o.findings);
    this.patterns.learn(allFindings, wave);
    console.log(chalk.dim(`  Patterns updated`));

    // Phase 5: Summarize — update index
    this.store.writeIndex();

    // Token report
    this.tokenTracker.endWave();
    console.log(chalk.dim(`\n${this.tokenTracker.report()}`));
    console.log(chalk.dim(this.cache.stats()));

    // Track usage
    const totalTokens = [...results.values()].reduce((sum, o) => sum + o.tokensUsed, 0);
    this.optimizer.track('claude', totalTokens);

    // Agent manager summary
    console.log(chalk.dim(`\n${this.manager.summary()}`));
    console.log(chalk.dim(this.optimizer.compactReport()));
  }

  async runMultipleWaves(count: number, options: { agents?: string[]; focus?: string }) {
    for (let i = 1; i <= count; i++) {
      await this.runWave({ wave: i, ...options });
      if (i < count) {
        console.log(chalk.dim('\n--- Preparing next wave (patterns + skills applied) ---\n'));
      }
    }
  }

  getStore(): KnowledgeStore {
    return this.store;
  }

  getPatterns(): PatternLearner {
    return this.patterns;
  }

  getSkills(): SkillEngine {
    return this.skills;
  }

  getManager(): AgentManager {
    return this.manager;
  }

  getOptimizer(): TokenOptimizer {
    return this.optimizer;
  }
}
