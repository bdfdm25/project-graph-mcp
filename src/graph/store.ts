import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(config.db), { recursive: true });
  _db = new Database(config.db);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000'); // wait up to 5s on write contention (multi-session)
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      root_path   TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      last_indexed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS files (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path        TEXT NOT NULL,
      mtime       INTEGER NOT NULL,
      hash        TEXT NOT NULL,
      UNIQUE(project_id, path)
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_file TEXT NOT NULL,
      symbol      TEXT NOT NULL,
      type        TEXT NOT NULL,
      path        TEXT NOT NULL,
      line        INTEGER,
      cluster_id  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_source_file ON nodes(source_file);
    CREATE INDEX IF NOT EXISTS idx_nodes_symbol ON nodes(symbol);

    CREATE TABLE IF NOT EXISTS edges (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_file TEXT NOT NULL,
      from_node   TEXT NOT NULL,
      to_node     TEXT NOT NULL,
      type        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_edges_source_file ON edges(source_file);
    CREATE INDEX IF NOT EXISTS idx_edges_from_node ON edges(from_node);
    CREATE INDEX IF NOT EXISTS idx_edges_to_node ON edges(to_node);

    CREATE TABLE IF NOT EXISTS vault_notes (
      id          TEXT PRIMARY KEY,
      path        TEXT NOT NULL UNIQUE,
      title       TEXT NOT NULL,
      tags        TEXT,
      links       TEXT,
      content     TEXT NOT NULL,
      mtime       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      project_tag TEXT,
      project_path TEXT,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      summary     TEXT
    );

    CREATE TABLE IF NOT EXISTS observations (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      project_tag TEXT,
      type        TEXT NOT NULL,
      content     TEXT NOT NULL,
      context     TEXT,
      tags        TEXT,
      promoted    INTEGER DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project_tag);
    CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);

    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      content,
      context,
      content='observations',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, content, context)
        VALUES (new.rowid, new.content, new.context);
    END;

    CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, content, context)
        VALUES ('delete', old.rowid, old.content, old.context);
    END;

    CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, content, context)
        VALUES ('delete', old.rowid, old.content, old.context);
      INSERT INTO observations_fts(rowid, content, context)
        VALUES (new.rowid, new.content, new.context);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      id UNINDEXED,
      project_id UNINDEXED,
      source_file UNINDEXED,
      symbol,
      type UNINDEXED,
      path,
      content=nodes,
      content_rowid=rowid
    );

    CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, id, project_id, source_file, symbol, type, path)
        VALUES (new.rowid, new.id, new.project_id, new.source_file, new.symbol, new.type, new.path);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, project_id, source_file, symbol, type, path)
        VALUES ('delete', old.rowid, old.id, old.project_id, old.source_file, old.symbol, old.type, old.path);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, project_id, source_file, symbol, type, path)
        VALUES ('delete', old.rowid, old.id, old.project_id, old.source_file, old.symbol, old.type, old.path);
      INSERT INTO nodes_fts(rowid, id, project_id, source_file, symbol, type, path)
        VALUES (new.rowid, new.id, new.project_id, new.source_file, new.symbol, new.type, new.path);
    END;
  `);
}

// ─── Projects ────────────────────────────────────────────────────────────────

export interface ProjectRow {
  id: string;
  root_path: string;
  name: string;
  last_indexed_at: number | null;
}

export function upsertProject(id: string, rootPath: string, name: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO projects (id, root_path, name, last_indexed_at)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path, name = excluded.name
  `).run(id, rootPath, name);
}

export function touchProject(id: string): void {
  getDb().prepare('UPDATE projects SET last_indexed_at = ? WHERE id = ?').run(Date.now(), id);
}

export function listProjects(): ProjectRow[] {
  return getDb().prepare('SELECT * FROM projects ORDER BY last_indexed_at DESC').all() as ProjectRow[];
}

export function getProject(id: string): ProjectRow | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
}

export function getProjectByPath(rootPath: string): ProjectRow | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as ProjectRow | undefined;
}

// ─── Files ───────────────────────────────────────────────────────────────────

