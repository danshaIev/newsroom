import { execFile, spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { validateUrl } from './security.js';
import { circuits } from '../utils/circuit-breaker.js';
import { createLogger } from '../utils/logger.js';

const VENV_PYTHON = join(process.cwd(), '.venv', 'bin', 'python3');
const crawlCircuit = circuits.get('crawl4ai', { failureThreshold: 3, cooldownMs: 30_000 });
const log = createLogger('crawl4ai');

/**
 * Crawl4AI integration — scrapes URLs into clean LLM-friendly markdown.
 * Runs as a Python subprocess using the local .venv.
 * No API keys, no limits, fully local.
 */

interface ScrapeResult {
  markdown: string;
  title?: string;
  links?: string[];
  error?: string;
}

/** Scrape a single URL into clean markdown */
export async function crawl4aiScrape(url: string, options?: {
  onlyMainContent?: boolean;
  timeout?: number;
}): Promise<ScrapeResult> {
  const urlCheck = validateUrl(url);
  if (!urlCheck.ok) return { markdown: '', error: urlCheck.reason };

  if (!crawlCircuit.canExecute()) {
    return { markdown: '', error: 'Crawl4AI circuit open — service temporarily unavailable' };
  }

  const onlyMain = options?.onlyMainContent ?? true;
  const timeout = options?.timeout ?? 30000;

  // SECURITY: URL passed as command-line argument, NOT interpolated into script
  const script = `
import asyncio, json, sys
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, BrowserConfig

async def scrape():
    url = sys.argv[1]
    only_text = sys.argv[2] == "true"
    browser_config = BrowserConfig(headless=True, verbose=False)
    run_config = CrawlerRunConfig(
        exclude_external_links=False,
        only_text=only_text,
    )
    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(url=url, config=run_config)
        if result.success:
            links = []
            if result.links:
                links = [l.get("href", "") for l in result.links.get("internal", [])][:20]
            print(json.dumps({
                "markdown": result.markdown[:12000],
                "title": getattr(result, "title", ""),
                "links": links,
            }))
        else:
            print(json.dumps({"error": result.error_message or "Scrape failed", "markdown": ""}))

asyncio.run(scrape())
`;

  return new Promise((resolve) => {
    execFile(VENV_PYTHON, ['-c', script, url, String(onlyMain)], {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }, (error, stdout) => {
      if (error) {
        crawlCircuit.recordFailure();
        resolve({ markdown: '', error: error.message });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim()) as ScrapeResult;
        crawlCircuit.recordSuccess();
        resolve(result);
      } catch {
        crawlCircuit.recordSuccess(); // Process ran, just bad output
        resolve({ markdown: stdout.trim().slice(0, 8000) || '', error: 'Parse error' });
      }
    });
  });
}

/** Crawl a site — follow links from a starting URL */
export async function crawl4aiCrawl(url: string, options?: {
  maxPages?: number;
  timeout?: number;
}): Promise<ScrapeResult[]> {
  const urlCheck = validateUrl(url);
  if (!urlCheck.ok) return [{ markdown: '', error: urlCheck.reason }];

  const maxPages = options?.maxPages ?? 5;
  const timeout = options?.timeout ?? 60000;

  // SECURITY: URL and maxPages passed as command-line arguments
  const script = `
import asyncio, json, sys
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, BrowserConfig

async def crawl():
    start_url = sys.argv[1]
    max_pages = int(sys.argv[2])
    browser_config = BrowserConfig(headless=True, verbose=False)
    run_config = CrawlerRunConfig(only_text=True)
    results = []
    visited = set()
    queue = [start_url]

    async with AsyncWebCrawler(config=browser_config) as crawler:
        while queue and len(results) < max_pages:
            current = queue.pop(0)
            if current in visited:
                continue
            visited.add(current)
            result = await crawler.arun(url=current, config=run_config)
            if result.success:
                links = []
                if result.links:
                    links = [l.get("href", "") for l in result.links.get("internal", [])][:10]
                results.append({
                    "markdown": result.markdown[:8000],
                    "title": getattr(result, "title", ""),
                    "links": links,
                })
                for link in links:
                    if link not in visited and link.startswith("http"):
                        queue.append(link)

    print(json.dumps(results))

asyncio.run(crawl())
`;

  return new Promise((resolve) => {
    execFile(VENV_PYTHON, ['-c', script, url, String(maxPages)], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }, (error, stdout) => {
      if (error) {
        resolve([{ markdown: '', error: error.message }]);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve([{ markdown: '', error: 'Parse error' }]);
      }
    });
  });
}

/**
 * Persistent Crawl4AI worker process.
 * Keeps the browser warm — eliminates cold-start penalty per URL.
 * Accepts JSON requests on stdin, writes JSON responses on stdout.
 */
