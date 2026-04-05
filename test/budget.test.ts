import { describe, it, expect } from 'vitest';
import { TokenBudget, TokenTracker } from '../src/tokens/budget.js';

describe('TokenBudget', () => {
  it('tracks token usage', () => {
    const budget = new TokenBudget('test', 10000);
    budget.track('op1', 3000);
    expect(budget.remaining).toBe(7000);
    expect(budget.total).toBe(3000);
  });

  it('should NOT terminate when above 10% remaining', () => {
    const budget = new TokenBudget('test', 10000);
    budget.track('op1', 8000);
    // 2000 remaining = 20% > 10%
    expect(budget.shouldTerminate()).toBe(false);
  });

  it('should terminate when below 10% remaining', () => {
    const budget = new TokenBudget('test', 10000);
    budget.track('op1', 9500);
    // 500 remaining = 5% < 10%
    expect(budget.shouldTerminate()).toBe(true);
  });

  it('should terminate at exactly 10% boundary', () => {
    const budget = new TokenBudget('test', 10000);
    budget.track('op1', 9000);
    // 1000 remaining = exactly 10% → 1000 < 1000 is false
    expect(budget.shouldTerminate()).toBe(false);
  });

  it('remaining never goes below 0', () => {
    const budget = new TokenBudget('test', 10000);
    budget.track('op1', 15000);
    expect(budget.remaining).toBe(0);
  });

  it('generates a usage report', () => {
    const budget = new TokenBudget('finint', 50000);
    budget.track('search', 10000);
    const report = budget.report();
    expect(report).toContain('finint');
    expect(report).toContain('10000');
    expect(report).toContain('50000');
  });
});

describe('TokenTracker', () => {
  it('creates budgets and reports', () => {
    const tracker = new TokenTracker();
    const b1 = tracker.createBudget('finint', 50000);
    const b2 = tracker.createBudget('osint', 50000);
    b1.track('op', 10000);
    b2.track('op', 20000);
    tracker.endWave();

    const report = tracker.report();
    expect(report).toContain('finint');
    expect(report).toContain('osint');
  });

  it('tracks efficiency across waves', () => {
    const tracker = new TokenTracker();
    const b1 = tracker.createBudget('agent', 50000);
    b1.track('op', 30000);
    tracker.endWave();

    const b2 = tracker.createBudget('agent', 50000);
    b2.track('op', 20000);
    tracker.endWave();

    expect(tracker.efficiencyTrend()).toContain('more efficient');
  });
});