export interface FileRow {
  id: string;
  project_id: string;
  path: string;
  mtime: number;
  hash: string;
}

export function upsertFile(id: string, projectId: string, path: string, mtime: number, hash: string): void {
  getDb().prepare(`
    INSERT INTO files (id, project_id, path, mtime, hash)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, path) DO UPDATE SET mtime = excluded.mtime, hash = excluded.hash, id = excluded.id
  `).run(id, projectId, path, mtime, hash);
}

export function getFilesForProject(projectId: string): FileRow[] {
  return getDb().prepare('SELECT * FROM files WHERE project_id = ?').all(projectId) as FileRow[];
}

// ─── Nodes / Edges (cascade invalidation) ────────────────────────────────────

export interface NodeRow {
  id: string;
  project_id: string;
  source_file: string;
  symbol: string;
  type: string;
  path: string;
  line: number | null;
  cluster_id: number | null;
}

export interface EdgeRow {
  id: string;
  project_id: string;
  source_file: string;
  from_node: string;
  to_node: string;
  type: string;
}

export function clearSourceFile(projectId: string, sourceFile: string): void {
  const db = getDb();
  db.prepare('DELETE FROM nodes WHERE project_id = ? AND source_file = ?').run(projectId, sourceFile);
  db.prepare('DELETE FROM edges WHERE project_id = ? AND source_file = ?').run(projectId, sourceFile);
}

export function insertNode(row: NodeRow): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO nodes (id, project_id, source_file, symbol, type, path, line)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.project_id, row.source_file, row.symbol, row.type, row.path, row.line ?? null);
}

export function insertEdge(row: EdgeRow): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO edges (id, project_id, source_file, from_node, to_node, type)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.id, row.project_id, row.source_file, row.from_node, row.to_node, row.type);
}

export function getEdgesForProject(projectId: string): EdgeRow[] {
  return getDb().prepare('SELECT * FROM edges WHERE project_id = ?').all(projectId) as EdgeRow[];
}

export function getNodesForFile(projectId: string, sourceFile: string): NodeRow[] {
  return getDb().prepare('SELECT * FROM nodes WHERE project_id = ? AND source_file = ?').all(projectId, sourceFile) as NodeRow[];
}

export function getAllNodesForProject(projectId: string): NodeRow[] {
  return getDb().prepare('SELECT * FROM nodes WHERE project_id = ?').all(projectId) as NodeRow[];
}

export function rebuildFts(): void {
  getDb().exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
}

export function setClusterForFile(projectId: string, sourceFile: string, clusterId: number): void {
  getDb().prepare(
    'UPDATE nodes SET cluster_id = ? WHERE project_id = ? AND source_file = ?'
  ).run(clusterId, projectId, sourceFile);
}

export function getNodesInCluster(projectId: string, clusterId: number): NodeRow[] {
  return getDb().prepare(
    'SELECT * FROM nodes WHERE project_id = ? AND cluster_id = ?'
  ).all(projectId, clusterId) as NodeRow[];
}

// ─── FTS search ───────────────────────────────────────────────────────────────

export interface FtsNodeResult {
  id: string;
  project_id: string;
  source_file: string;
  symbol: string;
  type: string;
  path: string;
  rank: number;
}

export function searchNodes(query: string, projectId?: string, limit = 20): FtsNodeResult[] {
  const db = getDb();
  // Sanitize and build FTS5 prefix query: each word gets a trailing * for prefix match
  const ftsQuery = query
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9_]/g, '') + '*')
    .filter(Boolean)
    .join(' ');
  if (projectId) {
    return db.prepare(`
      SELECT n.id, n.project_id, n.source_file, n.symbol, n.type, n.path,
             nodes_fts.rank AS rank
      FROM nodes_fts
      JOIN nodes n ON n.rowid = nodes_fts.rowid
      WHERE nodes_fts MATCH ? AND n.project_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, projectId, limit) as FtsNodeResult[];
  }
  return db.prepare(`
    SELECT n.id, n.project_id, n.source_file, n.symbol, n.type, n.path,
           nodes_fts.rank AS rank
    FROM nodes_fts
    JOIN nodes n ON n.rowid = nodes_fts.rowid
    WHERE nodes_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, limit) as FtsNodeResult[];
}

