import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export interface GrammarConfig {
  name: string;
  extensions: string[];
}

export interface Config {
  vault: string;
  grammars: GrammarConfig[];
  ignore: string[];
  db: string;
  watchDebounce: number;
  trustedRoots: string[];
}

const DEFAULT_CONFIG: Config = {
  vault: join(homedir(), 'Development', 'obsidian-vault'),
  grammars: [
    { name: 'typescript', extensions: ['.ts', '.tsx'] },
    { name: 'javascript', extensions: ['.js', '.jsx', '.mjs'] },
    { name: 'python', extensions: ['.py'] },
  ],
  ignore: ['node_modules', 'dist', '.git', 'coverage', '__pycache__', '.next', '.angular'],
  db: join(homedir(), '.project-graph', 'graph.db'),
  watchDebounce: 300,
  trustedRoots: [join(homedir(), 'Development')],
};

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function loadConfig(): Config {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  const candidates = [
    join(process.cwd(), 'project-graph.config.json'),
    join(projectRoot, 'project-graph.config.json'),
    join(homedir(), '.project-graph', 'config.json'),
  ];

  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<Config>;
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        vault: expandHome(parsed.vault ?? DEFAULT_CONFIG.vault),
        db: expandHome(parsed.db ?? DEFAULT_CONFIG.db),
        trustedRoots: (parsed.trustedRoots ?? DEFAULT_CONFIG.trustedRoots).map(expandHome),
      };
    } catch {
      // not found — try next candidate
    }
  }

  return DEFAULT_CONFIG;
}

export const config = loadConfig();
