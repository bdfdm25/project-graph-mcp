import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: {
    vault: '/tmp/pgmcp-tools-test-vault',
    trustedRoots: ['/tmp'],
    grammars: [{ name: 'typescript', extensions: ['.ts', '.tsx'] }],
    ignore: [],
    db: '/tmp/pgmcp-tools-test.db',
    watchDebounce: 300,
  },
}));

vi.mock('../graph/store.js', () => ({
  listProjects: vi.fn(),
  getProjectByPath: vi.fn(),
  upsertSession: vi.fn(),
  closeSession: vi.fn(),
  insertObservation: vi.fn(),
  searchObservations: vi.fn(),
  getSessionTimeline: vi.fn(),
  getObservation: vi.fn(),
  listSessions: vi.fn(),
  searchNodes: vi.fn(),
}));

vi.mock('../graph/builder.js', () => ({ indexProject: vi.fn() }));
vi.mock('../graph/algorithms.js', () => ({ getDependencies: vi.fn(), getBlastRadius: vi.fn() }));
vi.mock('../graph/communities.js', () => ({ getModuleContext: vi.fn(), findSimilarFiles: vi.fn() }));
vi.mock('../graph/watcher.js', () => ({ getActiveWatcherInfo: vi.fn() }));

vi.mock('../vault/reader.js', () => ({
  searchVault: vi.fn(),
  getConventions: vi.fn(),
  getRecentDecisions: vi.fn(),
}));

vi.mock('../vault/writer.js', () => ({
  writeDecision: vi.fn(),
  writeSessionHandoff: vi.fn(),
  writeProjectSummary: vi.fn(),
  graduateObservations: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

const { handleTool } = await import('./tools.js');

import { listProjects, getProjectByPath, searchObservations, getSessionTimeline, getObservation, listSessions, searchNodes } from '../graph/store.js';
import { getActiveWatcherInfo } from '../graph/watcher.js';
import { searchVault, getConventions, getRecentDecisions } from '../vault/reader.js';
import { writeDecision, writeSessionHandoff, writeProjectSummary } from '../vault/writer.js';
import { existsSync } from 'fs';

function errText(result: Awaited<ReturnType<typeof handleTool>>) {
  return JSON.parse(result.content[0].text).error as string;
}

function okData(result: Awaited<ReturnType<typeof handleTool>>) {
  return JSON.parse(result.content[0].text);
}

describe('handleTool — unknown tool', () => {
  it('returns error for unknown tool name', async () => {
    const r = await handleTool('no_such_tool', {});
    expect(errText(r)).toContain('Unknown tool');
  });
});

describe('get_active_project', () => {
  it('errors when cwd is missing', async () => {
    expect(errText(await handleTool('get_active_project', {}))).toContain('cwd is required');
  });

  it('errors when path is outside trusted roots', async () => {
    const r = await handleTool('get_active_project', { cwd: '/etc/passwd' });
    expect(errText(r)).toContain('Path not allowed');
  });

  it('errors when directory does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const r = await handleTool('get_active_project', { cwd: '/tmp/no-such-dir' });
    expect(errText(r)).toContain('Directory not found');
  });
});

describe('index_project', () => {
  it('errors when path is missing', async () => {
    expect(errText(await handleTool('index_project', {}))).toContain('path is required');
  });

  it('errors when path is outside trusted roots', async () => {
    const r = await handleTool('index_project', { path: '/var/secret' });
    expect(errText(r)).toContain('Path not allowed');
  });
});

describe('get_dependencies', () => {
  it('errors when project_path is missing', async () => {
    expect(errText(await handleTool('get_dependencies', { file: '/tmp/a.ts' }))).toContain('project_path is required');
  });

  it('errors when file is missing', async () => {
    expect(errText(await handleTool('get_dependencies', { project_path: '/tmp/proj' }))).toContain('file is required');
  });

  it('errors when project is not indexed', async () => {
    vi.mocked(getProjectByPath).mockReturnValue(undefined);
    const r = await handleTool('get_dependencies', { project_path: '/tmp/proj', file: '/tmp/proj/a.ts' });
    expect(errText(r)).toContain('not indexed');
  });
});

describe('search_vault', () => {
  beforeEach(() => vi.mocked(searchVault).mockReturnValue([]));

  it('errors when query is missing', async () => {
    expect(errText(await handleTool('search_vault', {}))).toContain('query is required');
  });

  it('wraps snippets in external-content tag', async () => {
    vi.mocked(searchVault).mockReturnValue([
      { title: 'Note', path: '/vault/note.md', tags: [], snippet: 'some content', score: 1 },
    ]);
    const r = okData(await handleTool('search_vault', { query: 'test' }));
    expect(r.results[0].snippet).toContain('<external-content');
    expect(r.results[0].snippet).toContain('some content');
  });
});

describe('search_observations', () => {
  it('errors when query is missing', async () => {
    expect(errText(await handleTool('search_observations', {}))).toContain('query is required');
  });

  it('wraps observation content in external-content tag', async () => {
    vi.mocked(searchObservations).mockReturnValue([
      { id: 'o1', session_id: 's1', project_tag: null, type: 'note', content: 'secret', created_at: 0, context: null, tags: null, promoted: 0, rank: 1 },
    ]);
    const r = okData(await handleTool('search_observations', { query: 'test' }));
    expect(r.results[0].content).toContain('<external-content');
    expect(r.results[0].content).toContain('secret');
  });
});

describe('list_projects', () => {
  it('returns mocked project list', async () => {
    vi.mocked(listProjects).mockReturnValue([{ id: 'p1', root_path: '/tmp/proj', name: 'proj', last_indexed_at: 0 }]);
    const r = okData(await handleTool('list_projects', {}));
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].name).toBe('proj');
  });
});