const WORKER_SCRIPT = `
import asyncio, json, sys
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, BrowserConfig

async def main():
    browser_config = BrowserConfig(headless=True, verbose=False)
    async with AsyncWebCrawler(config=browser_config) as crawler:
        sys.stdout.write("READY\\n")
        sys.stdout.flush()
        for line in sys.stdin:
            line = line.strip()
            if not line or line == "EXIT":
                break
            try:
                req = json.loads(line)
                url = req["url"]
                only_text = req.get("onlyMainContent", True)
                run_config = CrawlerRunConfig(
                    exclude_external_links=False,
                    only_text=only_text,
                )
                result = await crawler.arun(url=url, config=run_config)
                if result.success:
                    links = []
                    if result.links:
                        links = [l.get("href", "") for l in result.links.get("internal", [])][:20]
                    out = {
                        "markdown": result.markdown[:12000],
                        "title": getattr(result, "title", ""),
                        "links": links,
                    }
                else:
                    out = {"error": result.error_message or "Scrape failed", "markdown": ""}
            except Exception as e:
                out = {"error": str(e), "markdown": ""}
            sys.stdout.write(json.dumps(out) + "\\n")
            sys.stdout.flush()

asyncio.run(main())
`;

interface PendingRequest {
  resolve: (result: ScrapeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

class CrawlWorkerPool {
  private worker: ChildProcess | null = null;
  private ready = false;
  private queue: PendingRequest[] = [];
  private buffer = '';
  private starting = false;

  private async ensureWorker(): Promise<void> {
    if (this.worker && this.ready) return;
    if (this.starting) {
      // Wait for existing startup
      await new Promise<void>(resolve => {
        const check = setInterval(() => {
          if (this.ready) { clearInterval(check); resolve(); }
        }, 50);
        setTimeout(() => { clearInterval(check); resolve(); }, 10_000);
      });
      return;
    }

    this.starting = true;
    this.ready = false;
    this.buffer = '';

    this.worker = spawn(VENV_PYTHON, ['-c', WORKER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });

    this.worker.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'READY') {
          this.ready = true;
          this.starting = false;
          log.debug('Crawl4AI worker pool ready');
          continue;
        }
        const pending = this.queue.shift();
        if (pending) {
          clearTimeout(pending.timer);
          try {
            pending.resolve(JSON.parse(trimmed) as ScrapeResult);
          } catch {
            pending.resolve({ markdown: trimmed.slice(0, 8000), error: 'Parse error' });
          }
        }
      }
    });

    this.worker.stderr!.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) log.debug({ stderr: msg }, 'Crawl4AI worker stderr');
    });

    this.worker.on('exit', (code) => {
      log.warn({ code }, 'Crawl4AI worker exited');
      this.ready = false;
      this.worker = null;
      this.starting = false;
      // Fail all pending requests
      for (const pending of this.queue) {
        clearTimeout(pending.timer);
        pending.resolve({ markdown: '', error: 'Worker process exited' });
      }
      this.queue = [];
    });

    // Wait for READY signal
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.ready) { clearInterval(check); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(check); this.starting = false; resolve(); }, 15_000);
    });
  }

  async scrape(url: string, options?: { onlyMainContent?: boolean; timeout?: number }): Promise<ScrapeResult> {
    await this.ensureWorker();

    if (!this.worker || !this.ready) {
      // Fallback to single-shot if pool failed to start
      return crawl4aiScrape(url, options);
    }

    const timeout = options?.timeout ?? 30_000;

    return new Promise<ScrapeResult>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex(p => p.resolve === resolve);
        if (idx >= 0) this.queue.splice(idx, 1);
        resolve({ markdown: '', error: 'Pool request timeout' });
      }, timeout);

      this.queue.push({ resolve, timer });

      const request = JSON.stringify({
        url,
        onlyMainContent: options?.onlyMainContent ?? true,
      });

      this.worker!.stdin!.write(request + '\n');
    });
  }

  shutdown(): void {
    if (this.worker) {
      this.worker.stdin!.write('EXIT\n');
      this.worker.kill();
      this.worker = null;
      this.ready = false;
    }
  }
}

/** Shared pool instance */
export const crawlPool = new CrawlWorkerPool();

/** Pooled scrape — uses persistent worker, falls back to single-shot */
export async function crawl4aiPooledScrape(url: string, options?: {
  onlyMainContent?: boolean;
  timeout?: number;
}): Promise<ScrapeResult> {
  const urlCheck = validateUrl(url);
  if (!urlCheck.ok) return { markdown: '', error: urlCheck.reason };

  if (!crawlCircuit.canExecute()) {
    return { markdown: '', error: 'Crawl4AI circuit open — service temporarily unavailable' };
  }

  try {
    const result = await crawlPool.scrape(url, options);
    if (result.error) {
      crawlCircuit.recordFailure();
    } else {
      crawlCircuit.recordSuccess();
    }
    return result;
  } catch (e) {
    crawlCircuit.recordFailure();
    return { markdown: '', error: e instanceof Error ? e.message : 'Pool error' };
  }
}
