import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface SubjectConfig {
  name: string;
  type: 'politician' | 'company' | 'person' | 'organization';
  description?: string;
  aliases?: string[];
  knownFacts?: string[];
  researchQuestions?: string[];
  created: string;
}

export interface ProjectConfig {
  subject: SubjectConfig;
  settings: {
    defaultTokenBudget: number;
    defaultAgents: string[];
    staleAfterDays: number;
    model: string;
  };
}

const DEFAULT_SETTINGS: ProjectConfig['settings'] = {
  defaultTokenBudget: 50_000,
  defaultAgents: ['finint', 'osint', 'legint', 'temporal'],
  staleAfterDays: 30,
  model: 'claude-sonnet-4-20250514',
};

export function initProject(dir: string, subject: SubjectConfig): ProjectConfig {
  const newsroomDir = join(dir, '.newsroom');
  mkdirSync(join(newsroomDir, 'knowledge'), { recursive: true });
  mkdirSync(join(newsroomDir, 'cache'), { recursive: true });

  const config: ProjectConfig = {
    subject,
    settings: DEFAULT_SETTINGS,
  };

  writeFileSync(join(newsroomDir, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(newsroomDir, 'patterns.md'), '# Research Patterns\n\nNo patterns learned yet. Run your first research wave.\n');

  return config;
}

export function loadProject(dir: string): ProjectConfig | null {
  const configPath = join(dir, '.newsroom', 'config.json');
  if (!existsSync(configPath)) return null;
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}
