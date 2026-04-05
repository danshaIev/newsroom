import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Voice profile — defines a researcher's personality, tone, and output preferences.
 * The messaging agent loads this to adapt findings into content that sounds like YOU.
 */
export interface VoiceProfile {
  id: string;
  name: string;
  /** Role/title — "investigative journalist", "policy analyst", "researcher" */
  role: string;
  /** Tone keywords: "authoritative", "conversational", "aggressive", "measured" */
  tone: string[];
  /** Target audience: "general public", "policy wonks", "investors", "newsroom editors" */
  audience: string;
  /** Platform preferences with specific style notes */
  platforms: PlatformConfig[];
  /** Writing style rules — the voice DNA */
  styleRules: string[];
  /** Signature phrases or patterns this person uses */
  signatures?: string[];
  /** What this person NEVER does */
  antiPatterns?: string[];
  created: string;
  updated: string;
}

export interface PlatformConfig {
  platform: 'twitter' | 'newsletter' | 'memo' | 'pitch' | 'report' | 'briefing' | 'substack' | 'linkedin';
  /** Platform-specific style notes */
  style: string;
  /** Max length/format constraints */
  constraints?: string;
  /** Example of this voice on this platform (for few-shot) */
  example?: string;
}

export type OutputFormat =
  | 'twitter_thread'
  | 'newsletter'
  | 'press_memo'
  | 'editor_pitch'
  | 'public_report'
  | 'executive_briefing'
  | 'substack_post'
  | 'linkedin_post';

const FORMAT_SPECS: Record<OutputFormat, { name: string; description: string; structure: string }> = {
  twitter_thread: {
    name: 'Twitter/X Thread',
    description: 'Punchy, numbered thread. Each tweet under 280 chars. Hook in tweet 1.',
    structure: '1/ Hook (the bombshell)\n2-N/ Evidence chain\nN+1/ So what? (implications)\nN+2/ Sources/receipts',
  },
  newsletter: {
    name: 'Newsletter Drop',
    description: 'Email newsletter format. Compelling subject line, scannable body, key takeaways.',
    structure: 'Subject line\nTL;DR (2-3 sentences)\nThe Story (3-5 paragraphs)\nKey Takeaways (bullets)\nWhat to Watch\nSources',
  },
  press_memo: {
    name: 'Press Memo',
    description: 'Internal memo for newsroom. Facts-first, no editorializing, clear sourcing.',
    structure: 'SUBJECT:\nDATE:\nFROM:\nSUMMARY: (1 paragraph)\nKEY FINDINGS: (numbered)\nEVIDENCE: (per finding)\nGAPS/CAVEATS:\nNEXT STEPS:',
  },
  editor_pitch: {
    name: 'Editor Pitch',
    description: 'Story pitch to an editor. Why this matters, what we have, what we need.',
    structure: 'HEADLINE: (proposed)\nNUT GRAF: (why this matters NOW)\nWHAT WE HAVE: (evidence summary)\nWHAT WE NEED: (remaining reporting)\nTIMELINE:\nCOMPETITION: (who else is on this)',
  },
  public_report: {
    name: 'Public Report',
    description: 'Publishable investigation report. Professional, sourced, defensible.',
    structure: 'HEADLINE\nBYLINE\nLEDE (the news)\nNUT GRAF (why it matters)\nBODY (evidence, in order of importance)\nRESPONSE (subject\'s comment)\nMETHODOLOGY\nDOCUMENTS',
  },
  executive_briefing: {
    name: 'Executive Briefing',
    description: 'C-suite/board level. Bottom-line-up-front, risk-focused, action items.',
    structure: 'BOTTOM LINE:\nRISK ASSESSMENT: (critical/high/moderate/low)\nKEY FINDINGS: (3-5 bullets)\nIMPLICATIONS:\nRECOMMENDED ACTIONS:\nCONFIDENCE LEVEL:',
  },
  substack_post: {
    name: 'Substack Post',
    description: 'Long-form investigative post. Narrative-driven, personal voice, embedded evidence.',
    structure: 'TITLE\nSUBTITLE\nHook (scene-setting or bombshell)\nContext (why now)\nInvestigation (narrative arc)\nEvidence (embedded throughout)\nImplications\nWhat\'s Next\nSupport this work',
  },
  linkedin_post: {
    name: 'LinkedIn Post',
    description: 'Professional network post. Insight-led, credibility-forward, engagement-optimized.',
    structure: 'Hook line (stop the scroll)\n\n3-4 insight paragraphs\n\nKey takeaway\n\n#relevant #hashtags',
  },
};

/**
 * Manages voice profiles for the messaging agent.
 */
export class VoiceManager {
  private profiles: Map<string, VoiceProfile> = new Map();
  private dir: string;

  constructor(projectDir: string) {
    this.dir = join(projectDir, '.newsroom', 'voices');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  private load() {
    const indexPath = join(this.dir, 'voices.json');
    if (!existsSync(indexPath)) return;
    const data = JSON.parse(readFileSync(indexPath, 'utf-8')) as VoiceProfile[];
    for (const profile of data) {
      this.profiles.set(profile.id, profile);
    }
  }

  private persist() {
    writeFileSync(
      join(this.dir, 'voices.json'),
      JSON.stringify([...this.profiles.values()], null, 2)
    );
  }

  createProfile(profile: Omit<VoiceProfile, 'id' | 'created' | 'updated'>): VoiceProfile {
    const id = profile.name.toLowerCase().replace(/\s+/g, '-');
    const full: VoiceProfile = {
      ...profile,
      id,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    this.profiles.set(id, full);
    this.persist();
    return full;
  }

  getProfile(id: string): VoiceProfile | undefined {
    return this.profiles.get(id);
  }

  getDefault(): VoiceProfile | undefined {
    return this.profiles.values().next().value;
  }

  allProfiles(): VoiceProfile[] {
    return [...this.profiles.values()];
  }

  static getFormatSpec(format: OutputFormat) {
    return FORMAT_SPECS[format];
  }

  static allFormats(): Array<{ key: OutputFormat; name: string }> {
    return Object.entries(FORMAT_SPECS).map(([key, spec]) => ({
      key: key as OutputFormat,
      name: spec.name,
    }));
  }

  /** Build the voice instructions for the messaging agent's system prompt */
  buildVoicePrompt(profileId: string): string {
    const profile = this.getProfile(profileId);
    if (!profile) return 'No voice profile loaded. Use a neutral, professional tone.';

    const platformNotes = profile.platforms
      .map(p => `- **${p.platform}**: ${p.style}${p.example ? `\n  Example: "${p.example}"` : ''}`)
      .join('\n');

    return `## Voice Profile: ${profile.name}
Role: ${profile.role}
Tone: ${profile.tone.join(', ')}
Audience: ${profile.audience}

### Style Rules
${profile.styleRules.map(r => `- ${r}`).join('\n')}

${profile.signatures?.length ? `### Signature Patterns\n${profile.signatures.map(s => `- "${s}"`).join('\n')}` : ''}

${profile.antiPatterns?.length ? `### NEVER Do These\n${profile.antiPatterns.map(a => `- ${a}`).join('\n')}` : ''}

### Platform Styles
${platformNotes}`;
  }
}

export { FORMAT_SPECS };
