import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import type { AgentDefinition } from './base.js';

/**
 * Load agent definitions from YAML files.
 * Adding a new agent type = adding a YAML file. No code changes needed.
 */
export class AgentRegistry {
  private definitions: Map<string, AgentDefinition> = new Map();

  constructor(definitionsDir: string) {
    this.loadAll(definitionsDir);
  }

  private loadAll(dir: string) {
    const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const def = parse(raw) as AgentDefinition;
      this.definitions.set(def.type, def);
    }
  }

  get(type: string): AgentDefinition | undefined {
    return this.definitions.get(type);
  }

  all(): AgentDefinition[] {
    return [...this.definitions.values()];
  }

  types(): string[] {
    return [...this.definitions.keys()];
  }
}
