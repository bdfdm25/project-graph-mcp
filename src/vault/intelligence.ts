// intelligence.ts
//
// Higher-order vault analysis: idea tracing, emerging cluster detection,
// and vault indexing. Uses file-based parsing by default; augments with
// Obsidian CLI when available.

import { join, basename } from 'path';
import { readdirSync } from 'fs';
import { config } from '../config.js';
import { parseVaultNote, type VaultNote } from '../parsers/vault-parser.js';
import { isObsidianCliAvailable, searchVaultCli } from './obsidian-cli.js';
import { UndirectedGraph } from 'graphology';
import louvainModule from 'graphology-communities-louvain';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const louvain = (louvainModule as any).default ?? louvainModule;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function collectAllNotes(): VaultNote[] {
  const results: VaultNote[] = [];

  function walk(dir: string): void {
    let entries: import('fs').Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.endsWith('.claude.md')) {
        const note = parseVaultNote(full);
        if (note) results.push(note);
      }
    }
  }

  walk(config.vault);
  return results;
}

function noteTitle(note: VaultNote): string {
  return basename(note.path, '.md');
}

// ─── Vault index ──────────────────────────────────────────────────────────────

export interface VaultIndexEntry {
  area: string;
  title: string;
  relPath: string;
  tags: string[];
  links: string[];
  mtime: number;
}

export interface VaultIndex {
  total: number;
  by_area: Record<string, VaultIndexEntry[]>;
  generated_at: number;
}

export function getVaultIndex(): VaultIndex {
  const notes = collectAllNotes();
  const by_area: Record<string, VaultIndexEntry[]> = {};

  for (const note of notes) {
    const relPath = note.path.replace(config.vault + '/', '');
    const parts = relPath.split('/');
    const area = parts.length > 1 ? parts[0] : 'Root';

    if (!by_area[area]) by_area[area] = [];
    by_area[area].push({
      area,
      title: note.title,
      relPath,
      tags: note.tags,
      links: note.links,
      mtime: note.mtime,
    });
  }

  // Sort each area by mtime desc (most recently modified first)
  for (const area of Object.keys(by_area)) {
    by_area[area].sort((a, b) => b.mtime - a.mtime);
  }

  return {
    total: notes.length,
    by_area,
    generated_at: Date.now(),
  };
}

// ─── Idea tracer ──────────────────────────────────────────────────────────────

export interface IdeaTraceEntry {
  relPath: string;
  title: string;
  mtime: number;
  snippet: string;
  links_to: string[];
  linked_from: string[];
}

export interface IdeaTrace {
  topic: string;
  notes_found: number;
  timeline: IdeaTraceEntry[];  // sorted by mtime asc (evolution over time)
  via_obsidian_cli: boolean;
}

export async function traceIdea(topic: string, limit = 30): Promise<IdeaTrace> {
  const q = topic.toLowerCase();
  const allNotes = collectAllNotes();
  const viaObsidian = await isObsidianCliAvailable();

  // Build reverse link index: target title → notes that link to it
  const backlinks: Record<string, string[]> = {};
  for (const note of allNotes) {
    for (const link of note.links) {
      if (!backlinks[link]) backlinks[link] = [];
      backlinks[link].push(noteTitle(note));
    }
  }

  let matchingPaths = new Set<string>();

  if (viaObsidian) {
    // Use Obsidian CLI for real wikilink-aware search (aliases, transclusions)
    const cliResults = await searchVaultCli(topic);
    for (const r of cliResults.slice(0, limit)) {
      matchingPaths.add(r.filename);
    }
  }

  // Always augment with content/link match (works offline too)
  for (const note of allNotes) {
    const relPath = note.path.replace(config.vault + '/', '');
    if (matchingPaths.has(relPath)) continue;

    const haystack = note.raw.toLowerCase();
    const titleSlug = noteTitle(note).toLowerCase();

    if (
      haystack.includes(q) ||
      titleSlug.includes(q) ||
      note.links.some((l) => l.toLowerCase().includes(q))
    ) {
      matchingPaths.add(relPath);
    }
  }

  // Also follow wikilinks from matched notes (one hop)
  const toExpand = new Set(matchingPaths);
  const noteByRelPath = new Map(allNotes.map((n) => [n.path.replace(config.vault + '/', ''), n]));
  const noteByTitle = new Map(allNotes.map((n) => [noteTitle(n).toLowerCase(), n]));

  for (const relPath of toExpand) {
    const note = noteByRelPath.get(relPath);
    if (!note) continue;
    for (const link of note.links) {
      const linked = noteByTitle.get(link.toLowerCase());
      if (linked) {
        matchingPaths.add(linked.path.replace(config.vault + '/', ''));
      }
    }
  }

  // Build timeline entries
  const entries: IdeaTraceEntry[] = [];
  for (const relPath of matchingPaths) {
    const note = noteByRelPath.get(relPath);
    if (!note) continue;

    const titleKey = noteTitle(note);
    const snippet = buildSnippet(note.raw, topic);

    entries.push({
      relPath,
      title: note.title,
      mtime: note.mtime,
      snippet,
      links_to: note.links,
      linked_from: backlinks[titleKey] ?? [],
    });
  }

  // Sort by mtime ascending (idea evolution timeline)
  entries.sort((a, b) => a.mtime - b.mtime);

  return {
    topic,
    notes_found: entries.length,
    timeline: entries.slice(0, limit),
    via_obsidian_cli: viaObsidian,
  };
}

