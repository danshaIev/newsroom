import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../src/utils/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test-service', { failureThreshold: 3, cooldownMs: 100 });
  });

  it('starts in closed state', () => {
    expect(breaker.currentState).toBe('closed');
    expect(breaker.canExecute()).toBe(true);
  });

  it('stays closed after fewer failures than threshold', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.currentState).toBe('closed');
    expect(breaker.canExecute()).toBe(true);
  });

  it('opens after reaching failure threshold', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.currentState).toBe('open');
    expect(breaker.canExecute()).toBe(false);
  });

  it('resets failure count on success', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.failureCount).toBe(0);
    expect(breaker.currentState).toBe('closed');
    // Now needs 3 more failures to open
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.currentState).toBe('closed');
  });

  it('transitions to half-open after cooldown', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.currentState).toBe('open');

    // Wait for cooldown
    await new Promise(r => setTimeout(r, 150));

    expect(breaker.canExecute()).toBe(true);
    expect(breaker.currentState).toBe('half-open');
  });

  it('closes on success during half-open', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    await new Promise(r => setTimeout(r, 150));
    breaker.canExecute(); // triggers half-open

    breaker.recordSuccess();
    expect(breaker.currentState).toBe('closed');
  });

  it('re-opens on failure during half-open', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    await new Promise(r => setTimeout(r, 150));
    breaker.canExecute(); // triggers half-open

    breaker.recordFailure();
    expect(breaker.currentState).toBe('open');
  });

  it('execute() runs function when closed', async () => {
    const result = await breaker.execute(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('execute() uses fallback when open', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    const result = await breaker.execute(
      async () => 'should not run',
      () => 'fallback',
    );
    expect(result).toBe('fallback');
  });

  it('execute() throws CircuitOpenError when open without fallback', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    await expect(breaker.execute(async () => 'x')).rejects.toThrow(CircuitOpenError);
  });

  it('execute() records failure on thrown error', async () => {
    await expect(
      breaker.execute(async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
    expect(breaker.failureCount).toBe(1);
  });

  it('produces a status string', () => {
    expect(breaker.status()).toContain('test-service');
    expect(breaker.status()).toContain('closed');
  });
});
