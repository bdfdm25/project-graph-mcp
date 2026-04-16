import chokidar, { type FSWatcher } from 'chokidar';
import { statSync } from 'fs';
import { extname } from 'path';
import { config } from '../config.js';
import { parseFile } from '../parsers/code-parser.js';
import {
  clearSourceFile,
  insertNode,
  insertEdge,
  upsertFile,
  getProjectByPath,
} from './store.js';
import { createHash } from 'crypto';
import { relative, resolve } from 'path';

// ─── State ────────────────────────────────────────────────────────────────────

let activeWatcher: FSWatcher | null = null;
let activeProjectId: string | null = null;
let activeRoot: string | null = null;

const supportedExtensions = new Set(config.grammars.flatMap((g) => g.extensions));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fileId(projectId: string, filePath: string): string {
  return createHash('sha256').update(projectId + filePath).digest('hex').slice(0, 16);
}

function nodeId(projectId: string, symbol: string, filePath: string): string {
  return createHash('sha256').update(projectId + symbol + filePath).digest('hex').slice(0, 16);
}

function edgeId(projectId: string, from: string, to: string, type: string): string {
  return createHash('sha256').update(projectId + from + to + type).digest('hex').slice(0, 16);
}

function resolveImportTarget(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return specifier;
  const dir = fromFile.slice(0, fromFile.lastIndexOf('/'));
  return resolve(dir, specifier);
}

// ─── Re-index a single file ───────────────────────────────────────────────────

function reindexFile(projectId: string, projectRoot: string, filePath: string): void {
  clearSourceFile(projectId, filePath);

  const parsed = parseFile(filePath);
  if (!parsed) return;

  const fid = fileId(projectId, filePath);
  upsertFile(fid, projectId, filePath, parsed.mtime, parsed.hash);

  for (const sym of parsed.symbols) {
    const nid = nodeId(projectId, sym.symbol, filePath);
    insertNode({
      id: nid,
      project_id: projectId,
      source_file: filePath,
      symbol: sym.symbol,
      type: sym.type,
      path: relative(projectRoot, filePath),
      line: sym.line,
      cluster_id: null,
    });
  }

  for (const imp of parsed.imports) {
    const toNode = resolveImportTarget(filePath, imp.from);
    const eid = edgeId(projectId, filePath, toNode, 'imports');
    insertEdge({
      id: eid,
      project_id: projectId,
      source_file: filePath,
      from_node: filePath,
      to_node: toNode,
      type: 'imports',
    });
  }
}

// ─── Debounce ─────────────────────────────────────────────────────────────────

const pending = new Map<string, ReturnType<typeof setTimeout>>();

function debounced(filePath: string, fn: () => void): void {
  const existing = pending.get(filePath);
  if (existing) clearTimeout(existing);
  pending.set(filePath, setTimeout(() => {
    pending.delete(filePath);
    fn();
  }, config.watchDebounce));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startWatcher(projectId: string, projectRoot: string): void {
  // Stop previous watcher if switching projects
  if (activeWatcher) {
    void activeWatcher.close();
    activeWatcher = null;
  }

  activeProjectId = projectId;
  activeRoot = projectRoot;

  const watcher = chokidar.watch(projectRoot, {
    ignored: (path: string) => {
      const name = path.split('/').pop() ?? '';
      return config.ignore.some((pattern) => name === pattern || path.includes(`/${pattern}/`));
    },
    ignoreInitial: true,   // don't re-fire for files already indexed
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on('add', (filePath: string) => {
    if (!supportedExtensions.has(extname(filePath))) return;
    debounced(filePath, () => reindexFile(projectId, projectRoot, filePath));
  });

  watcher.on('change', (filePath: string) => {
    if (!supportedExtensions.has(extname(filePath))) return;
    debounced(filePath, () => reindexFile(projectId, projectRoot, filePath));
  });

  watcher.on('unlink', (filePath: string) => {
    if (!supportedExtensions.has(extname(filePath))) return;
    debounced(filePath, () => clearSourceFile(projectId, filePath));
  });

  activeWatcher = watcher;
}

export function stopWatcher(): void {
  if (activeWatcher) {
    void activeWatcher.close();
    activeWatcher = null;
    activeProjectId = null;
    activeRoot = null;
  }
}

export function getActiveWatcherInfo(): { projectId: string; root: string } | null {
  if (!activeProjectId || !activeRoot) return null;
  return { projectId: activeProjectId, root: activeRoot };
}