function buildSnippet(text: string, query: string, contextChars = 100): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, contextChars).replace(/\n/g, ' ');
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + query.length + 50);
  const snippet = text.slice(start, end).replace(/\n/g, ' ');
  return (start > 0 ? '…' : '') + snippet + (end < text.length ? '…' : '');
}

// ─── Emerging cluster detector (Louvain on wikilink graph) ───────────────────

export interface EmergingCluster {
  theme: string;         // representative keyword/phrase
  notes: string[];       // relative paths of notes in this cluster
  note_titles: string[];
  strength: number;      // internal link count between cluster members
  tags: string[];        // union of tags across cluster members
  first_seen: number;    // oldest mtime in cluster
  last_seen: number;     // newest mtime in cluster
}

export interface EmergingClusters {
  clusters: EmergingCluster[];
  total_notes_analyzed: number;
  generated_at: number;
  algorithm: 'louvain' | 'connected-components';
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'to', 'for', 'with', 'on', 'is', 'it', 'as', 'at', 'by', 'de', 'do', 'da', 'em', 'que', 'um', 'uma']);

function deriveTheme(titles: string[]): string {
  const wordCounts: Record<string, number> = {};
  for (const title of titles) {
    for (const word of title.toLowerCase().split(/[\s\-_]+/)) {
      if (word.length > 2 && !STOPWORDS.has(word)) {
        wordCounts[word] = (wordCounts[word] ?? 0) + 1;
      }
    }
  }
  return Object.entries(wordCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? titles[0] ?? 'unknown';
}

function buildClusterObject(
  memberKeys: string[],
  noteByKey: Map<string, VaultNote>,
): EmergingCluster {
  const memberSet = new Set(memberKeys);
  const notes: string[] = [];
  const noteTitles: string[] = [];
  const allTags = new Set<string>();
  let first_seen = Infinity;
  let last_seen = 0;
  let strength = 0;

  for (const key of memberKeys) {
    const note = noteByKey.get(key);
    if (!note) continue;
    notes.push(note.path.replace(config.vault + '/', ''));
    noteTitles.push(note.title);
    note.tags.forEach((t) => allTags.add(t));
    if (note.mtime < first_seen) first_seen = note.mtime;
    if (note.mtime > last_seen) last_seen = note.mtime;
    for (const link of note.links) {
      if (memberSet.has(link.toLowerCase())) strength++;
    }
  }

  return {
    theme: deriveTheme(noteTitles),
    notes,
    note_titles: noteTitles,
    strength,
    tags: [...allTags],
    first_seen: first_seen === Infinity ? 0 : first_seen,
    last_seen,
  };
}

export function detectEmergingClusters(minClusterSize = 2, limit = 10): EmergingClusters {
  const allNotes = collectAllNotes();
  const noteByKey = new Map(allNotes.map((n) => [noteTitle(n).toLowerCase(), n]));

  // Build undirected graphology graph from wikilinks
  const graph = new UndirectedGraph();
  for (const note of allNotes) {
    const src = noteTitle(note).toLowerCase();
    if (!graph.hasNode(src)) graph.addNode(src);
    for (const link of note.links) {
      const tgt = link.toLowerCase();
      if (noteByKey.has(tgt)) {
        if (!graph.hasNode(tgt)) graph.addNode(tgt);
        if (!graph.hasEdge(src, tgt)) graph.addUndirectedEdge(src, tgt);
      }
    }
  }

  let clusterMap: Record<string, number>;
  let algorithm: 'louvain' | 'connected-components' = 'louvain';

  try {
    // Louvain requires at least one edge
    if (graph.size === 0) throw new Error('no edges');
    clusterMap = louvain(graph) as Record<string, number>;
  } catch {
    // Fallback: BFS connected components
    algorithm = 'connected-components';
    clusterMap = {};
    let clusterId = 0;
    const visited = new Set<string>();
    for (const node of graph.nodes()) {
      if (visited.has(node)) continue;
      const queue = [node];
      visited.add(node);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        clusterMap[cur] = clusterId;
        for (const neighbor of graph.neighbors(cur)) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      clusterId++;
    }
  }

  // Group nodes by cluster ID
  const byCluster = new Map<number, string[]>();
  for (const [node, cid] of Object.entries(clusterMap)) {
    if (!byCluster.has(cid)) byCluster.set(cid, []);
    byCluster.get(cid)!.push(node);
  }

  const clusters: EmergingCluster[] = [];
  for (const members of byCluster.values()) {
    if (members.length < minClusterSize) continue;
    clusters.push(buildClusterObject(members, noteByKey));
  }

  clusters.sort((a, b) => b.strength - a.strength || b.notes.length - a.notes.length);

  return {
    clusters: clusters.slice(0, limit),
    total_notes_analyzed: allNotes.length,
    generated_at: Date.now(),
    algorithm,
  };
}
