/**
 * Runtime validation for tool inputs from LLM tool_use blocks.
 * Prevents unsafe casts like `tool.input as { query: string }`.
 */

export function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolInputError(`${field} must be a non-empty string`);
  }
  return value;
}

export function assertOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ToolInputError(`${field} must be a string`);
  }
  return value;
}

export function assertOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new ToolInputError(`${field} must be a boolean`);
  }
  return value;
}

export function assertEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ToolInputError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/** Safely extract and validate tool input as a record */
export function toolInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null) {
    throw new ToolInputError('Tool input must be an object');
  }
  return input as Record<string, unknown>;
}
