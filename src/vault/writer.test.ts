import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';

const TEST_VAULT = '/tmp/pgmcp-writer-test';

vi.mock('../config.js', () => ({
  config: {
    vault: TEST_VAULT,
    trustedRoots: ['/tmp'],
    grammars: [],
    ignore: [],
    db: '/tmp/pgmcp-test.db',
    watchDebounce: 300,
  },
}));

// Import after mock is registered
const { writeDecision, writeSessionHandoff, writeProjectSummary, graduateObservations, appendBacklink } =
  await import('./writer.js');

beforeAll(() => fs.mkdirSync(TEST_VAULT, { recursive: true }));
afterAll(() => fs.rmSync(TEST_VAULT, { recursive: true, force: true }));

function readNote(absPath: string) {
  const raw = fs.readFileSync(absPath, 'utf-8');
  return matter(raw);
}

describe('writeDecision', () => {
  it('creates file under Resources/decisions/', () => {
    const p = writeDecision({ title: 'Use Vitest', body: 'Reason: ESM native.' });
    expect(p).toContain('Resources/decisions/');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('slugifies title for filename', () => {
    const p = writeDecision({ title: 'My Great Decision', body: 'body' });
    expect(path.basename(p)).toMatch(/my-great-decision/);
  });

  it('defaults status to accepted', () => {
    const p = writeDecision({ title: 'Default Status', body: 'body' });
    expect(readNote(p).data.status).toBe('accepted');
  });

  it('respects custom status', () => {
    const p = writeDecision({ title: 'Rejected Decision', body: 'body', status: 'rejected' });
    expect(readNote(p).data.status).toBe('rejected');
  });

  it('includes decision tag always', () => {
    const p = writeDecision({ title: 'Tagged Decision', body: 'body', tags: ['extra'] });
    expect(readNote(p).data.tags).toContain('decision');
    expect(readNote(p).data.tags).toContain('extra');
  });

  it('sanitizes frontmatter values with colons', () => {
    const p = writeDecision({ title: 'URL: https://example.com', body: 'body' });
    const raw = fs.readFileSync(p, 'utf-8');
    // Value must be quoted when it contains ':'
    expect(raw).toContain('"URL: https://example.com"');
  });

  it('preserves body content', () => {
    const body = '## Rationale\n\nThis is important.';
    const p = writeDecision({ title: 'Body Test', body });
    expect(readNote(p).content.trim()).toContain('Rationale');
  });
});

describe('writeSessionHandoff', () => {
  it('creates file under Archive/sessions/', () => {
    const p = writeSessionHandoff({ summary: 'Session done.' });
    expect(p).toContain('Archive/sessions/');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('filename contains timestamp without colons', () => {
    const p = writeSessionHandoff({ summary: 'test' });
    const name = path.basename(p);
    expect(name).not.toContain(':');
    expect(name).toMatch(/handoff\.md$/);
  });

  it('includes handoff tag', () => {
    const p = writeSessionHandoff({ summary: 'test', tags: ['career'] });
    expect(readNote(p).data.tags).toContain('handoff');
    expect(readNote(p).data.tags).toContain('career');
  });

  it('writes project to frontmatter when provided', () => {
    const p = writeSessionHandoff({ summary: 'test', project: 'my-project' });
    expect(readNote(p).data.project).toBe('my-project');
  });
});

describe('writeProjectSummary', () => {
  it('creates file at Resources/projects/<slug>/summary.md', () => {
    const p = writeProjectSummary({ projectName: 'My App', summary: 'summary', sourceDoc: 'README.md' });
    expect(p).toContain('Resources/projects/my-app/summary.md');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('slugifies project name', () => {
    const p = writeProjectSummary({ projectName: 'Hello World App', summary: 's', sourceDoc: 'doc.md' });
    expect(p).toContain('hello-world-app');
  });

  it('sets status to current', () => {
    const p = writeProjectSummary({ projectName: 'Status Test', summary: 's', sourceDoc: 'doc.md' });
    expect(readNote(p).data.status).toBe('current');
  });
});

describe('appendBacklink', () => {
  it('does nothing when target note does not exist', () => {
    expect(() => appendBacklink('Resources/no-such.md', 'sym', 'Title')).not.toThrow();
  });

  it('appends backlink to existing note', () => {
    const noteRel = 'Resources/backlink-test.md';
    const notePath = `${TEST_VAULT}/${noteRel}`;
    fs.mkdirSync(`${TEST_VAULT}/Resources`, { recursive: true });
    fs.writeFileSync(notePath, '# Note\n\nbody\n', 'utf-8');
    appendBacklink(noteRel, 'mySymbol', 'Other Note');
    expect(fs.readFileSync(notePath, 'utf-8')).toContain('[[Other Note]]');
  });

  it('does not duplicate an existing backlink', () => {
    const noteRel = 'Resources/backlink-dedup.md';
    const notePath = `${TEST_VAULT}/${noteRel}`;
    fs.mkdirSync(`${TEST_VAULT}/Resources`, { recursive: true });
    fs.writeFileSync(notePath, '# Note\n', 'utf-8');
    appendBacklink(noteRel, 'sym', 'Same Note');
    appendBacklink(noteRel, 'sym', 'Same Note');
    const content = fs.readFileSync(notePath, 'utf-8');
    expect(content.split('[[Same Note]]').length - 1).toBe(1);
  });
});

describe('graduateObservations', () => {
  it('creates file under Resources/graduated/', () => {
    const obs = [
      { id: 'o1', session_id: 's1', project_tag: 'test', type: 'decision' as const, content: 'decided x', created_at: Date.now(), context: null, tags: null, promoted: 0 },
      { id: 'o2', session_id: 's1', project_tag: 'test', type: 'note' as const, content: 'noted y', created_at: Date.now(), context: null, tags: null, promoted: 0 },
    ];
    const p = graduateObservations({ title: 'Test Grad', observations: obs });
    expect(p).toContain('Resources/graduated/');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('groups observations by type in body', () => {
    const obs = [
      { id: 'o1', session_id: 's1', project_tag: null, type: 'decision' as const, content: 'chose A', created_at: Date.now(), context: null, tags: null, promoted: 0 },
      { id: 'o2', session_id: 's1', project_tag: null, type: 'error' as const, content: 'broke B', created_at: Date.now(), context: null, tags: null, promoted: 0 },
    ];
    const p = graduateObservations({ title: 'Grouped', observations: obs });
    const content = fs.readFileSync(p, 'utf-8');
    expect(content).toContain('## Decisions');
    expect(content).toContain('## Errors & Fixes');
  });
});
