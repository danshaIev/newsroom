import { execFile } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { validateUrl } from './security.js';
import { circuits } from '../utils/circuit-breaker.js';
import { createLogger } from '../utils/logger.js';

const VENV_PYTHON = join(process.cwd(), '.venv', 'bin', 'python3');
const pdfCircuit = circuits.get('pdf-extract', { failureThreshold: 3, cooldownMs: 30_000 });
const log = createLogger('pdf-extract');

interface PdfExtractResult {
  text: string;
  pages: number;
  error?: string;
}

/**
 * Extract text from a PDF — either a URL or local file path.
 * Uses Python's pymupdf (fitz) for reliable extraction.
 * Handles: SEC filings, financial disclosures, court documents, government reports.
 */
export async function extractPdf(source: string, options?: {
  maxPages?: number;
  timeout?: number;
}): Promise<PdfExtractResult> {
  const isUrl = source.startsWith('http://') || source.startsWith('https://');

  if (isUrl) {
    const urlCheck = validateUrl(source);
    if (!urlCheck.ok) return { text: '', pages: 0, error: urlCheck.reason };
  } else if (!existsSync(source)) {
    return { text: '', pages: 0, error: `File not found: ${source}` };
  }

  if (!pdfCircuit.canExecute()) {
    return { text: '', pages: 0, error: 'PDF extraction circuit open' };
  }

  const maxPages = options?.maxPages ?? 50;
  const timeout = options?.timeout ?? 30_000;

  // SECURITY: All inputs passed as sys.argv, never interpolated
  const script = `
import json, sys, io

source = sys.argv[1]
max_pages = int(sys.argv[2])

try:
    import fitz  # pymupdf
except ImportError:
    # Fallback: try pdfplumber
    try:
        import pdfplumber
        import urllib.request

        if source.startswith("http"):
            with urllib.request.urlopen(source, timeout=15) as resp:
                data = resp.read()
            pdf = pdfplumber.open(io.BytesIO(data))
        else:
            pdf = pdfplumber.open(source)

        pages = pdf.pages[:max_pages]
        text = "\\n\\n---\\n\\n".join(
            p.extract_text() or "" for p in pages
        )
        print(json.dumps({"text": text[:50000], "pages": len(pages)}))
        sys.exit(0)
    except ImportError:
        print(json.dumps({"error": "No PDF library available. Install: pip install pymupdf", "text": "", "pages": 0}))
        sys.exit(0)

import urllib.request

if source.startswith("http"):
    with urllib.request.urlopen(source, timeout=15) as resp:
        data = resp.read()
    doc = fitz.open(stream=data, filetype="pdf")
else:
    doc = fitz.open(source)

pages = min(doc.page_count, max_pages)
text_parts = []
for i in range(pages):
    page = doc[i]
    text_parts.append(page.get_text())

text = "\\n\\n---\\n\\n".join(text_parts)
print(json.dumps({"text": text[:50000], "pages": pages}))
`;

  return new Promise((resolve) => {
    execFile(VENV_PYTHON, ['-c', script, source, String(maxPages)], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }, (error, stdout) => {
      if (error) {
        pdfCircuit.recordFailure();
        log.warn({ source, error: error.message }, 'PDF extraction failed');
        resolve({ text: '', pages: 0, error: error.message });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim()) as PdfExtractResult;
        if (result.error) {
          pdfCircuit.recordFailure();
        } else {
          pdfCircuit.recordSuccess();
        }
        resolve(result);
      } catch {
        pdfCircuit.recordSuccess();
        resolve({ text: stdout.trim().slice(0, 50_000), pages: 0, error: 'Parse error' });
      }
    });
  });
}
