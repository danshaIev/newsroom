#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'path';
import { writeFileSync } from 'fs';

import { isSafeEnvKey, validateOutputPath } from './tools/security.js';

// Load .env file if present — only allow known-safe keys
const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (isSafeEnvKey(key) && !process.env[key]) process.env[key] = value;
  }
}
import { initProject, loadProject, type SubjectConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { ReportGenerator } from './report/generator.js';
import { exportCsv, type ExportType } from './report/export.js';
import { SkillEngine } from './learning/skills.js';
import { VoiceManager, type OutputFormat } from './messaging/voice.js';
import { MessageComposer } from './messaging/composer.js';
import { TokenOptimizer } from './tokens/optimizer.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();

program
  .name('newsroom')
  .description('AI investigative research platform — multi-agent newsroom with self-learning skills')
  .version('0.3.0');

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
    console.log(chalk.dim(`Skills: .newsroom/profiles/`));
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
    const orchestrator = new Orchestrator(dir, config.subject, definitionsDir, config.settings);

    const agents = opts.agents?.split(',') ?? config.settings.defaultAgents;
    const waves = parseInt(opts.waves);

    await orchestrator.runMultipleWaves(waves, {
      agents,
      focus: opts.focus,
    });
  });

program
  .command('factcheck')
  .description('Institutional-grade fact-checking: decompose → verify → counter-search → verdict')
  .option('-f, --finding <id>', 'Specific finding ID to check')
  .option('-g, --grade <grade>', 'Check all findings at this grade or below (DEVELOPING, CIRCUMSTANTIAL, STRONG, BULLETPROOF)', 'STRONG')
  .option('-b, --budget <tokens>', 'Token budget for fact-checking', '100000')
  .action(async (opts: { finding?: string; grade: string; budget: string }) => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) {
      console.log(chalk.red('No investigation found. Run `newsroom init` first.'));
      process.exit(1);
    }

    const { KnowledgeStore } = await import('./knowledge/store.js');
    const { FetchCache } = await import('./tokens/cache.js');
    const { TokenBudget } = await import('./tokens/budget.js');
    const { FactCheckPipeline } = await import('./factcheck/pipeline.js');

    const store = new KnowledgeStore(dir);
    const cache = new FetchCache(dir);
    const skills = new SkillEngine(dir);
    const budget = new TokenBudget('factcheck', parseInt(opts.budget));

    const pipeline = new FactCheckPipeline(store, cache, skills, budget, { model: config.settings.model });

    console.log(chalk.bold('\n=== Fact-Check Pipeline ==='));
    console.log(chalk.dim('Stages: Decompose → Verify → Counter-search → Context → Verdict\n'));

    if (opts.finding) {
      const finding = store.getFinding(opts.finding);
      if (!finding) {
        console.log(chalk.red(`Finding ${opts.finding} not found.`));
        process.exit(1);
      }
      const verdict = await pipeline.check(finding);
      store.addVerdict(verdict);
      store.writeIndex();
      printVerdict(verdict, finding);
    } else {
      const gradeOrder: Record<string, number> = {
        'DEVELOPING': 0, 'CIRCUMSTANTIAL': 1, 'STRONG': 2, 'BULLETPROOF': 3,
      };
      const maxGrade = gradeOrder[opts.grade] ?? 2;
      const findings = store.allFindings().filter(f => gradeOrder[f.evidence] <= maxGrade);

      if (findings.length === 0) {
        console.log(chalk.yellow('No findings to fact-check at this grade level.'));
        return;
      }

      console.log(`Checking ${findings.length} findings at ${opts.grade} grade or below...\n`);
      const verdicts = await pipeline.checkAll(findings);

      for (const [findingId, verdict] of verdicts) {
        store.addVerdict(verdict);
        const finding = store.getFinding(findingId);
        if (finding) printVerdict(verdict, finding);
      }
      store.writeIndex();

      // Summary
      const confirmed = [...verdicts.values()].filter(v => v.rating === 'CONFIRMED').length;
      const mixed = [...verdicts.values()].filter(v => v.rating === 'MIXED').length;
      const falseCount = [...verdicts.values()].filter(v => v.rating === 'FALSE' || v.rating === 'MOSTLY_FALSE').length;
      console.log(chalk.bold(`\nFact-Check Summary: ${confirmed} confirmed, ${mixed} mixed, ${falseCount} false/mostly false`));
    }

    console.log(chalk.dim(`\n${budget.report()}`));
  });

