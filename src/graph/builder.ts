import { createHash } from 'crypto';
import { readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { config } from '../config.js';
import { parseFile } from '../parsers/code-parser.js';
import {
  upsertProject,
  upsertFile,
  touchProject,
  clearSourceFile,
  insertNode,
  insertEdge,
  getFilesForProject,
  rebuildFts,
  type FileRow,
} from './store.js';
import { startWatcher } from './watcher.js';
import { detectAndStoreCommunities } from './communities.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function projectId(rootPath: string): string {
  return createHash('sha256').update(rootPath).digest('hex').slice(0, 16);
}

function fileId(projectId: string, filePath: string): string {
  return createHash('sha256').update(projectId + filePath).digest('hex').slice(0, 16);
}

function nodeId(projectId: string, symbol: string, filePath: string): string {
  return createHash('sha256').update(projectId + symbol + filePath).digest('hex').slice(0, 16);
}

function edgeId(projectId: string, from: string, to: string, type: string): string {
  return createHash('sha256').update(projectId + from + to + type).digest('hex').slice(0, 16);
}

function shouldIgnore(name: string): boolean {
  return config.ignore.some((pattern) => name === pattern || name.startsWith(pattern));
}

function collectFiles(dir: string, extensions: Set<string>): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    let entries: import('fs').Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: 'utf-8' });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.'));
        if (extensions.has(ext)) results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

// ─── Resolve import specifier to absolute path ────────────────────────────────

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

function tryResolve(base: string): string | null {
  try { statSync(base); return base; } catch { /* ignore */ }
  // If the specifier has a JS extension, swap it for TS equivalents (ESM imports)
  if (base.endsWith('.js')) {
    const stripped = base.slice(0, -3);
    for (const ext of ['.ts', '.tsx']) {
      try { statSync(stripped + ext); return stripped + ext; } catch { /* ignore */ }
    }
  }
  for (const ext of SOURCE_EXTENSIONS) {
    try { statSync(base + ext); return base + ext; } catch { /* ignore */ }
    try { statSync(join(base, 'index' + ext)); return join(base, 'index' + ext); } catch { /* ignore */ }
  }
  return null;
}

function resolveImport(fromFile: string, specifier: string, projectRoot: string): string | null {
  // Skip node_modules / external packages
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;

  const dir = fromFile.slice(0, fromFile.lastIndexOf('/'));
  const base = specifier.startsWith('/') ? specifier : resolve(dir, specifier);
  return tryResolve(base);
}

// ─── Index a project ─────────────────────────────────────────────────────────

export interface IndexResult {
  projectId: string;
  name: string;
  rootPath: string;
  filesIndexed: number;
  filesSkipped: number;
  nodesCreated: number;
  edgesCreated: number;
  clusters: number;
}

export function indexProject(rootPath: string): IndexResult {
  const absRoot = resolve(rootPath);
  const name = absRoot.split('/').pop() ?? absRoot;
  const pid = projectId(absRoot);

  upsertProject(pid, absRoot, name);

  // Collect supported extensions
  const extensions = new Set(config.grammars.flatMap((g) => g.extensions));
  const allFiles = collectFiles(absRoot, extensions);

  // Build lookup of existing DB state for incremental updates
  const existingFiles = new Map<string, FileRow>(
    getFilesForProject(pid).map((f) => [f.path, f]),
  );

  let filesIndexed = 0;
  let filesSkipped = 0;
  let nodesCreated = 0;
  let edgesCreated = 0;

  // Track all file paths seen on disk (for deletion detection)
  const seenPaths = new Set<string>();

  for (const filePath of allFiles) {
    seenPaths.add(filePath);
    const existing = existingFiles.get(filePath);

    // Check if file needs re-parsing
    let mtime: number;
    try {
      mtime = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }

    if (existing && existing.mtime === mtime) {
      filesSkipped++;
      continue;
    }

    const parsed = parseFile(filePath);
    if (!parsed) {
      filesSkipped++;
      continue;
    }

    // Invalidate old nodes/edges for this file
    clearSourceFile(pid, filePath);

    // Persist file fingerprint
    const fid = fileId(pid, filePath);
    upsertFile(fid, pid, filePath, parsed.mtime, parsed.hash);

    // Insert nodes (symbols)
    for (const sym of parsed.symbols) {
      const nid = nodeId(pid, sym.symbol, filePath);
      insertNode({
        id: nid,
        project_id: pid,
        source_file: filePath,
        symbol: sym.symbol,
        type: sym.type,
        path: relative(absRoot, filePath),
        line: sym.line,
        cluster_id: null,
      });
      nodesCreated++;
    }

    // Insert edges (imports → file-level edges)
    for (const imp of parsed.imports) {
      const resolvedTarget = resolveImport(filePath, imp.from, absRoot);
      const toNode = resolvedTarget ?? imp.from;
      const eid = edgeId(pid, filePath, toNode, 'imports');
      insertEdge({
        id: eid,
        project_id: pid,
        source_file: filePath,
        from_node: filePath,
        to_node: toNode,
        type: 'imports',
      });
      edgesCreated++;
    }

    filesIndexed++;
  }

  // Remove DB records for files deleted from disk
  for (const [path] of existingFiles) {
    if (!seenPaths.has(path)) {
      clearSourceFile(pid, path);
    }
  }

  touchProject(pid);
  const clusters = detectAndStoreCommunities(pid, absRoot);
  rebuildFts();
  startWatcher(pid, absRoot);

  return { projectId: pid, name, rootPath: absRoot, filesIndexed, filesSkipped, nodesCreated, edgesCreated, clusters: clusters.length };
}
