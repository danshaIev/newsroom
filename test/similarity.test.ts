import { describe, it, expect } from 'vitest';
import { wordSimilarity, extractDomain } from '../src/utils/similarity.js';

describe('wordSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(wordSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(wordSimilarity('hello world', 'foo bar')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(wordSimilarity('Hello World', 'hello world')).toBe(1);
  });

  it('returns correct ratio for partial overlap', () => {
    const sim = wordSimilarity('the quick brown fox', 'the slow brown dog');
    // intersection: {the, brown} = 2, max(4, 4) = 4 → 0.5
    expect(sim).toBe(0.5);
  });

  it('exceeds 0.8 threshold for near-duplicates (knowledge store dedup)', () => {
    const sim = wordSimilarity(
      'Senator John Smith received campaign contributions from oil companies',
      'Senator John Smith received large campaign contributions from major oil companies',
    );
    expect(sim).toBeGreaterThan(0.8);
  });

  it('falls below 0.8 for genuinely different claims', () => {
    const sim = wordSimilarity(
      'Senator Smith voted against the climate bill',
      'Governor Jones supported renewable energy initiatives',
    );
    expect(sim).toBeLessThan(0.5);
  });
});

describe('extractDomain', () => {
  it('extracts domain from URL', () => {
    expect(extractDomain('https://www.example.com/path')).toBe('example.com');
  });

  it('strips www prefix', () => {
    expect(extractDomain('https://www.sec.gov/cgi-bin/browse-edgar')).toBe('sec.gov');
  });

  it('returns input for invalid URLs', () => {
    expect(extractDomain('not-a-url')).toBe('not-a-url');
  });

  it('handles URLs without www', () => {
    expect(extractDomain('https://api.example.com/v1')).toBe('api.example.com');
  });
});