program
  .command('redteam')
  .description('Adversarial red-team: stress-test findings with alternative explanations, fallacy detection, bias analysis')
  .option('-f, --finding <id>', 'Specific finding ID to challenge')
  .option('-g, --min-grade <grade>', 'Only challenge findings at this grade or above', 'CIRCUMSTANTIAL')
  .option('-b, --budget <tokens>', 'Token budget for red-teaming', '100000')
  .action(async (opts: { finding?: string; minGrade: string; budget: string }) => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) {
      console.log(chalk.red('No investigation found. Run `newsroom init` first.'));
      process.exit(1);
    }

    const { KnowledgeStore } = await import('./knowledge/store.js');
    const { FetchCache } = await import('./tokens/cache.js');
    const { TokenBudget } = await import('./tokens/budget.js');
    const { RedTeam } = await import('./factcheck/redteam.js');

    const store = new KnowledgeStore(dir);
    const cache = new FetchCache(dir);
    const skills = new SkillEngine(dir);
    const budget = new TokenBudget('redteam', parseInt(opts.budget));

    const redteam = new RedTeam(store, cache, skills, budget, { model: config.settings.model });

    console.log(chalk.bold('\n=== Red Team ==='));
    console.log(chalk.dim('Attacks: Alt explanations → Fallacy scan → Source bias → Weakest link → Steelman\n'));

    if (opts.finding) {
      const finding = store.getFinding(opts.finding);
      if (!finding) {
        console.log(chalk.red(`Finding ${opts.finding} not found.`));
        process.exit(1);
      }
      const challenge = await redteam.challenge(finding);
      store.addRedTeamChallenge(challenge);
      store.writeIndex();
      printChallenge(challenge, finding);
    } else {
      const findings = store.allFindings();
      if (findings.length === 0) {
        console.log(chalk.yellow('No findings to challenge.'));
        return;
      }

      console.log(`Challenging ${findings.length} findings...\n`);
      const challenges = await redteam.challengeAll(findings, {
        minGrade: opts.minGrade as any,
      });

      for (const [findingId, challenge] of challenges) {
        store.addRedTeamChallenge(challenge);
        const finding = store.getFinding(findingId);
        if (finding) printChallenge(challenge, finding);
      }
      store.writeIndex();

      const survived = [...challenges.values()].filter(c => c.survived).length;
      const failed = [...challenges.values()].filter(c => !c.survived).length;
      console.log(chalk.bold(`\nRed Team Summary: ${survived} survived, ${failed} failed`));
    }

    console.log(chalk.dim(`\n${budget.report()}`));
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
    const pathCheck = validateOutputPath(htmlPath, dir);
    if (!pathCheck.ok) { console.log(chalk.red(pathCheck.reason)); process.exit(1); }
    writeFileSync(htmlPath, html);
    console.log(chalk.green(`HTML report: ${htmlPath}`));

    if (opts.format === 'pdf') {
      const pdfPath = htmlPath.replace('.html', '.pdf');
      await generator.generatePDF(htmlPath, pdfPath);
      console.log(chalk.green(`PDF report: ${pdfPath}`));
    }
  });

program
  .command('export')
  .description('Export findings, entities, verdicts to CSV')
  .option('-t, --type <type>', 'Export type: findings, entities, relationships, verdicts, all', 'findings')
  .option('-o, --output <path>', 'Output file path (default: stdout)')
  .action(async (opts: { type: string; output?: string }) => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) { console.log(chalk.red('No investigation found.')); process.exit(1); }

    const { KnowledgeStore } = await import('./knowledge/store.js');
    const store = new KnowledgeStore(dir);

    const validTypes = ['findings', 'entities', 'relationships', 'verdicts', 'all'];
    if (!validTypes.includes(opts.type)) {
      console.log(chalk.red(`Invalid type. Choose: ${validTypes.join(', ')}`));
      process.exit(1);
    }

    const csv = exportCsv(store, opts.type as ExportType);

    if (opts.output) {
      const outCheck = validateOutputPath(opts.output, dir);
      if (!outCheck.ok) { console.log(chalk.red(outCheck.reason)); process.exit(1); }
      writeFileSync(opts.output, csv);
      console.log(chalk.green(`Exported ${opts.type} to ${opts.output}`));
    } else {
      console.log(csv);
    }
  });

