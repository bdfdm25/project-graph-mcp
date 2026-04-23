// obsidian-cli.ts
//
// Optional HTTP client for the Obsidian Local REST API plugin (port 27124).
// All functions degrade gracefully if Obsidian is not running.
// Use isObsidianCliAvailable() before calling other exports.

const BASE_URL = 'http://localhost:27124';
const TIMEOUT_MS = 500;

// ─── Availability check ───────────────────────────────────────────────────────

export async function isObsidianCliAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok || res.status === 401; // 401 = running but requires auth
  } catch {
    return false;
  }
}

// ─── Response types ───────────────────────────────────────────────────────────

export interface ObsidianActiveNote {
  path: string;
  content: string;
  stat: { mtime: number; ctime: number; size: number };
  frontmatter?: Record<string, unknown>;
  tags?: string[];
  links?: string[];
}

export interface ObsidianVaultFile {
  path: string;
}

// ─── Active note ──────────────────────────────────────────────────────────────

export async function getActiveNote(): Promise<ObsidianActiveNote | null> {
  try {
    const res = await fetch(`${BASE_URL}/active/`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return (await res.json()) as ObsidianActiveNote;
  } catch {
    return null;
  }
}

// ─── Open a note in Obsidian ──────────────────────────────────────────────────

export async function openNote(relativePath: string): Promise<boolean> {
  try {
    const encoded = encodeURIComponent(relativePath).replace(/%2F/g, '/');
    const res = await fetch(`${BASE_URL}/open/${encoded}`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Get note content by path ─────────────────────────────────────────────────

export async function getNoteContent(relativePath: string): Promise<string | null> {
  try {
    const encoded = encodeURIComponent(relativePath).replace(/%2F/g, '/');
    const res = await fetch(`${BASE_URL}/vault/${encoded}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: string };
    return data.content ?? null;
  } catch {
    return null;
  }
}

// ─── List vault files ─────────────────────────────────────────────────────────

export async function listVaultFiles(directory?: string): Promise<string[]> {
  try {
    const path = directory
      ? `${BASE_URL}/vault/${encodeURIComponent(directory).replace(/%2F/g, '/')}/`
      : `${BASE_URL}/vault/`;
    const res = await fetch(path, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { files?: string[] };
    return data.files ?? [];
  } catch {
    return [];
  }
}

// ─── Search via Obsidian (uses real wikilink graph + aliases) ─────────────────

export interface ObsidianSearchResult {
  filename: string;
  result: {
    content?: Array<[number, number]>;
    tags?: Array<[number, number]>;
    frontmatter?: Record<string, Array<[number, number]>>;
  };
  score: number;
}

export async function searchVaultCli(query: string): Promise<ObsidianSearchResult[]> {
  try {
    const res = await fetch(`${BASE_URL}/search/simple/?query=${encodeURIComponent(query)}&contextLength=100`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    return (await res.json()) as ObsidianSearchResult[];
  } catch {
    return [];
  }
}
