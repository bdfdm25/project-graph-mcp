import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDependencies, getBlastRadius } from './algorithms.js';
import { getEdgesForProject } from './store.js';

vi.mock('./store.js', () => ({
  getEdgesForProject: vi.fn(),
}));

const mockEdges = vi.mocked(getEdgesForProject);

function edge(from: string, to: string) {
  return { id: '', project_id: 'p1', source_file: from, from_node: from, to_node: to, type: 'import' };
}

describe('getDependencies', () => {
  beforeEach(() => mockEdges.mockReset());

  it('returns empty result when file has no edges', () => {
    mockEdges.mockReturnValue([]);
    expect(getDependencies('p1', '/a.ts')).toEqual({ file: '/a.ts', direct: [], transitive: [] });
  });

  it('returns direct import', () => {
    mockEdges.mockReturnValue([edge('/a.ts', '/b.ts')]);
    const r = getDependencies('p1', '/a.ts');
    expect(r.direct).toEqual(['/b.ts']);
    expect(r.transitive).toEqual([]);
  });

  it('separates direct from transitive imports', () => {
    mockEdges.mockReturnValue([
      edge('/a.ts', '/b.ts'),
      edge('/b.ts', '/c.ts'),
    ]);
    const r = getDependencies('p1', '/a.ts');
    expect(r.direct).toContain('/b.ts');
    expect(r.transitive).toContain('/c.ts');
    expect(r.transitive).not.toContain('/b.ts');
  });

  it('handles deep transitive chain', () => {
    mockEdges.mockReturnValue([
      edge('/a.ts', '/b.ts'),
      edge('/b.ts', '/c.ts'),
      edge('/c.ts', '/d.ts'),
    ]);
    const r = getDependencies('p1', '/a.ts');
    expect(r.transitive).toContain('/c.ts');
    expect(r.transitive).toContain('/d.ts');
  });

  it('does not infinite-loop on circular deps', () => {
    mockEdges.mockReturnValue([
      edge('/a.ts', '/b.ts'),
      edge('/b.ts', '/a.ts'),
    ]);
    expect(() => getDependencies('p1', '/a.ts')).not.toThrow();
  });

  it('returns empty for file not in graph', () => {
    mockEdges.mockReturnValue([edge('/a.ts', '/b.ts')]);
    expect(getDependencies('p1', '/unknown.ts')).toEqual({
      file: '/unknown.ts',
      direct: [],
      transitive: [],
    });
  });

  it('handles multiple imports from same source node', () => {
    mockEdges.mockReturnValue([
      edge('/a.ts', '/b.ts'),
      edge('/a.ts', '/c.ts'),
    ]);
    const r = getDependencies('p1', '/a.ts');
    expect(r.direct).toContain('/b.ts');
    expect(r.direct).toContain('/c.ts');
  });
});

describe('getBlastRadius', () => {
  beforeEach(() => mockEdges.mockReset());

  it('returns empty when no files depend on target', () => {
    mockEdges.mockReturnValue([]);
    expect(getBlastRadius('p1', '/a.ts')).toEqual({ file: '/a.ts', affected: [] });
  });

  it('returns direct dependents', () => {
    mockEdges.mockReturnValue([edge('/b.ts', '/a.ts')]);
    const r = getBlastRadius('p1', '/a.ts');
    expect(r.affected).toContain('/b.ts');
  });

  it('returns transitive dependents', () => {
    mockEdges.mockReturnValue([
      edge('/b.ts', '/a.ts'),
      edge('/c.ts', '/b.ts'),
    ]);
    const r = getBlastRadius('p1', '/a.ts');
    expect(r.affected).toContain('/b.ts');
    expect(r.affected).toContain('/c.ts');
  });

  it('does not infinite-loop on circular deps', () => {
    mockEdges.mockReturnValue([
      edge('/a.ts', '/b.ts'),
      edge('/b.ts', '/a.ts'),
    ]);
    expect(() => getBlastRadius('p1', '/a.ts')).not.toThrow();
  });

  it('returns empty for file not depended upon by anyone', () => {
    mockEdges.mockReturnValue([edge('/a.ts', '/b.ts')]);
    expect(getBlastRadius('p1', '/a.ts')).toEqual({ file: '/a.ts', affected: [] });
  });

  it('handles multiple dependents on same target', () => {
    mockEdges.mockReturnValue([
      edge('/b.ts', '/a.ts'),
      edge('/c.ts', '/a.ts'),
    ]);
    const r = getBlastRadius('p1', '/a.ts');
    expect(r.affected).toContain('/b.ts');
    expect(r.affected).toContain('/c.ts');
  });
});