// ─── Recent decisions (vault notes in Resources/decisions/) ──────────────────

export function getRecentProjects(limit = 5): ProjectRow[] {
  return getDb().prepare(
    'SELECT * FROM projects WHERE last_indexed_at IS NOT NULL ORDER BY last_indexed_at DESC LIMIT ?'
  ).all(limit) as ProjectRow[];
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  project_tag: string | null;
  project_path: string | null;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
}

export function upsertSession(id: string, projectTag: string | null, projectPath: string | null): void {
  getDb().prepare(`
    INSERT INTO sessions (id, project_tag, project_path, started_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_tag  = excluded.project_tag,
      project_path = excluded.project_path
  `).run(id, projectTag, projectPath, Date.now());
}

export function closeSession(id: string, summary?: string): void {
  getDb().prepare(`
    UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?
  `).run(Date.now(), summary ?? null, id);
}

// ─── Observations ────────────────────────────────────────────────────────────

export interface ObservationRow {
  id: string;
  session_id: string;
  project_tag: string | null;
  type: string;
  content: string;
  context: string | null;
  tags: string | null;
  promoted: number;
  created_at: number;
}

export type ObservationType = 'decision' | 'discovery' | 'error' | 'code-change' | 'note' | 'pattern';

export function insertObservation(row: {
  id: string;
  session_id: string;
  project_tag: string | null;
  type: ObservationType;
  content: string;
  context?: Record<string, unknown>;
  tags?: string[];
}): void {
  getDb().prepare(`
    INSERT INTO observations (id, session_id, project_tag, type, content, context, tags, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.session_id,
    row.project_tag,
    row.type,
    row.content,
    row.context ? JSON.stringify(row.context) : null,
    row.tags ? JSON.stringify(row.tags) : null,
    Date.now()
  );
}

export interface FtsObservationResult {
  id: string;
  session_id: string;
  project_tag: string | null;
  type: string;
  content: string;
  context: string | null;
  tags: string | null;
  promoted: number;
  created_at: number;
  rank: number;
}

export function searchObservations(query: string, projectTag?: string, limit = 20): FtsObservationResult[] {
  const db = getDb();
  const ftsQuery = query
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9_]/g, ''))
    .filter(Boolean)
    .map((w) => w + '*')
    .join(' OR ');
  if (projectTag) {
    return db.prepare(`
      SELECT o.*, observations_fts.rank AS rank
      FROM observations_fts
      JOIN observations o ON o.rowid = observations_fts.rowid
      WHERE observations_fts MATCH ? AND o.project_tag = ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, projectTag, limit) as FtsObservationResult[];
  }
  return db.prepare(`
    SELECT o.*, observations_fts.rank AS rank
    FROM observations_fts
    JOIN observations o ON o.rowid = observations_fts.rowid
    WHERE observations_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, limit) as FtsObservationResult[];
}

export function getSessionTimeline(sessionId: string): ObservationRow[] {
  return getDb().prepare(`
    SELECT * FROM observations WHERE session_id = ? ORDER BY created_at ASC
  `).all(sessionId) as ObservationRow[];
}

export function getObservation(id: string): ObservationRow | undefined {
  return getDb().prepare('SELECT * FROM observations WHERE id = ?').get(id) as ObservationRow | undefined;
}

export function listSessions(projectTag?: string, limit = 20): SessionRow[] {
  if (projectTag) {
    return getDb().prepare(`
      SELECT * FROM sessions WHERE project_tag = ? ORDER BY started_at DESC LIMIT ?
    `).all(projectTag, limit) as SessionRow[];
  }
  return getDb().prepare(`
    SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?
  `).all(limit) as SessionRow[];
}

export function promoteObservation(id: string): void {
  getDb().prepare('UPDATE observations SET promoted = 1 WHERE id = ?').run(id);
}