program
  .command('search')
  .description('Search findings by query')
  .argument('<query>', 'Search query')
  .option('-g, --grade <grade>', 'Filter by evidence grade')
  .option('-a, --agent <agent>', 'Filter by agent type')
  .option('-t, --tag <tag>', 'Filter by tag')
  .action(async (query: string, opts: { grade?: string; agent?: string; tag?: string }) => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) { console.log(chalk.red('No investigation found.')); process.exit(1); }

    const { KnowledgeStore } = await import('./knowledge/store.js');
    const { wordSimilarity } = await import('./utils/similarity.js');
    const store = new KnowledgeStore(dir);

    let results = store.allFindings();

    // Apply filters
    if (opts.grade) results = results.filter(f => f.evidence === opts.grade);
    if (opts.agent) results = results.filter(f => f.agent === opts.agent);
    if (opts.tag) results = results.filter(f => f.tags.includes(opts.tag!));

    // Score by query relevance
    const queryLower = query.toLowerCase();
    const scored = results
      .map(f => ({
        finding: f,
        score: Math.max(
          wordSimilarity(f.claim, query),
          f.claim.toLowerCase().includes(queryLower) ? 0.9 : 0,
          f.tags.some(t => t.toLowerCase().includes(queryLower)) ? 0.7 : 0,
        ),
      }))
      .filter(s => s.score > 0.1)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      console.log(chalk.yellow('No matching findings.'));
      return;
    }

    console.log(chalk.bold(`\n${scored.length} results for "${query}":\n`));
    for (const { finding: f, score } of scored.slice(0, 20)) {
      const verdict = store.getVerdict(f.id);
      const rt = store.getRedTeamChallenge(f.id);
      const badges = [
        verdict ? `FC:${verdict.rating}` : null,
        rt ? (rt.survived ? 'RT:SURVIVED' : 'RT:FAILED') : null,
      ].filter(Boolean).join(' ');

      console.log(`${chalk.bold(f.id)} [${f.evidence}] ${chalk.dim(`(${Math.round(score * 100)}%)`)}`);
      console.log(`  ${f.claim}`);
      console.log(`  ${chalk.dim(`Agent: ${f.agent} | Wave: ${f.wave} | Tags: ${f.tags.join(', ')}${badges ? ` | ${badges}` : ''}`)}`);
      console.log();
    }
  });

program
  .command('patterns')
  .description('Show learned research patterns')
  .action(async () => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) {
      console.log(chalk.red('No investigation found.'));
      process.exit(1);
    }

    const { PatternLearner } = await import('./patterns/learner.js');
    const patterns = new PatternLearner(dir);
    console.log(patterns.digest());
  });

program
  .command('skills')
  .description('Show learned agent skills and profiles')
  .option('-a, --agent <type>', 'Show skills for a specific agent')
  .action((opts: { agent?: string }) => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) {
      console.log(chalk.red('No investigation found.'));
      process.exit(1);
    }

    const skills = new SkillEngine(dir);

    if (opts.agent) {
      console.log(skills.buildSkillContext(opts.agent));
    } else {
      console.log(skills.allSkillsDigest());
    }
  });

program
  .command('status')
  .description('Show investigation status')
  .action(async () => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) {
      console.log(chalk.red('No investigation found.'));
      process.exit(1);
    }

    const { KnowledgeStore } = await import('./knowledge/store.js');
    const store = new KnowledgeStore(dir);
    const skills = new SkillEngine(dir);

    console.log(chalk.bold(`Investigation: ${config.subject.name}`));
    console.log(chalk.dim(`Type: ${config.subject.type}`));
    console.log();
    console.log(store.summary());
    console.log();
    console.log(chalk.bold('Agent Skills:'));
    console.log(skills.allSkillsDigest());
  });

program
  .command('usage')
  .description('Show API usage across all services and optimization recommendations')
  .action(() => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) { console.log(chalk.red('No investigation found.')); process.exit(1); }

    const optimizer = new TokenOptimizer(dir);
    console.log(optimizer.report());
  });

// --- Voice Profile Management ---

const voiceCmd = program
  .command('voice')
  .description('Manage researcher voice profiles for messaging');

