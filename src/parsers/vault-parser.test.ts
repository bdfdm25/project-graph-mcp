import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseVaultNote } from './vault-parser.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pgmcp-vault-'));

function writeFixture(name: string, content: string): string {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('parseVaultNote', () => {
  it('returns null for non-existent file', () => {
    expect(parseVaultNote('/no/such/file.md')).toBeNull();
  });

  it('extracts title from frontmatter', () => {
    const p = writeFixture('title.md', '---\ntitle: My Note\n---\nbody');
    expect(parseVaultNote(p)?.title).toBe('My Note');
  });

  it('falls back to filename when no title in frontmatter', () => {
    const p = writeFixture('my-note-slug.md', 'just body');
    expect(parseVaultNote(p)?.title).toBe('my note slug');
  });

  it('extracts tags as array', () => {
    const p = writeFixture('tags-array.md', '---\ntags:\n  - foo\n  - bar\n---\nbody');
    expect(parseVaultNote(p)?.tags).toEqual(['foo', 'bar']);
  });

  it('normalizes single string tag to array', () => {
    const p = writeFixture('tag-string.md', '---\ntags: single\n---\nbody');
    expect(parseVaultNote(p)?.tags).toEqual(['single']);
  });

  it('returns empty tags when none defined', () => {
    const p = writeFixture('no-tags.md', '---\ntitle: No Tags\n---\nbody');
    expect(parseVaultNote(p)?.tags).toEqual([]);
  });

  it('extracts simple wikilinks', () => {
    const p = writeFixture('links.md', 'See [[other-note]] and [[another]].');
    const note = parseVaultNote(p)!;
    expect(note.links).toContain('other-note');
    expect(note.links).toContain('another');
  });

  it('extracts wikilinks with aliases', () => {
    const p = writeFixture('alias.md', '[[real-note|Alias Text]]');
    expect(parseVaultNote(p)?.links).toContain('real-note');
  });

  it('extracts wikilinks with path separators', () => {
    const p = writeFixture('path-link.md', '[[folder/sub/note]]');
    expect(parseVaultNote(p)?.links).toContain('folder/sub/note');
  });

  it('extracts wikilinks from frontmatter and body both', () => {
    const p = writeFixture('both.md', '---\ntitle: Test\n---\nbody [[from-body]]');
    expect(parseVaultNote(p)?.links).toContain('from-body');
  });

  it('returns stable id derived from path', () => {
    const p = writeFixture('stable.md', 'content');
    const a = parseVaultNote(p)!;
    const b = parseVaultNote(p)!;
    expect(a.id).toBe(b.id);
    expect(a.id).toHaveLength(16);
  });

  it('returns raw content and parsed body separately', () => {
    const p = writeFixture('raw.md', '---\ntitle: T\n---\nbody text');
    const note = parseVaultNote(p)!;
    expect(note.raw).toContain('---');
    expect(note.content).toContain('body text');
    expect(note.content).not.toContain('---');
  });
});
