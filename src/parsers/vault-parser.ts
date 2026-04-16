import matter from 'gray-matter';
import { readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { basename } from 'path';

export interface VaultNote {
  id: string;
  path: string;        // absolute path
  title: string;
  tags: string[];
  links: string[];     // [[wikilink]] targets
  frontmatter: Record<string, unknown>;
  content: string;     // body only (no frontmatter)
  raw: string;         // full file content
  mtime: number;
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?]]/g;

export function parseVaultNote(filePath: string): VaultNote | null {
  let raw: string;
  let mtime: number;
  try {
    raw = readFileSync(filePath, 'utf-8');
    mtime = statSync(filePath).mtimeMs;
  } catch {
    return null;
  }

  const { data: frontmatter, content } = matter(raw);

  const title =
    (frontmatter['title'] as string | undefined) ??
    basename(filePath, '.md').replace(/-/g, ' ');

  const tags: string[] = Array.isArray(frontmatter['tags'])
    ? (frontmatter['tags'] as string[]).map(String)
    : typeof frontmatter['tags'] === 'string'
    ? [frontmatter['tags']]
    : [];

  const links: string[] = [];
  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(raw)) !== null) {
    links.push(match[1].trim());
  }

  const id = createHash('sha256').update(filePath).digest('hex').slice(0, 16);

  return { id, path: filePath, title, tags, links, frontmatter, content, raw, mtime };
}