voiceCmd
  .command('create')
  .description('Create a voice profile')
  .argument('<name>', 'Profile name (e.g., "Dan Shalev")')
  .option('-r, --role <role>', 'Role/title', 'investigative journalist')
  .option('-t, --tone <tone>', 'Comma-separated tone keywords', 'authoritative,direct')
  .option('-a, --audience <audience>', 'Target audience', 'general public')
  .action((name: string, opts: { role: string; tone: string; audience: string }) => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) { console.log(chalk.red('No investigation found.')); process.exit(1); }

    const vm = new VoiceManager(dir);
    const profile = vm.createProfile({
      name,
      role: opts.role,
      tone: opts.tone.split(',').map(t => t.trim()),
      audience: opts.audience,
      platforms: [
        { platform: 'twitter', style: 'Punchy, thread-native. Hook first.' },
        { platform: 'newsletter', style: 'Conversational but evidence-heavy.' },
        { platform: 'memo', style: 'Facts-first, no editorializing.' },
        { platform: 'pitch', style: 'Confident but honest about gaps.' },
        { platform: 'report', style: 'Professional, defensible, sourced.' },
        { platform: 'briefing', style: 'Bottom-line up front. Action-oriented.' },
      ],
      styleRules: [
        'Lead with the most newsworthy finding',
        'Always cite sources — no unattributed claims',
        'Short sentences. Active voice. No jargon.',
        'If evidence is circumstantial, say so',
      ],
    });
    console.log(chalk.green(`Voice profile created: ${profile.name} (${profile.id})`));
    console.log(chalk.dim(`Role: ${profile.role} | Tone: ${profile.tone.join(', ')} | Audience: ${profile.audience}`));
  });

voiceCmd
  .command('list')
  .description('List all voice profiles')
  .action(() => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) { console.log(chalk.red('No investigation found.')); process.exit(1); }

    const vm = new VoiceManager(dir);
    const profiles = vm.allProfiles();
    if (profiles.length === 0) {
      console.log(chalk.yellow('No voice profiles. Run `newsroom voice create "Your Name"`'));
      return;
    }
    for (const p of profiles) {
      console.log(`${chalk.bold(p.id)}: ${p.name} — ${p.role} (${p.tone.join(', ')}) → ${p.audience}`);
    }
  });

// --- Compose / Ship ---

program
  .command('compose')
  .description('Transform findings into publishable content using a voice profile')
  .argument('<format>', `Output format: ${VoiceManager.allFormats().map(f => f.key).join(', ')}`)
  .option('-v, --voice <id>', 'Voice profile ID')
  .option('-f, --findings <ids>', 'Comma-separated finding IDs (default: top findings)')
  .option('--focus <topic>', 'Focus on a specific topic/angle')
  .option('--instructions <text>', 'Custom instructions for the composer')
  .option('-o, --output <path>', 'Write output to file')
  .action(async (format: string, opts: { voice?: string; findings?: string; focus?: string; instructions?: string; output?: string }) => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) { console.log(chalk.red('No investigation found.')); process.exit(1); }

    const validFormats = VoiceManager.allFormats().map(f => f.key);
    if (!validFormats.includes(format as OutputFormat)) {
      console.log(chalk.red(`Invalid format. Choose: ${validFormats.join(', ')}`));
      process.exit(1);
    }

    const { KnowledgeStore } = await import('./knowledge/store.js');
    const store = new KnowledgeStore(dir);
    const vm = new VoiceManager(dir);
    const composer = new MessageComposer(store, vm);

    const findingIds = opts.findings?.split(',');

    console.log(chalk.bold(`\n=== Composing: ${VoiceManager.getFormatSpec(format as OutputFormat).name} ===\n`));

    const result = await composer.compose({
      format: format as OutputFormat,
      voiceId: opts.voice,
      findingIds,
      focus: opts.focus,
      customInstructions: opts.instructions,
    });

    if (opts.output) {
      const outCheck = validateOutputPath(opts.output, dir);
      if (!outCheck.ok) { console.log(chalk.red(outCheck.reason)); process.exit(1); }
      writeFileSync(opts.output, result.content);
      console.log(chalk.green(`Written to: ${opts.output}`));
    } else {
      console.log(result.content);
    }

    console.log(chalk.dim(`\n--- ${result.metadata.findingsUsed} findings, ${result.metadata.verdictsAvailable} verdicts, ${result.metadata.redTeamSurvived} RT survived, ${result.metadata.tokensUsed} tokens ---`));
  });

