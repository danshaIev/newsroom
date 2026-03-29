# newsroom

AI investigative research platform. Multi-agent newsroom with pattern learning and token optimization.

Point it at a subject. It runs parallel specialized agents — financial intelligence, OSINT, legislative analysis, timeline correlation, fact-checking. Agents learn what works across research waves and get smarter over time. Outputs sourced, graded PDF reports.

## Quick start

```bash
git clone https://github.com/danshaIev/newsroom.git
cd newsroom
npm install
npm run build

# Set your API keys
export ANTHROPIC_API_KEY=sk-ant-...
export BRAVE_API_KEY=BSA...  # optional, enables web search

# Initialize an investigation
newsroom init "Ro Khanna" --type politician

# Run research
newsroom research --waves 3 --focus "stock trading conflicts"

# Fact-check everything
newsroom factcheck

# Generate report
newsroom report --format pdf

# See what the system learned
newsroom patterns
```

## CLI reference

| Command | Description |
|---------|-------------|
| `newsroom init <name>` | Initialize a new investigation |
| `newsroom research` | Run a research wave |
| `newsroom factcheck` | Verify existing findings against primary sources |
| `newsroom report` | Generate HTML/PDF report from findings |
| `newsroom patterns` | Show learned research patterns |
| `newsroom status` | Show investigation status and knowledge store stats |

### `newsroom init`

```bash
newsroom init "Subject Name" --type politician|company|person|organization
                              --description "Optional context"
```

Creates `.newsroom/` directory with config, empty knowledge store, and initial patterns file.

### `newsroom research`

```bash
newsroom research --waves 3          # Run 3 consecutive waves
                  --agents finint,osint  # Only run these agent types
                  --focus "campaign finance"  # Focus area
                  --budget 50000     # Token budget per agent
```

Each wave follows the loop: **plan** (gap analysis) -> **execute** (parallel agents) -> **ingest** (dedup findings) -> **learn** (extract patterns) -> **summarize** (compress for next wave).

### `newsroom report`

```bash
newsroom report --format pdf    # or html
                --output report.pdf
```

Generates a sourced report from all findings in the knowledge store. Findings sorted by evidence grade x impact. All claims have clickable source links.

## Architecture

```
plan wave (gap analysis + patterns)
  |
  v
execute agents in parallel (each with token budget)
  |
  v
ingest findings (dedup, grade, store as JSONL)
  |
  v
cross-reference (find connections between findings)
  |
  v
learn (extract patterns from what worked)
  |
  v
patterns.md feeds into next wave
```

### Agent types

Six specialized agents, defined as YAML files in `src/agents/definitions/`:

| Agent | Focus | Data sources |
|-------|-------|-------------|
| **finint** | Financial conflicts, trading patterns, campaign finance | FEC, SEC EDGAR, Capitol Trades, OpenSecrets |
| **osint** | Public records, news, social media, leaked documents | News archives, property records, IRS 990s, WikiLeaks |
| **legint** | Bills, votes, effectiveness rankings, earmarks | Congress.gov, GovTrack, Center for Effective Lawmaking |
| **temporal** | Timeline reconstruction, suspicious timing correlations | Trade dates vs hearing dates, donations vs votes |
| **crossref** | Fact-checking, contradiction detection, quality gate | All sources (verification), PolitiFact, primary records |
| **reporter** | Report synthesis from findings | Knowledge store |

**Adding a new agent type:** Drop a YAML file in `src/agents/definitions/`. The YAML defines the agent's name, description, system prompt, data sources, and search strategies. No TypeScript needed.

```yaml
# src/agents/definitions/my-agent.yaml
name: My Custom Agent
type: myagent
description: What this agent investigates
systemPrompt: You are a...
dataSources:
  - Source 1
  - Source 2
searchStrategies:
  - Strategy 1
outputFormat: findings
```

### Knowledge store

JSONL append-only storage in `.newsroom/knowledge/`. Three file types:

- `findings.jsonl` — Research findings with evidence grades, sources, tags
- `entities.jsonl` — People, organizations, companies
- `relationships.jsonl` — Connections between entities with evidence

Each finding has:
- **Evidence grade**: `BULLETPROOF` > `STRONG` > `CIRCUMSTANTIAL` > `DEVELOPING`
- **Impact rating**: `CRITICAL` > `HIGH` > `MODERATE` > `LOW`
- **Sources**: URL, title, access date, source grade (A/B/C/D)
- **Staleness date**: Auto-flags for re-verification after 30 days
- **Deduplication**: Claims with >80% word overlap are merged, upgrading the grade if the new evidence is stronger

### Pattern learning

The core ML-first feature. After each wave, `PatternLearner` extracts:

