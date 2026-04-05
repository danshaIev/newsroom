import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import type { Finding, Verdict, RedTeamChallenge } from '../knowledge/schema.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import { VoiceManager, FORMAT_SPECS, type OutputFormat, type VoiceProfile } from './voice.js';

/**
 * MessageComposer — adapts raw findings into publishable content
 * in the researcher's voice, formatted for the target platform.
 *
 * This is the "ship it" layer. Raw intelligence → polished output.
 */
export class MessageComposer {
  private client: Anthropic;

  constructor(
    private store: KnowledgeStore,
    private voiceManager: VoiceManager,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic();
  }

  /**
   * Compose content for a specific format using a voice profile.
   * Pulls findings, verdicts, and red-team data to build the narrative.
   */
  async compose(options: {
    format: OutputFormat;
    voiceId?: string;
    findingIds?: string[];
    focus?: string;
    customInstructions?: string;
  }): Promise<{ content: string; metadata: CompositionMetadata }> {
    const profile = options.voiceId
      ? this.voiceManager.getProfile(options.voiceId)
      : this.voiceManager.getDefault();

    const format = FORMAT_SPECS[options.format];
    const voicePrompt = profile
      ? this.voiceManager.buildVoicePrompt(profile.id)
      : 'Use a neutral, professional investigative journalism tone.';

    // Gather intelligence
    const findings = options.findingIds
      ? options.findingIds.map(id => this.store.getFinding(id)).filter((f): f is Finding => !!f)
      : this.getTopFindings(options.focus);

    const verdicts = findings.map(f => this.store.getVerdict(f.id)).filter((v): v is Verdict => !!v);
    const challenges = findings.map(f => this.store.getRedTeamChallenge(f.id)).filter((c): c is RedTeamChallenge => !!c);

    const intelligenceBrief = this.buildIntelligenceBrief(findings, verdicts, challenges);

    console.log(chalk.blue(`  [composer] ${format.name} — ${findings.length} findings, voice: ${profile?.name ?? 'neutral'}`));

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: this.buildSystem(voicePrompt, format, options.format),
      messages: [{
        role: 'user',
        content: this.buildPrompt(intelligenceBrief, format, options),
      }],
    });

    const content = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text).join('');

    const metadata: CompositionMetadata = {
      format: options.format,
      voice: profile?.name ?? 'neutral',
      findingsUsed: findings.length,
      verdictsAvailable: verdicts.length,
      redTeamSurvived: challenges.filter(c => c.survived).length,
      tokensUsed: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      created: new Date().toISOString(),
    };

    return { content, metadata };
  }

  /** Compose the same content in multiple formats at once */
  async composeMulti(options: {
    formats: OutputFormat[];
    voiceId?: string;
    findingIds?: string[];
    focus?: string;
  }): Promise<Map<OutputFormat, { content: string; metadata: CompositionMetadata }>> {
    const results = new Map<OutputFormat, { content: string; metadata: CompositionMetadata }>();
    for (const format of options.formats) {
      const result = await this.compose({ ...options, format });
      results.set(format, result);
    }
    return results;
  }

  private buildSystem(voicePrompt: string, format: typeof FORMAT_SPECS[OutputFormat], formatKey: OutputFormat): string {
    return `You are a messaging specialist who transforms raw intelligence into publishable content. You adapt your voice to match the researcher's personality exactly.

${voicePrompt}

## Output Format: ${format.name}
${format.description}

### Structure
${format.structure}

## Critical Rules
1. ONLY use findings that have been verified or have strong evidence. Never fabricate or embellish.
2. If a finding was red-teamed and FAILED, do NOT include it unless you note the caveats.
3. If a finding was fact-checked as FALSE or MOSTLY_FALSE, do NOT include it.
4. Always attribute claims to their sources. No unattributed claims.
5. Match the voice profile EXACTLY — tone, style rules, signatures, anti-patterns.
6. For ${formatKey === 'twitter_thread' ? 'tweets: each under 280 characters. Number them.' :
     formatKey === 'editor_pitch' ? 'pitches: be honest about what you still need. Editors hate surprises.' :
     formatKey === 'executive_briefing' ? 'briefings: bottom line up front. Executives read the first line and the recommendation.' :
     'this format: follow the structure precisely.'}
7. Output ONLY the formatted content. No meta-commentary, no "here's your thread", just the content.`;
  }

  private buildPrompt(
    intelligenceBrief: string,
    format: typeof FORMAT_SPECS[OutputFormat],
    options: { focus?: string; customInstructions?: string },
  ): string {
    return `Transform this intelligence into a ${format.name}.

${intelligenceBrief}

${options.focus ? `ANGLE/FOCUS: ${options.focus}` : ''}
${options.customInstructions ? `ADDITIONAL INSTRUCTIONS: ${options.customInstructions}` : ''}

Write the ${format.name} now. Follow the structure exactly. Match the voice.`;
  }

  private buildIntelligenceBrief(
    findings: Finding[],
    verdicts: Verdict[],
    challenges: RedTeamChallenge[],
  ): string {
    const sections: string[] = ['## Intelligence Brief\n'];

    // Findings by evidence grade
    const byGrade = {
      BULLETPROOF: findings.filter(f => f.evidence === 'BULLETPROOF'),
      STRONG: findings.filter(f => f.evidence === 'STRONG'),
      CIRCUMSTANTIAL: findings.filter(f => f.evidence === 'CIRCUMSTANTIAL'),
      DEVELOPING: findings.filter(f => f.evidence === 'DEVELOPING'),
    };

    for (const [grade, gradeFindings] of Object.entries(byGrade)) {
      if (gradeFindings.length === 0) continue;
      sections.push(`### ${grade} Evidence`);
      for (const f of gradeFindings) {
        const verdict = verdicts.find(v => v.findingId === f.id);
        const challenge = challenges.find(c => c.findingId === f.id);

        let badges = '';
        if (verdict) badges += ` [FC: ${verdict.rating}]`;
        if (challenge) badges += challenge.survived ? ' [RT: SURVIVED]' : ' [RT: FAILED]';

        sections.push(`- **${f.id}**${badges}: ${f.claim}`);
        sections.push(`  Sources: ${f.sources.map(s => `${s.title} (${s.url})`).join('; ')}`);

        if (verdict && (verdict.rating === 'FALSE' || verdict.rating === 'MOSTLY_FALSE')) {
          sections.push(`  ⚠️ FACT-CHECK: ${verdict.rating} — ${verdict.verificationNotes[0] ?? 'See verdict details'}`);
        }
        if (challenge && !challenge.survived) {
          sections.push(`  ⚠️ RED-TEAM FAILED: ${challenge.weakestLink.description}`);
        }
        if (challenge?.alternativeExplanations.filter(a => a.plausibility === 'high').length) {
          sections.push(`  ⚠️ High-plausibility alternative explanation exists`);
        }
      }
      sections.push('');
    }

    // Key entities and relationships
    const entities = this.store.allEntities().slice(0, 10);
    if (entities.length > 0) {
      sections.push('### Key Entities');
      sections.push(entities.map(e => `- ${e.name} (${e.type})`).join('\n'));
    }

    return sections.join('\n');
  }

  private getTopFindings(focus?: string): Finding[] {
    let findings = this.store.allFindings();

    if (focus) {
      const focusLower = focus.toLowerCase();
      findings = findings.filter(f =>
        f.tags.some(t => t.toLowerCase().includes(focusLower)) ||
        f.claim.toLowerCase().includes(focusLower)
      );
    }

    // Sort by evidence × impact
    const gradeOrder: Record<string, number> = { 'BULLETPROOF': 4, 'STRONG': 3, 'CIRCUMSTANTIAL': 2, 'DEVELOPING': 1 };
    const impactOrder: Record<string, number> = { 'CRITICAL': 4, 'HIGH': 3, 'MODERATE': 2, 'LOW': 1 };

    return findings
      .sort((a, b) =>
        (gradeOrder[b.evidence] * impactOrder[b.impact]) -
        (gradeOrder[a.evidence] * impactOrder[a.impact])
      )
      .slice(0, 15);
  }
}

export interface CompositionMetadata {
  format: OutputFormat;
  voice: string;
  findingsUsed: number;
  verdictsAvailable: number;
  redTeamSurvived: number;
  tokensUsed: number;
  created: string;
}
