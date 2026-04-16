import { getEdgesForProject, type EdgeRow } from './store.js';

// ─── Graph traversal ──────────────────────────────────────────────────────────

function buildAdjacency(edges: EdgeRow[]): {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
} {
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();

  for (const edge of edges) {
    if (!forward.has(edge.from_node)) forward.set(edge.from_node, new Set());
    forward.get(edge.from_node)!.add(edge.to_node);

    if (!reverse.has(edge.to_node)) reverse.set(edge.to_node, new Set());
    reverse.get(edge.to_node)!.add(edge.from_node);
  }

  return { forward, reverse };
}

function bfs(start: string, graph: Map<string, Set<string>>): Set<string> {
  const visited = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    const neighbors = graph.get(node);
    if (neighbors) {
      for (const n of neighbors) queue.push(n);
    }
  }
  visited.delete(start);
  return visited;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface DependencyResult {
  file: string;
  direct: string[];
  transitive: string[];
}

export function getDependencies(projectId: string, filePath: string): DependencyResult {
  const edges = getEdgesForProject(projectId);
  const { forward } = buildAdjacency(edges);

  const direct = [...(forward.get(filePath) ?? [])];
  const all = bfs(filePath, forward);

  return {
    file: filePath,
    direct,
    transitive: [...all].filter((f) => !direct.includes(f)),
  };
}

export interface BlastRadiusResult {
  file: string;
  affected: string[];
}

export function getBlastRadius(projectId: string, filePath: string): BlastRadiusResult {
  const edges = getEdgesForProject(projectId);
  const { reverse } = buildAdjacency(edges);

  const affected = [...bfs(filePath, reverse)];

  return {
    file: filePath,
    affected,
  };
}
