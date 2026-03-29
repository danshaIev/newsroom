import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { Finding } from '../knowledge/schema.js';

export class ReportGenerator {
  constructor(private store: KnowledgeStore) {}

  generateHTML(title: string): string {
    const findings = this.store.allFindings()
      .sort((a, b) => {
        const grades = ['DEVELOPING', 'CIRCUMSTANTIAL', 'STRONG', 'BULLETPROOF'];
        const impacts = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'];
        const scoreA = grades.indexOf(a.evidence) * 4 + impacts.indexOf(a.impact);
        const scoreB = grades.indexOf(b.evidence) * 4 + impacts.indexOf(b.impact);
        return scoreB - scoreA;
      });

    const findingSections = findings.map((f, i) => this.renderFinding(f, i + 1)).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
  @page { size: letter; margin: 0.6in 0.7in; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.52; color: #1a1a1a; }
  .page { page-break-after: always; }
  h2 { font-size: 18pt; color: #0f1b33; border-bottom: 3px solid #c0392b; padding-bottom: 6px; margin: 0 0 16px 0; }
  h2 .num { color: #c0392b; font-weight: 800; }
  h3 { font-size: 12pt; margin: 14px 0 6px 0; font-weight: 700; }
  p { margin-bottom: 8px; }
  a { color: #2c5f9e; text-decoration: none; border-bottom: 1px solid #b0c4de; }
  .badge { display: inline-block; padding: 2px 8px; font-size: 7pt; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; border-radius: 2px; margin-left: 6px; }
  .b-proof { background: #0f1b33; color: #fff; }
  .b-strong { background: #d4a84b; color: #0f1b33; }
  .b-circ { background: #7a8a9a; color: #fff; }
  .src { font-size: 8pt; color: #7a8a9a; margin-top: 8px; border-top: 1px solid #e0e4e8; padding-top: 4px; }
  .src a { color: #7a8a9a; border-bottom: 1px dotted #b0b8c0; }
  .verdict { background: #0f1b33; color: #fff; padding: 12px 16px; margin: 14px 0; border-radius: 3px; }
</style>
</head>
<body>
${findingSections}
</body>
</html>`;
  }

  private renderFinding(f: Finding, num: number): string {
    const badgeClass = f.evidence === 'BULLETPROOF' ? 'b-proof' : f.evidence === 'STRONG' ? 'b-strong' : 'b-circ';
    const sources = f.sources
      .map(s => `<a href="${s.url}">${s.title || s.url}</a> [${s.grade}]`)
      .join(' | ');

    return `<div class="page">
  <h2><span class="num">${String(num).padStart(2, '0')}</span> ${f.claim} <span class="badge ${badgeClass}">${f.evidence}</span></h2>
  <p>Tags: ${f.tags.join(', ')} | Impact: ${f.impact} | Agent: ${f.agent} | Wave: ${f.wave}</p>
  ${f.redTeam ? `<p><strong>Red Team:</strong> ${f.redTeam}</p>` : ''}
  <div class="src">Sources: ${sources}</div>
</div>`;
  }

  async generatePDF(htmlPath: string, pdfPath: string) {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: pdfPath,
      format: 'Letter',
      printBackground: true,
      displayHeaderFooter: false,
      margin: { top: '0.6in', right: '0.7in', bottom: '0.6in', left: '0.7in' },
    });
    await browser.close();
  }
}
