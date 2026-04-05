import { createLogger } from './logger.js';

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitConfig {
  /** Number of consecutive failures before opening the circuit */
  failureThreshold: number;
  /** Milliseconds to wait before trying again (half-open) */
  cooldownMs: number;
  /** Name for logging */
  name: string;
}

const DEFAULT_CONFIG: Omit<CircuitConfig, 'name'> = {
  failureThreshold: 3,
  cooldownMs: 60_000,
};

const log = createLogger('circuit-breaker');

/**
 * Circuit breaker pattern for external API calls.
 * Prevents cascading failures when a service is down.
 *
 * States:
 * - CLOSED: normal operation, requests pass through
 * - OPEN: service is down, requests fail immediately (no API call)
 * - HALF-OPEN: cooldown elapsed, allow one probe request
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  private config: CircuitConfig;

  constructor(name: string, config?: Partial<Omit<CircuitConfig, 'name'>>) {
    this.config = { ...DEFAULT_CONFIG, name, ...config };
  }

  /** Check if a request should be allowed */
  canExecute(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.cooldownMs) {
        this.state = 'half-open';
        log.info({ service: this.config.name }, 'Circuit half-open, allowing probe request');
        return true;
      }
      return false;
    }
    // half-open: allow one request
    return true;
  }

  /** Record a successful call */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      log.info({ service: this.config.name }, 'Circuit closed after successful probe');
    }
    this.failures = 0;
    this.state = 'closed';
  }

  /** Record a failed call */
  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.state = 'open';
      log.warn({ service: this.config.name, failures: this.failures }, 'Circuit re-opened after failed probe');
      return;
    }

    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
      log.warn(
        { service: this.config.name, failures: this.failures, cooldownMs: this.config.cooldownMs },
        'Circuit opened — service appears down',
      );
    }
  }

  /** Execute a function with circuit breaker protection */
  async execute<T>(fn: () => Promise<T>, fallback?: () => T): Promise<T> {
    if (!this.canExecute()) {
      if (fallback) return fallback();
      throw new CircuitOpenError(this.config.name, this.remainingCooldown());
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (e) {
      this.recordFailure();
      throw e;
    }
  }

  get currentState(): CircuitState { return this.state; }
  get failureCount(): number { return this.failures; }

  private remainingCooldown(): number {
    return Math.max(0, this.config.cooldownMs - (Date.now() - this.lastFailureTime));
  }

  status(): string {
    return `${this.config.name}: ${this.state} (${this.failures} failures)`;
  }
}

export class CircuitOpenError extends Error {
  constructor(service: string, remainingMs: number) {
    super(`Circuit open for ${service} — retry in ${Math.ceil(remainingMs / 1000)}s`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Registry of circuit breakers for all external services.
 * Singleton — shared across all agents in a wave.
 */
class CircuitRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  get(name: string, config?: Partial<Omit<CircuitConfig, 'name'>>): CircuitBreaker {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker(name, config));
    }
    return this.breakers.get(name)!;
  }

  allStatus(): string {
    return [...this.breakers.values()].map(b => b.status()).join(' | ');
  }
}

export const circuits = new CircuitRegistry();