describe('get_watcher_status', () => {
  it('returns watching: false when no watcher', async () => {
    vi.mocked(getActiveWatcherInfo).mockReturnValue(null);
    const r = okData(await handleTool('get_watcher_status', {}));
    expect(r.watching).toBe(false);
  });
});

describe('get_conventions', () => {
  it('errors when conventions file not found', async () => {
    vi.mocked(getConventions).mockReturnValue(null);
    expect(errText(await handleTool('get_conventions', {}))).toContain('not found');
  });

  it('returns content when found', async () => {
    vi.mocked(getConventions).mockReturnValue('# Conventions');
    const r = okData(await handleTool('get_conventions', {}));
    expect(r.content).toBe('# Conventions');
  });
});

describe('get_project_context', () => {
  it('returns conventions and decisions', async () => {
    vi.mocked(getConventions).mockReturnValue('do X');
    vi.mocked(getRecentDecisions).mockReturnValue([]);
    const r = okData(await handleTool('get_project_context', {}));
    expect(r.conventions).toBe('do X');
    expect(r.recent_decisions).toEqual([]);
  });
});

describe('write_decision', () => {
  it('errors when title is missing', async () => {
    expect(errText(await handleTool('write_decision', { body: 'body' }))).toContain('title is required');
  });

  it('errors when body is missing', async () => {
    expect(errText(await handleTool('write_decision', { title: 'T' }))).toContain('body is required');
  });

  it('calls writeDecision and returns created path', async () => {
    vi.mocked(writeDecision).mockReturnValue('/tmp/pgmcp-tools-test-vault/Resources/decisions/2026-01-01-t.md');
    const r = okData(await handleTool('write_decision', { title: 'T', body: 'B' }));
    expect(r.created).toContain('Resources/decisions');
  });
});

describe('write_session_handoff', () => {
  it('errors when summary is missing', async () => {
    expect(errText(await handleTool('write_session_handoff', {}))).toContain('summary is required');
  });

  it('calls writeSessionHandoff and returns created path', async () => {
    vi.mocked(writeSessionHandoff).mockReturnValue('/tmp/pgmcp-tools-test-vault/Archive/sessions/2026-handoff.md');
    const r = okData(await handleTool('write_session_handoff', { summary: 'done' }));
    expect(r.created).toContain('Archive/sessions');
  });
});

describe('close_session', () => {
  it('errors when session_id is missing', async () => {
    expect(errText(await handleTool('close_session', {}))).toContain('session_id is required');
  });
});

describe('get_observation', () => {
  it('errors when id is missing', async () => {
    expect(errText(await handleTool('get_observation', {}))).toContain('id is required');
  });

  it('errors when observation not found', async () => {
    vi.mocked(getObservation).mockReturnValue(undefined);
    expect(errText(await handleTool('get_observation', { id: 'x' }))).toContain('not found');
  });
});

describe('list_sessions', () => {
  it('returns session list', async () => {
    vi.mocked(listSessions).mockReturnValue([]);
    const r = okData(await handleTool('list_sessions', {}));
    expect(r.sessions).toEqual([]);
  });
});

describe('get_session_timeline', () => {
  it('errors when session_id is missing', async () => {
    expect(errText(await handleTool('get_session_timeline', {}))).toContain('session_id is required');
  });

  it('wraps observation content in external-content tag', async () => {
    vi.mocked(getSessionTimeline).mockReturnValue([
      { id: 'o1', session_id: 's1', project_tag: null, type: 'note', content: 'payload', created_at: 0, context: null, tags: null, promoted: 0 },
    ]);
    const r = okData(await handleTool('get_session_timeline', { session_id: 's1' }));
    expect(r.observations[0].content).toContain('<external-content');
  });
});

describe('write_observation', () => {
  it('errors when session_id is missing', async () => {
    expect(errText(await handleTool('write_observation', { type: 'note', content: 'x' }))).toContain('session_id is required');
  });

  it('errors when content is missing', async () => {
    expect(errText(await handleTool('write_observation', { session_id: 's1', type: 'note' }))).toContain('content is required');
  });

  it('errors on invalid type', async () => {
    expect(errText(await handleTool('write_observation', { session_id: 's1', type: 'invalid', content: 'x' }))).toContain('type must be one of');
  });
});
