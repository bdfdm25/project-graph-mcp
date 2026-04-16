import { readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { config } from '../config.js';
import { parseVaultNote, type VaultNote } from '../parsers/vault-parser.js';

// ─── Vault file discovery ─────────────────────────────────────────────────────

function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(current: string): void {
    let entries: import('fs').Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: 'utf-8' });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

function loadAllNotes(): VaultNote[] {
  const files = collectMarkdownFiles(config.vault);
  return files.flatMap((f) => {
    const note = parseVaultNote(f);
    return note ? [note] : [];
  });
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  path: string;
  title: string;
  tags: string[];
  snippet: string;   // surrounding context of the match
  score: number;     // match count (simple ranking)
}

function buildSnippet(text: string, query: string, contextChars = 120): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, contextChars).replace(/\n/g, ' ');
  const start = Math.max(0, idx - contextChars / 2);
  const end = Math.min(text.length, idx + query.length + contextChars / 2);
  const snippet = text.slice(start, end).replace(/\n/g, ' ');
  return (start > 0 ? '…' : '') + snippet + (end < text.length ? '…' : '');
}

function countOccurrences(text: string, query: string): number {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let count = 0;
  let pos = 0;
  while ((pos = lower.indexOf(q, pos)) !== -1) { count++; pos += q.length; }
  return count;
}

export function searchVault(query: string, limit = 20): SearchResult[] {
  const notes = loadAllNotes();
  const q = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const note of notes) {
    const haystack = note.raw;
    const score = countOccurrences(haystack, q);
    if (score === 0) continue;
    results.push({
      path: note.path.replace(config.vault + '/', ''),
      title: note.title,
      tags: note.tags,
      snippet: buildSnippet(haystack, query),
      score,
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── Specific reads ───────────────────────────────────────────────────────────

export function getConventions(): string | null {
  const conventionsPath = join(config.vault, 'Areas', 'claude-code-workflow.md');
  const note = parseVaultNote(conventionsPath);
  return note ? note.content : null;
}

export function getNoteByRelPath(relPath: string): VaultNote | null {
  return parseVaultNote(join(config.vault, relPath));
}

// ─── Recent decisions ─────────────────────────────────────────────────────────

export interface DecisionSummary {
  title: string;
  date: string;
  status: string;
  path: string;
  snippet: string;
}

export function getRecentDecisions(limit = 10): DecisionSummary[] {
  const decisionsDir = join(config.vault, 'Resources', 'decisions');
  const files = collectMarkdownFiles(decisionsDir)
    .sort()
    .reverse()
    .slice(0, limit);

  return files.flatMap((f) => {
    const note = parseVaultNote(f);
    if (!note) return [];
    return [{
      title: note.title,
      date: String(note.frontmatter['date'] ?? ''),
      status: String(note.frontmatter['status'] ?? ''),
      path: note.path.replace(config.vault + '/', ''),
      snippet: note.content.slice(0, 200).replace(/\n/g, ' ').trim(),
    }];
  });
}
