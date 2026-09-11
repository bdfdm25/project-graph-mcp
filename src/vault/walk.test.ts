import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { collectMarkdownFiles } from './walk.js';

const ROOT = '/tmp/pgmcp-walk-test';
const VAULT = `${ROOT}/vault`;

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(`${VAULT}/Areas`, { recursive: true });
  mkdirSync(`${VAULT}/.obsidian`, { recursive: true });
  mkdirSync(`${ROOT}/outside/notes`, { recursive: true });

  writeFileSync(`${VAULT}/Areas/note.md`, '# Note\n');
  writeFileSync(`${VAULT}/Areas/legacy-handoff.claude.md`, '# Legacy handoff\n');
  writeFileSync(`${VAULT}/Areas/not-markdown.txt`, 'ignored\n');
  writeFileSync(`${VAULT}/.obsidian/graph.md`, '# hidden\n');
  writeFileSync(`${ROOT}/outside/conventions.md`, '# Conventions\n');
  writeFileSync(`${ROOT}/outside/notes/deep.md`, '# Deep\n');

  symlinkSync(`${ROOT}/outside/conventions.md`, `${VAULT}/Areas/conventions.md`);
  symlinkSync(`${ROOT}/outside/notes`, `${VAULT}/Areas/linked-dir`);
  symlinkSync(`${ROOT}/outside/gone.md`, `${VAULT}/Areas/dangling.md`);
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('collectMarkdownFiles', () => {
  const found = () => collectMarkdownFiles(VAULT).map((p) => p.replace(`${VAULT}/`, '')).sort();

  it('finds ordinary markdown notes', () => {
    expect(found()).toContain('Areas/note.md');
  });

  it('follows a symlinked note, so a note can live outside the vault', () => {
    expect(found()).toContain('Areas/conventions.md');
  });

  it('indexes legacy .claude.md handoffs rather than hiding session history', () => {
    expect(found()).toContain('Areas/legacy-handoff.claude.md');
  });

  it('ignores a dangling symlink instead of throwing', () => {
    expect(found()).not.toContain('Areas/dangling.md');
  });

  it('does not walk into symlinked directories', () => {
    expect(found().some((p) => p.includes('linked-dir'))).toBe(false);
  });

  it('skips hidden directories and non-markdown files', () => {
    expect(found().some((p) => p.startsWith('.obsidian'))).toBe(false);
    expect(found().some((p) => p.endsWith('.txt'))).toBe(false);
  });
});
