# Newsroom — AI Investigative Research Platform

## What This Is
Open-source CLI tool that runs parallel AI research agents to investigate subjects. Agents learn patterns across waves and get smarter over time. Built for investigative journalism, opposition research, due diligence, and corporate intelligence.

## Architecture
- `src/index.ts` — CLI entry (Commander.js), unhandled rejection handler
- `src/orchestrator.ts` — Wave planning, parallel agent dispatch, learning loop
- `src/agents/base.ts` — Base agent with token budget, delta check, pattern reading
- `src/agents/executor.ts` — Agentic executor with tool loop (8 tools), validated inputs
- `src/agents/manager.ts` — Agent lifecycle management (launch, track, retry, status)
- `src/agents/registry.ts` — Loads agent definitions from YAML
- `src/agents/definitions/*.yaml` — Agent type definitions (finint, osint, legint, temporal, crossref, reporter, netmap, regint)
- `src/learning/skills.ts` — Self-learning skill engine: per-agent profiles, auto-developing skills, instincts
- `src/knowledge/store.ts` — JSONL append-only knowledge store with materialized index + O(1) verdict/tag lookups
- `src/knowledge/schema.ts` — TypeScript types for findings, entities, relationships
- `src/knowledge/delta.ts` — Computes research gaps (what we don't know yet)
- `src/patterns/learner.ts` — Extracts patterns from completed waves, builds patterns.md
- `src/tokens/budget.ts` — Per-agent token budgets with early termination
- `src/tokens/context.ts` — Tiered context builder (L0/L1/L2)
- `src/tokens/cache.ts` — Shared web fetch cache across agents
- `src/tokens/optimizer.ts` — Cross-service API usage tracking with budgets and optimization rules
- `src/tools/crawl4ai.ts` — Crawl4AI integration: headless browser scraping + persistent worker pool
- `src/tools/search.ts` — Brave web search + basic fetch (circuit-breaker protected)
- `src/tools/youcom.ts` — You.com API: search, deep research, content extraction (circuit-breaker protected)
- `src/tools/security.ts` — URL validation (SSRF), path traversal prevention, HTML escaping, safe JSON extraction
- `src/tools/pdf-extract.ts` — PDF text extraction via Python (pymupdf/pdfplumber)
- `src/report/generator.ts` — HTML + PDF report generation
- `src/report/export.ts` — CSV export for findings, entities, verdicts
- `src/factcheck/pipeline.ts` — 5-stage institutional fact-check pipeline
- `src/factcheck/redteam.ts` — Adversarial red-team stress testing
- `src/messaging/voice.ts` — Voice profile system + 8 output formats
- `src/messaging/composer.ts` — Transforms findings into publishable content
- `src/config.ts` — Project initialization and configuration
- `src/utils/similarity.ts` — Shared word similarity + domain extraction
- `src/utils/parsing.ts` — Shared finding parser from LLM output
- `src/utils/fs.ts` — Atomic file writes (write .tmp → rename)
- `src/utils/validate.ts` — Runtime tool input validation
- `src/utils/logger.ts` — Structured logging (pino) with API key redaction
- `src/utils/circuit-breaker.ts` — Circuit breaker pattern for external APIs

## Key Concepts
- **Knowledge Store**: JSONL append-only. Findings, entities, relationships. Deduplication on ingest. O(1) indexed lookups by findingId and tag.
- **Research Delta**: Always check what we already know before searching. Only research gaps.
- **Pattern Learning**: After each wave, extract what worked. patterns.md feeds into next wave.
- **Self-Learning Skills**: Per-agent skill profiles that auto-develop through experience. Skills have triggers (when to fire) and actions (what to do). Confidence grows with successful use. High-confidence skills become "instincts" — always applied. Like muscle memory.
- **Agent Manager**: Lifecycle tracking, parallel launch with concurrency control, automatic retries with backoff, real-time status.
- **Crawl4AI**: Local headless browser scraping via Crawl4AI. Returns clean markdown from any page, including JS-rendered SPAs. No API keys, no limits. Persistent worker pool for fast successive scrapes.
- **Circuit Breaker**: 3 failures → open circuit → 60s cooldown. Applies to Brave, You.com, Crawl4AI, web fetch. Prevents cascading failures.
- **Token Budgets**: Each agent has a limit. Forces concision. Tracks efficiency across waves.
- **Tiered Context**: L0 (500 tokens) → L1 (2000 tokens) → L2 (full evidence). Agents start at L0.
- **Evidence Grades**: BULLETPROOF > STRONG > CIRCUMSTANTIAL > DEVELOPING
- **Model Config**: Model flows from ProjectConfig.settings.model through all components. Not hardcoded.

## Commands
```
newsroom init "Subject" --type politician
newsroom research --waves 3 --agents finint,osint --focus "stock trading"
newsroom factcheck                          # 5-stage institutional fact-check pipeline
newsroom factcheck -f F001                  # Fact-check a specific finding
newsroom factcheck --grade CIRCUMSTANTIAL   # Check all findings at this grade or below
newsroom redteam                            # Adversarial stress-test all findings
newsroom redteam -f F001                    # Red-team a specific finding
newsroom voice create "Dan Shalev" --role "investigative journalist" --tone "direct,aggressive"
newsroom voice list                         # List voice profiles
newsroom compose twitter_thread             # Compose findings as Twitter thread
newsroom compose newsletter --voice dan-shalev --focus "stock trading"
newsroom compose editor_pitch               # Pitch story to an editor
newsroom compose executive_briefing         # C-suite briefing
newsroom ship                               # Compose ALL formats at once
newsroom export --type findings -o data.csv # Export to CSV
newsroom export --type all                  # Export everything
newsroom search "stock trading"             # Search findings by query
newsroom search "SEC" --grade STRONG        # Search with filters
newsroom usage                              # API usage across all services + optimization tips
newsroom report --format pdf
newsroom patterns
newsroom skills                             # Show all agent skills and profiles
newsroom skills --agent finint              # Show skills for specific agent
newsroom status
```

## Agent Tools (8)
check_knowledge → you_search → web_search → deep_research → web_fetch → web_scrape → pdf_extract → Crawl4AI

## Adding New Agent Types
Create a YAML file in `src/agents/definitions/`. No code changes needed.

## Testing
```
npm test          # Run all tests (vitest)
npm run typecheck # Type-check
```

## Tech Stack
TypeScript, Anthropic Claude SDK, Commander.js, Puppeteer (PDF), Crawl4AI (headless scraping), You.com API (search + research), pino (logging), vitest (testing).