program
  .command('ship')
  .description('Compose findings in ALL formats at once')
  .option('-v, --voice <id>', 'Voice profile ID')
  .option('--focus <topic>', 'Focus on a specific topic/angle')
  .option('-o, --outdir <dir>', 'Output directory', '.newsroom/output')
  .action(async (opts: { voice?: string; focus?: string; outdir: string }) => {
    const dir = process.cwd();
    const config = loadProject(dir);
    if (!config) { console.log(chalk.red('No investigation found.')); process.exit(1); }

    const { KnowledgeStore } = await import('./knowledge/store.js');
    const { mkdirSync } = await import('fs');
    const store = new KnowledgeStore(dir);
    const vm = new VoiceManager(dir);
    const composer = new MessageComposer(store, vm);

    const outdir = join(dir, opts.outdir);
    const dirCheck = validateOutputPath(outdir, dir);
    if (!dirCheck.ok) { console.log(chalk.red(dirCheck.reason)); process.exit(1); }
    mkdirSync(outdir, { recursive: true });

    const formats: OutputFormat[] = ['twitter_thread', 'newsletter', 'press_memo', 'editor_pitch', 'executive_briefing'];

    console.log(chalk.bold(`\n=== Shipping: ${formats.length} formats ===\n`));

    for (const format of formats) {
      const spec = VoiceManager.getFormatSpec(format);
      console.log(chalk.blue(`  Composing ${spec.name}...`));
      const result = await composer.compose({
        format,
        voiceId: opts.voice,
        focus: opts.focus,
      });
      const filename = `${format}.md`;
      writeFileSync(join(outdir, filename), result.content);
      console.log(chalk.green(`  ✓ ${filename} (${result.metadata.tokensUsed} tokens)`));
    }

    console.log(chalk.bold(`\nAll formats written to ${outdir}`));
  });

// --- Display helpers ---

function printVerdict(verdict: import('./knowledge/schema.js').Verdict, finding: import('./knowledge/schema.js').Finding) {
  const ratingColors: Record<string, typeof chalk.green> = {
    'CONFIRMED': chalk.green,
    'MOSTLY_TRUE': chalk.greenBright,
    'MIXED': chalk.yellow,
    'MOSTLY_FALSE': chalk.redBright,
    'FALSE': chalk.red,
    'UNVERIFIABLE': chalk.dim,
  };
  const color = ratingColors[verdict.rating] ?? chalk.white;

  console.log(`\n${chalk.bold(finding.id)}: ${finding.claim.slice(0, 100)}`);
  console.log(`  Verdict: ${color(verdict.rating)} (${Math.round(verdict.confidence * 100)}% confidence)`);
  console.log(`  Atomic claims: ${verdict.atomicClaims.filter(c => c.verified).length}/${verdict.atomicClaims.length} verified`);
  console.log(`  Confirming sources: ${verdict.confirmingSources.length}`);
  console.log(`  Counter-evidence: ${verdict.counterEvidence.length}${verdict.counterEvidence.filter(c => c.strength === 'strong').length > 0 ? chalk.red(` (${verdict.counterEvidence.filter(c => c.strength === 'strong').length} strong)`) : ''}`);
  if (verdict.contextualAnalysis && !verdict.contextualAnalysis.includes('No significant')) {
    console.log(`  Context: ${chalk.yellow(verdict.contextualAnalysis.slice(0, 120))}`);
  }
  if (verdict.verificationNotes.length > 0) {
    console.log(`  Notes: ${verdict.verificationNotes[0]}`);
  }
}

function printChallenge(challenge: import('./knowledge/schema.js').RedTeamChallenge, finding: import('./knowledge/schema.js').Finding) {
  const icon = challenge.survived ? chalk.green('SURVIVED') : chalk.red('FAILED');
  console.log(`\n${chalk.bold(finding.id)}: ${finding.claim.slice(0, 100)}`);
  console.log(`  Result: ${icon} → Recommended grade: ${challenge.recommendedGrade}`);
  if (challenge.alternativeExplanations.length > 0) {
    console.log(`  Alt explanations: ${challenge.alternativeExplanations.length}`);
    for (const alt of challenge.alternativeExplanations.slice(0, 2)) {
      console.log(`    - [${alt.plausibility}] ${alt.explanation.slice(0, 100)}`);
    }
  }
  if (challenge.logicalFallacies.length > 0) {
    console.log(`  Fallacies detected: ${challenge.logicalFallacies.map(f => f.fallacy).join(', ')}`);
  }
  if (challenge.sourceBias) {
    console.log(`  Source bias: ${chalk.yellow(challenge.sourceBias.slice(0, 120))}`);
  }
  console.log(`  Weakest link: ${challenge.weakestLink.description.slice(0, 120)}`);
}

// Graceful unhandled rejection handler
process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(chalk.red(`\nUnhandled error: ${msg}`));
  if (reason instanceof Error && reason.stack) {
    console.error(chalk.dim(reason.stack));
  }
  process.exit(1);
});

program.parse();
