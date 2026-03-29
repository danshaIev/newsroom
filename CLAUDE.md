# Newsroom — AI Investigative Research Platform

## What This Is
Open-source CLI tool that runs parallel AI research agents to investigate subjects. Agents learn patterns across waves and get smarter over time. Built for investigative journalism, opposition research, due diligence, and corporate intelligence.

## Architecture
- `src/index.ts` — CLI entry (Commander.js)
- `src/orchestrator.ts` — Wave planning, parallel agent dispatch, learning loop
- `src/agents/base.ts` — Base agent with token budget, delta check, pattern reading
- `src/agents/registry.ts` — Loads agent definitions from YAML
- `src/agents/definitions/*.yaml` — Agent type definitions (finint, osint, legint, temporal, crossref, reporter)
- `src/knowledge/store.ts` — JSONL append-only knowledge store with materialized index
- `src/knowledge/schema.ts` — TypeScript types for findings, entities, relationships
- `src/knowledge/delta.ts` — Computes research gaps (what we don't know yet)
- `src/patterns/learner.ts` — Extracts patterns from completed waves, builds patterns.md
- `src/tokens/budget.ts` — Per-agent token budgets with early termination
- `src/tokens/context.ts` — Tiered context builder (L0/L1/L2)
- `src/tokens/cache.ts` — Shared web fetch cache across agents
- `src/report/generator.ts` — HTML + PDF report generation
- `src/config.ts` — Project initialization and configuration

## Key Concepts
- **Knowledge Store**: JSONL append-only. Findings, entities, relationships. Deduplication on ingest.
- **Research Delta**: Always check what we already know before searching. Only research gaps.
- **Pattern Learning**: After each wave, extract what worked. patterns.md feeds into next wave.
- **Token Budgets**: Each agent has a limit. Forces concision. Tracks efficiency across waves.
- **Tiered Context**: L0 (500 tokens) → L1 (2000 tokens) → L2 (full evidence). Agents start at L0.
- **Evidence Grades**: BULLETPROOF > STRONG > CIRCUMSTANTIAL > DEVELOPING

## Commands
```
newsroom init "Subject" --type politician
newsroom research --waves 3 --agents finint,osint --focus "stock trading"
newsroom factcheck
newsroom report --format pdf
newsroom patterns
newsroom status
```

## Adding New Agent Types
Create a YAML file in `src/agents/definitions/`. No code changes needed.

## Tech Stack
TypeScript, Anthropic Claude SDK, Commander.js, Puppeteer (PDF).
