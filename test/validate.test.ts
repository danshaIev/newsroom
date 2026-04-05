import { describe, it, expect } from 'vitest';
import { toolInput, assertString, assertOptionalString, assertOptionalBoolean, assertEnum, ToolInputError } from '../src/utils/validate.js';

describe('toolInput', () => {
  it('accepts valid objects', () => {
    expect(toolInput({ query: 'test' })).toEqual({ query: 'test' });
  });

  it('rejects null', () => {
    expect(() => toolInput(null)).toThrow(ToolInputError);
  });

  it('rejects non-objects', () => {
    expect(() => toolInput('string')).toThrow(ToolInputError);
    expect(() => toolInput(42)).toThrow(ToolInputError);
  });
});

describe('assertString', () => {
  it('accepts non-empty strings', () => {
    expect(assertString('hello', 'field')).toBe('hello');
  });

  it('rejects empty strings', () => {
    expect(() => assertString('', 'field')).toThrow(ToolInputError);
  });

  it('rejects non-strings', () => {
    expect(() => assertString(42, 'field')).toThrow(ToolInputError);
    expect(() => assertString(null, 'field')).toThrow(ToolInputError);
    expect(() => assertString(undefined, 'field')).toThrow(ToolInputError);
  });
});

describe('assertOptionalString', () => {
  it('accepts strings', () => {
    expect(assertOptionalString('hello', 'field')).toBe('hello');
  });

  it('returns undefined for null/undefined', () => {
    expect(assertOptionalString(undefined, 'field')).toBeUndefined();
    expect(assertOptionalString(null, 'field')).toBeUndefined();
  });

  it('rejects non-strings', () => {
    expect(() => assertOptionalString(42, 'field')).toThrow(ToolInputError);
  });
});

describe('assertOptionalBoolean', () => {
  it('accepts booleans', () => {
    expect(assertOptionalBoolean(true, 'field')).toBe(true);
    expect(assertOptionalBoolean(false, 'field')).toBe(false);
  });

  it('returns undefined for null/undefined', () => {
    expect(assertOptionalBoolean(undefined, 'field')).toBeUndefined();
  });

  it('rejects non-booleans', () => {
    expect(() => assertOptionalBoolean('true', 'field')).toThrow(ToolInputError);
  });
});

describe('assertEnum', () => {
  it('accepts valid enum values', () => {
    expect(assertEnum('web', 'field', ['web', 'news'] as const)).toBe('web');
  });

  it('returns undefined for null/undefined', () => {
    expect(assertEnum(undefined, 'field', ['web', 'news'] as const)).toBeUndefined();
  });

  it('rejects invalid values', () => {
    expect(() => assertEnum('invalid', 'field', ['web', 'news'] as const)).toThrow(ToolInputError);
  });
});
