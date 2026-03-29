# newsroom

AI investigative research platform. Multi-agent newsroom with pattern learning and token optimization.

## What it does

Point it at a subject. It runs parallel research agents (financial intelligence, OSINT, legislative analysis, timeline correlation, fact-checking). Agents learn what works across waves and get smarter over time. Outputs sourced PDF reports.

## Quick start

```bash
npm install
npm run build

# Initialize an investigation
newsroom init "Subject Name" --type politician

# Run research waves
newsroom research --waves 3 --focus "stock trading"

# Fact-check findings
newsroom factcheck

# Generate report
newsroom report --format pdf

# See what the system has learned
newsroom patterns
```

## How it works

### Multi-agent orchestration
Six specialized agent types run in parallel, each with a focused skill set:
- **finint** — Financial intelligence (FEC, SEC, trading data)
- **osint** — Open source intelligence (news, records, social)
- **legint** — Legislative analysis (bills, votes, effectiveness)
- **temporal** — Timeline correlation (trade-to-event timing)
- **crossref** — Fact-checking and contradiction detection
- **reporter** — Report synthesis

Add new agent types by dropping a YAML file in `src/agents/definitions/`. No code changes.

### Pattern learning (ML-first)
After each research wave, the system extracts what worked:
- Which sources produced high-grade findings
- Which cross-references yielded connections
- Which search strategies were productive
- Subject-specific observations

These patterns feed into `patterns.md`, which every agent reads before starting. Over time, agents search in the right places first, ask better questions, and waste fewer tokens.

### Token optimization
- **Tiered context**: Agents get a 500-token summary (L0) by default. Only escalate to full evidence (L2) when investigating a specific finding.
- **Research delta**: Always check existing knowledge before web search. Never re-research known facts.
- **Shared cache**: Same URL fetched once across all agents in a wave.
- **Token budgets**: Each agent has a max. Forces concision, enables early termination.
- **Structured handoffs**: JSON objects between agents, not prose.

### Knowledge store
JSONL append-only storage. Findings are graded (BULLETPROOF > STRONG > CIRCUMSTANTIAL > DEVELOPING), deduplicated on ingest, and indexed for fast retrieval. Stale findings are flagged for re-verification.

## Configuration

```bash
# .newsroom/config.json is created by `newsroom init`
# Customize default agents, token budgets, staleness thresholds
```

## Requirements

- Node.js 20+
- `ANTHROPIC_API_KEY` environment variable

## License

MIT
