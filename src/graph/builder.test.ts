import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, unlinkSync } from 'fs';

const ROOT = '/tmp/pgmcp-builder-test';

vi.mock('../config.js', () => ({
  config: {
    vault: `${ROOT}/vault`,
    trustedRoots: [ROOT],
    grammars: [{ name: 'typescript', extensions: ['.ts'] }],
    ignore: ['node_modules'],
    db: `${ROOT}/graph.db`,
    watchDebounce: 300,
  },
}));

vi.mock('./watcher.js', () => ({ startWatcher: vi.fn(), getActiveWatcherInfo: vi.fn(() => null) }));

const { indexProject } = await import('./builder.js');
const { getDb, getEdgeTargetsForFile, getFilesForProject, getProjectByPath } = await import('./store.js');

const PROJECT = `${ROOT}/proj`;

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(`${PROJECT}/src`, { recursive: true });
  writeFileSync(`${PROJECT}/src/helper.ts`, 'export function helper() { return 1; }\n');
  writeFileSync(`${PROJECT}/src/main.ts`, 'import { helper } from "./helper.js";\nexport const main = () => helper();\n');
});

afterAll(() => {
  getDb().close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('indexProject', () => {
  it('resolves an ESM .js specifier to the .ts file on disk', () => {
    const result = indexProject(PROJECT);
    expect(result.filesIndexed).toBe(2);
    expect(getEdgeTargetsForFile(result.projectId, `${PROJECT}/src/main.ts`)).toEqual([
      `${PROJECT}/src/helper.ts`,
    ]);
  });

  it('skips unchanged files on a re-run', () => {
    const result = indexProject(PROJECT);
    expect(result).toMatchObject({ filesIndexed: 0, filesRepaired: 0, filesSkipped: 2 });
  });

  it('re-parses an unchanged file whose stored import points at a missing path', () => {
    const project = getProjectByPath(PROJECT)!;
    // Simulate the miss a parse makes when its target is written a moment later.
    getDb()
      .prepare('UPDATE edges SET to_node = ? WHERE source_file = ?')
      .run(`${PROJECT}/src/helper.js`, `${PROJECT}/src/main.ts`);

    const result = indexProject(PROJECT);
    expect(result.filesRepaired).toBe(1);
    expect(getEdgeTargetsForFile(project.id, `${PROJECT}/src/main.ts`)).toEqual([
      `${PROJECT}/src/helper.ts`,
    ]);
  });

  it('forgets a file that was deleted from disk, fingerprint row included', () => {
    const project = getProjectByPath(PROJECT)!;
    unlinkSync(`${PROJECT}/src/helper.ts`);

    indexProject(PROJECT);
    const paths = getFilesForProject(project.id).map((row) => row.path);
    expect(paths).not.toContain(`${PROJECT}/src/helper.ts`);
    expect(paths).toContain(`${PROJECT}/src/main.ts`);
  });
});
