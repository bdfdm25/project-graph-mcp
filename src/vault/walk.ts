/**
 * One traversal of the vault, shared by every reader.
 *
 * It used to be written twice with different rules — one copy skipped
 * `*.claude.md`, the other did not — so `search_vault` and `get_vault_index`
 * disagreed about what the vault contained.
 */

import { readdirSync, statSync } from 'fs';
import { extname, join } from 'path';

/**
 * Every markdown file under `dir`, hidden entries excluded.
 *
 * Symlinked files are followed, because a note can legitimately be a link to a
 * file that lives elsewhere — the conventions note points at the canonical
 * CLAUDE.md. Symlinked *directories* are not followed: they can form cycles and
 * pull an entire external tree into the vault index.
 */
export function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];

  function isMarkdownFile(entry: import('fs').Dirent<string>, fullPath: string): boolean {
    if (extname(entry.name) !== '.md') return false;
    if (entry.isFile()) return true;
    if (!entry.isSymbolicLink()) return false;
    try {
      return statSync(fullPath).isFile();
    } catch {
      return false; // dangling link
    }
  }

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
      } else if (isMarkdownFile(entry, full)) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}
