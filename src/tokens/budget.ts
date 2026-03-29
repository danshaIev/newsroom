/**
 * Token budget management. Each agent gets a budget per wave.
 * Forces concision and enables early termination.
 */
export class TokenBudget {
  private used: number = 0;
  private log: { agent: string; operation: string; tokens: number }[] = [];

  constructor(
    public readonly agent: string,
    public readonly limit: number
  ) {}

  track(operation: string, tokens: number) {
    this.used += tokens;
    this.log.push({ agent: this.agent, operation, tokens });
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  get total(): number {
    return this.used;
  }

  shouldTerminate(): boolean {
    return this.remaining < this.limit * 0.1;
  }

  report(): string {
    return `${this.agent}: ${this.used}/${this.limit} tokens (${Math.round(this.used / this.limit * 100)}%)`;
  }

  getLog() {
    return this.log;
  }
}

export class TokenTracker {
  private budgets: Map<string, TokenBudget> = new Map();
  private waveTokens: number[] = [];

  createBudget(agent: string, limit: number): TokenBudget {
    const budget = new TokenBudget(agent, limit);
    this.budgets.set(agent, budget);
    return budget;
  }

  endWave() {
    const total = [...this.budgets.values()].reduce((sum, b) => sum + b.total, 0);
    this.waveTokens.push(total);
  }

  /** Are we getting more efficient across waves? */
  efficiencyTrend(): string {
    if (this.waveTokens.length < 2) return 'insufficient data';
    const last = this.waveTokens[this.waveTokens.length - 1];
    const prev = this.waveTokens[this.waveTokens.length - 2];
    const delta = Math.round((last - prev) / prev * 100);
    return delta < 0 ? `${Math.abs(delta)}% more efficient` : `${delta}% more expensive`;
  }

  report(): string {
    const lines = [...this.budgets.values()].map(b => b.report());
    lines.push(`\nEfficiency: ${this.efficiencyTrend()}`);
    return lines.join('\n');
  }
}
