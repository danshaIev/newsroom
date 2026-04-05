import chalk from 'chalk';
import type { AgentDefinition, AgentContext, AgentOutput } from './base.js';
import { AgentExecutor } from './executor.js';
import { createLogger } from '../utils/logger.js';

export type AgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'retrying';

export interface AgentRun {
  id: string;
  type: string;
  status: AgentStatus;
  startedAt?: string;
  completedAt?: string;
  findings: number;
  tokensUsed: number;
  searches: number;
  cacheHits: number;
  error?: string;
  retries: number;
  duration?: number;
}

/**
 * Manages agent lifecycle: launch, track, retry, report.
 * Replaces raw Promise.allSettled with structured management.
 */
export class AgentManager {
  private runs: Map<string, AgentRun> = new Map();
  private history: AgentRun[] = [];
  private runCounter = 0;
  private log = createLogger('agent-manager');

  /** Launch a single agent with tracking */
  async launch(
    def: AgentDefinition,
    ctx: AgentContext,
    options?: { maxRetries?: number }
  ): Promise<AgentOutput> {
    const maxRetries = options?.maxRetries ?? 1;
    const runId = `${def.type}-${++this.runCounter}`;

    const run: AgentRun = {
      id: runId,
      type: def.type,
      status: 'pending',
      findings: 0,
      tokensUsed: 0,
      searches: 0,
      cacheHits: 0,
      retries: 0,
    };
    this.runs.set(runId, run);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        run.status = attempt > 0 ? 'retrying' : 'running';
        run.startedAt = new Date().toISOString();
        run.retries = attempt;

        this.logStatus(run);

        const executor = new AgentExecutor(def, ctx);
        const output = await executor.execute();

        run.status = 'completed';
        run.completedAt = new Date().toISOString();
        run.findings = output.findings.length;
        run.tokensUsed = output.tokensUsed;
        run.searches = output.searchesPerformed;
        run.cacheHits = output.cacheHits;
        run.duration = Date.now() - new Date(run.startedAt).getTime();

        this.logComplete(run);
        this.history.push({ ...run });
        return output;
      } catch (e) {
        run.error = e instanceof Error ? e.message : 'Unknown error';
        this.log.warn({ agent: def.type, attempt, error: run.error }, 'Agent execution failed');
        if (attempt < maxRetries) {
          console.log(chalk.yellow(`  [${def.type}] Retry ${attempt + 1}/${maxRetries}: ${run.error}`));
          await this.backoff(attempt);
        }
      }
    }

    run.status = 'failed';
    run.completedAt = new Date().toISOString();
    this.logFailed(run);
    this.history.push({ ...run });

    return { findings: [], tokensUsed: run.tokensUsed, searchesPerformed: run.searches, cacheHits: run.cacheHits };
  }

  /** Launch multiple agents in parallel with concurrency control */
  async launchParallel(
    agents: Array<{ def: AgentDefinition; ctx: AgentContext }>,
    options?: { maxConcurrency?: number; maxRetries?: number }
  ): Promise<Map<string, AgentOutput>> {
    const maxConcurrency = options?.maxConcurrency ?? agents.length;
    const results = new Map<string, AgentOutput>();

    // Chunk agents by concurrency limit
    for (let i = 0; i < agents.length; i += maxConcurrency) {
      const batch = agents.slice(i, i + maxConcurrency);
      const outputs = await Promise.allSettled(
        batch.map(({ def, ctx }) => this.launch(def, ctx, { maxRetries: options?.maxRetries }))
      );
      batch.forEach(({ def }, idx) => {
        const result = outputs[idx];
        results.set(def.type, result.status === 'fulfilled'
          ? result.value
          : { findings: [], tokensUsed: 0, searchesPerformed: 0, cacheHits: 0 }
        );
      });
    }

    return results;
  }

  /** Real-time status of all active runs */
  activeStatus(): string {
    const active = [...this.runs.values()].filter(r => r.status === 'running' || r.status === 'retrying');
    if (active.length === 0) return 'No active agents';
    return active.map(r => {
      const elapsed = r.startedAt ? Math.round((Date.now() - new Date(r.startedAt).getTime()) / 1000) : 0;
      return `  ${this.statusIcon(r.status)} ${r.type} — ${elapsed}s elapsed, ${r.findings} findings`;
    }).join('\n');
  }

  /** Full run history summary */
  summary(): string {
    if (this.history.length === 0) return 'No agent runs yet.';

    const completed = this.history.filter(r => r.status === 'completed');
    const failed = this.history.filter(r => r.status === 'failed');
    const totalFindings = completed.reduce((sum, r) => sum + r.findings, 0);
    const totalTokens = this.history.reduce((sum, r) => sum + r.tokensUsed, 0);
    const avgDuration = completed.length > 0
      ? Math.round(completed.reduce((sum, r) => sum + (r.duration ?? 0), 0) / completed.length / 1000)
      : 0;

    const lines = [
      chalk.bold('Agent Manager Summary'),
      `  Runs: ${completed.length} completed, ${failed.length} failed`,
      `  Findings: ${totalFindings} total`,
      `  Tokens: ${totalTokens.toLocaleString()} total`,
      `  Avg duration: ${avgDuration}s`,
      '',
      ...this.history.map(r =>
        `  ${this.statusIcon(r.status)} ${r.id}: ${r.findings} findings, ${r.tokensUsed} tokens${r.duration ? ` (${Math.round(r.duration / 1000)}s)` : ''}${r.error ? ` — ${r.error}` : ''}`
      ),
    ];

    return lines.join('\n');
  }

  getHistory(): AgentRun[] {
    return [...this.history];
  }

  private async backoff(attempt: number) {
    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
    await new Promise(r => setTimeout(r, delay));
  }

  private statusIcon(status: AgentStatus): string {
    switch (status) {
      case 'pending': return chalk.dim('○');
      case 'running': return chalk.blue('●');
      case 'completed': return chalk.green('✓');
      case 'failed': return chalk.red('✗');
      case 'retrying': return chalk.yellow('↻');
    }
  }

  private logStatus(run: AgentRun) {
    console.log(chalk.blue(`  ${this.statusIcon(run.status)} [${run.type}] Starting research...`));
  }

  private logComplete(run: AgentRun) {
    console.log(chalk.green(`  ${this.statusIcon(run.status)} [${run.type}] ${run.findings} findings (${run.tokensUsed} tokens, ${run.cacheHits} cache hits, ${Math.round((run.duration ?? 0) / 1000)}s)`));
  }

  private logFailed(run: AgentRun) {
    console.log(chalk.red(`  ${this.statusIcon(run.status)} [${run.type}] Failed after ${run.retries} retries: ${run.error}`));
  }
}
