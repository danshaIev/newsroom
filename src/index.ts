#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { join, resolve } from 'path';
import { writeFileSync } from 'fs';
import { initProject, loadProject, type SubjectConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { ReportGenerator } from './report/generator.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();

program
  .name('newsroom')
  .description('AI investigative research platform — multi-agent newsroom with pattern learning')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize a new investigation')
  .argument('<name>', 'Subject name')
  .option('-t, --type <type>', 'Subject type: politician, company, person, organization', 'person')
  .option('-d, --description <desc>', 'Subject description')
  .action((name: string, opts: { type: string; description?: string }) => {
    const dir = process.cwd();
    const subject: SubjectConfig = {
      name,
      type: opts.type as SubjectConfig['type'],
      description: opts.description,
      created: new Date().toISOString(),
    };
    const config = initProject(dir, subject);
    console.log(chalk.green(`Initialized investigation: ${name}`));
    console.log(chalk.dim(`Type: ${config.subject.type}`));
    console.log(chalk.dim(`Config: .newsroom/config.json`));
    console.log(chalk.dim(`Knowledge: .newsroom/knowledge/`));
    console.log(chalk.dim(`Patterns: .newsroom/patterns.md`));
    console.log(`\nRun ${chalk.bold('newsroom research')} to start your first wave.`);
  });

program
  .command('research')
  .description('Run a research wave')
  .option('-w, --waves <count>', 'Number of waves to run', '1')
  .option('-a, --agents <types>', 'Comma-separated agent types (default: all)')
  .option('-f, --focus <area>', 'Focus area for this wave')
  .option('-b, --budget <tokens>', 'Token budget per agent', '50000')
  .action(async (opts: { waves: string; agents?: string; focus?: string; budget: string }) => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) {
      console.log(chalk.red('No investigation found. Run `newsroom init` first.'));
      process.exit(1);
    }

    const definitionsDir = join(__dirname, 'agents', 'definitions');
    const orchestrator = new Orchestrator(dir, config.subject, definitionsDir);

    const agents = opts.agents?.split(',') ?? config.settings.defaultAgents;
    const waves = parseInt(opts.waves);

    await orchestrator.runMultipleWaves(waves, {
      agents,
      focus: opts.focus,
    });
  });

program
  .command('factcheck')
  .description('Run fact-check agent against existing findings')
  .option('-f, --finding <id>', 'Specific finding ID to check')
  .action(async (opts: { finding?: string }) => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) {
      console.log(chalk.red('No investigation found. Run `newsroom init` first.'));
      process.exit(1);
    }

    const definitionsDir = join(__dirname, 'agents', 'definitions');
    const orchestrator = new Orchestrator(dir, config.subject, definitionsDir);

    await orchestrator.runWave({
      wave: 0,
      agents: ['crossref'],
      focus: opts.finding ? `Verify finding ${opts.finding}` : 'Verify all findings',
    });
  });

program
  .command('report')
  .description('Generate a report from findings')
  .option('-f, --format <format>', 'Output format: html, pdf', 'pdf')
  .option('-o, --output <path>', 'Output file path')
  .action(async (opts: { format: string; output?: string }) => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) {
      console.log(chalk.red('No investigation found. Run `newsroom init` first.'));
      process.exit(1);
    }

    const { KnowledgeStore } = await import('./knowledge/store.js');
    const store = new KnowledgeStore(dir);
    const generator = new ReportGenerator(store);

    const title = `Investigation Report: ${config.subject.name}`;
    const html = generator.generateHTML(title);
    const htmlPath = opts.output ?? join(dir, '.newsroom', `report.html`);
    writeFileSync(htmlPath, html);
    console.log(chalk.green(`HTML report: ${htmlPath}`));

    if (opts.format === 'pdf') {
      const pdfPath = htmlPath.replace('.html', '.pdf');
      await generator.generatePDF(htmlPath, pdfPath);
      console.log(chalk.green(`PDF report: ${pdfPath}`));
    }
  });

program
  .command('patterns')
  .description('Show learned research patterns')
  .action(() => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) {
      console.log(chalk.red('No investigation found.'));
      process.exit(1);
    }

    const { PatternLearner } = require('./patterns/learner.js');
    const patterns = new PatternLearner(dir);
    console.log(patterns.digest());
  });

program
  .command('status')
  .description('Show investigation status')
  .action(() => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) {
      console.log(chalk.red('No investigation found.'));
      process.exit(1);
    }

    const { KnowledgeStore } = require('./knowledge/store.js');
    const store = new KnowledgeStore(dir);
    console.log(chalk.bold(`Investigation: ${config.subject.name}`));
    console.log(chalk.dim(`Type: ${config.subject.type}`));
    console.log();
    console.log(store.summary());
  });

program.parse();