- **Source reliability** — Which domains produced Grade-A findings? (e.g., "fec.gov: 5 Grade-A sources this wave")
- **Cross-reference patterns** — Which tag combinations yielded strong findings? (e.g., "Cross-referencing stock-trading and committee-hearings yielded 3 strong+ findings")
- **Subject-specific observations** — Key findings that inform future research

These are written to `.newsroom/patterns.md` and `.newsroom/patterns.jsonl`. Every agent reads the pattern digest (~500 tokens) before starting work. Effect: agents search in productive places first, avoid dead ends, and build on prior waves instead of starting from scratch.

**Wave 1**: Agent searches broadly, finds FEC.gov is reliable for financial claims.
**Wave 2**: Agent reads pattern, goes to FEC.gov first, finds more with fewer searches.
**Wave 3**: Agent has 10+ patterns, is highly targeted, uses 40% fewer tokens.

### Token optimization

Seven mechanisms to reduce token waste:

| Mechanism | How it works | Savings |
|-----------|-------------|---------|
| **Tiered context** | L0: 500-token summary. L1: findings list. L2: full evidence. Agents start at L0. | ~60-80% vs dumping everything |
| **Research delta** | `check_knowledge` tool — agents verify a claim exists before searching | Eliminates redundant research |
| **Shared cache** | Same URL/query returns cached result across all agents in a wave | Eliminates duplicate fetches |
| **Token budgets** | Each agent has a per-wave limit with early termination | Prevents runaway agents |
| **Structured handoffs** | JSON findings, not prose paragraphs | ~60% smaller than prose |
| **Pattern-guided search** | Agents read patterns first, search productive sources first | Fewer wasted searches |
| **Content truncation** | web_fetch returns first 4000 chars, stripped of HTML/scripts | Prevents context bloat |

### Tools available to agents

| Tool | Purpose | Token impact |
|------|---------|-------------|
| `check_knowledge` | Check if claim already exists. **Must use before web_search.** | Saves full search when claim is known |
| `web_search` | Search via Brave API. Results cached. | 5 results, ~500 tokens |
| `web_fetch` | Fetch a URL, strip HTML, return text. Cached. | Truncated to ~4000 chars |

## Project structure

```
newsroom/
├── src/
│   ├── index.ts              # CLI entry point (Commander.js)
│   ├── orchestrator.ts       # Wave loop: plan -> execute -> ingest -> learn
│   ├── config.ts             # Project init and config management
│   ├── agents/
│   │   ├── base.ts           # Base agent class (single-shot)
│   │   ├── executor.ts       # Agentic executor (multi-turn tool loop)
│   │   ├── registry.ts       # Load agent definitions from YAML
│   │   └── definitions/      # YAML agent type definitions
│   │       ├── finint.yaml
│   │       ├── osint.yaml
│   │       ├── legint.yaml
│   │       ├── temporal.yaml
│   │       ├── crossref.yaml
│   │       └── reporter.yaml
│   ├── knowledge/
│   │   ├── schema.ts         # TypeScript types (Finding, Entity, Relationship)
│   │   ├── store.ts          # JSONL append-only store with dedup + index
│   │   └── delta.ts          # Research gap computation
│   ├── patterns/
│   │   └── learner.ts        # Pattern extraction + digest generation
│   ├── tokens/
│   │   ├── budget.ts         # Per-agent token budgets + efficiency tracking
│   │   ├── context.ts        # Tiered context builder (L0/L1/L2)
│   │   └── cache.ts          # Shared web fetch/search cache
│   ├── tools/
│   │   └── search.ts         # Brave Search API + web fetch
│   └── report/
│       └── generator.ts      # Findings -> HTML -> PDF pipeline
├── package.json
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `BRAVE_API_KEY` | No | Brave Search API key. Without it, web_search logs queries but returns no results. |

## Use cases

- **Opposition research** — Investigate a politician's voting record, financial conflicts, donor networks
- **Corporate due diligence** — Map a company's ownership structure, regulatory violations, executive conflicts
- **Investigative journalism** — Multi-source fact-checking, timeline reconstruction, pattern detection
- **Compliance research** — Track financial disclosures, identify undisclosed conflicts, verify claims

## How findings are graded

| Grade | Standard | Example |
|-------|----------|---------|
| **BULLETPROOF** | Multiple primary sources, publicly verifiable, no reasonable rebuttal | SEC filing + FEC record + financial disclosure all confirm the same fact |
| **STRONG** | Single primary source + corroboration, or multiple credible secondary sources | News investigation confirmed by public records |
| **CIRCUMSTANTIAL** | Pattern-based, requires inference, multiple data points | Trade timing correlates with committee hearings but could be coincidence |
| **DEVELOPING** | Single source, unconfirmed, promising lead | One news report without corroboration |

## License

MIT
