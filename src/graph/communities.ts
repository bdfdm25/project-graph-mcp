import { DirectedGraph } from 'graphology';
import louvainModule from 'graphology-communities-louvain';
import { getEdgesForProject, setClusterForFile, getNodesInCluster, getAllNodesForProject } from './store.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const louvain = (louvainModule as any).default ?? louvainModule;

// ─── Build in-memory graphology graph from DB edges ───────────────────────────

function buildGraph(projectId: string): DirectedGraph {
  const edges = getEdgesForProject(projectId);
  const graph = new DirectedGraph();

  for (const edge of edges) {
    if (!graph.hasNode(edge.from_node)) graph.addNode(edge.from_node);
    if (!graph.hasNode(edge.to_node)) graph.addNode(edge.to_node);
    if (!graph.hasEdge(edge.from_node, edge.to_node)) {
      graph.addEdge(edge.from_node, edge.to_node);
    }
  }

  return graph;
}

// ─── Auto-derive cluster name from common path prefix ────────────────────────

function deriveClusterName(files: string[], projectRoot: string): string {
  if (files.length === 0) return 'unknown';

  const relative = files.map((f) =>
    f.startsWith(projectRoot + '/') ? f.slice(projectRoot.length + 1) : f
  );

  // Find common directory prefix
  const parts = relative[0].split('/');
  let common: string[] = [];

  for (let depth = 0; depth < parts.length - 1; depth++) {
    const segment = parts.slice(0, depth + 1).join('/');
    if (relative.every((p) => p.startsWith(segment + '/'))) {
      common = parts.slice(0, depth + 1);
    } else {
      break;
    }
  }

  return common.length > 0 ? common.join('/') : relative[0].split('/')[0] ?? 'root';
}

// ─── Run community detection and persist results ──────────────────────────────

export interface ClusterInfo {
  id: number;
  name: string;
  files: string[];
  size: number;
}

export function detectAndStoreCommunities(
  projectId: string,
  projectRoot: string,
): ClusterInfo[] {
  const graph = buildGraph(projectId);

  if (graph.order === 0) return [];

  // Louvain assigns community IDs to each node
  const communities = louvain(graph) as Record<string, number>;

  // Map: sourceFile → clusterId (only for source files, not external deps)
  const fileClusters = new Map<string, number>();
  for (const [node, clusterId] of Object.entries(communities)) {
    if (node.startsWith(projectRoot)) {
      fileClusters.set(node, Number(clusterId));
    }
  }

  // Persist cluster assignments
  for (const [file, clusterId] of fileClusters) {
    setClusterForFile(projectId, file, clusterId);
  }

  // Build ClusterInfo list
  const byCluster = new Map<number, string[]>();
  for (const [file, clusterId] of fileClusters) {
    if (!byCluster.has(clusterId)) byCluster.set(clusterId, []);
    byCluster.get(clusterId)!.push(file);
  }

  return [...byCluster.entries()].map(([id, files]) => ({
    id,
    name: deriveClusterName(files, projectRoot),
    files,
    size: files.length,
  }));
}

// ─── Get cluster context for a file ──────────────────────────────────────────

export interface ModuleContext {
  file: string;
  cluster_id: number | null;
  cluster_name: string;
  related_files: string[];
}

export function getModuleContext(
  projectId: string,
  projectRoot: string,
  filePath: string,
): ModuleContext {
  const nodes = getAllNodesForProject(projectId).filter((n) => n.source_file === filePath);
  const clusterId = nodes[0]?.cluster_id ?? null;

  if (clusterId === null) {
    return { file: filePath, cluster_id: null, cluster_name: 'unassigned', related_files: [] };
  }

  const clusterNodes = getNodesInCluster(projectId, clusterId);
  const relatedFiles = [...new Set(
    clusterNodes.map((n) => n.source_file).filter((f) => f !== filePath)
  )];

  const allFiles = [filePath, ...relatedFiles];
  const clusterName = deriveClusterName(allFiles, projectRoot);

  return {
    file: filePath,
    cluster_id: clusterId,
    cluster_name: clusterName,
    related_files: relatedFiles,
  };
}

// ─── Find similar files (same cluster + FTS overlap) ─────────────────────────

export interface SimilarFile {
  file: string;
  cluster_match: boolean;
  shared_symbols: string[];
}

export function findSimilarFiles(
  projectId: string,
  filePath: string,
  limit = 10,
): SimilarFile[] {
  const fileNodes = getAllNodesForProject(projectId).filter((n) => n.source_file === filePath);
  const clusterId = fileNodes[0]?.cluster_id ?? null;
  const fileSymbols = new Set(fileNodes.map((n) => n.symbol));

  const allNodes = getAllNodesForProject(projectId).filter((n) => n.source_file !== filePath);

  // Group by source file
  const byFile = new Map<string, { clusterId: number | null; symbols: Set<string> }>();
  for (const node of allNodes) {
    if (!byFile.has(node.source_file)) {
      byFile.set(node.source_file, { clusterId: node.cluster_id ?? null, symbols: new Set() });
    }
    byFile.get(node.source_file)!.symbols.add(node.symbol);
  }

  const results: SimilarFile[] = [];
  for (const [file, info] of byFile) {
    const clusterMatch = clusterId !== null && info.clusterId === clusterId;
    const shared = [...info.symbols].filter((s) => fileSymbols.has(s));
    if (!clusterMatch && shared.length === 0) continue;
    results.push({ file, cluster_match: clusterMatch, shared_symbols: shared });
  }

  return results
    .sort((a, b) => {
      const scoreA = (a.cluster_match ? 10 : 0) + a.shared_symbols.length;
      const scoreB = (b.cluster_match ? 10 : 0) + b.shared_symbols.length;
      return scoreB - scoreA;
    })
    .slice(0, limit);
}
