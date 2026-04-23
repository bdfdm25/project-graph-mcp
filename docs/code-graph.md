# Code Graph

Builds and queries a dependency graph of your codebase using Tree-sitter for parsing and SQLite + FTS5 for storage and search. Supports TypeScript, JavaScript, and Python out of the box; extensible to any Tree-sitter grammar.

---

## How it works

```
index_project(path)
      │
      ▼
   Builder (incremental)
   ├── Walk directory tree (respects ignore list)
   ├── Hash each file (mtime + content)
   ├── Skip files unchanged since last index
   └── For changed files:
         ├── Tree-sitter parser → symbols + import edges
         ├── Clear old nodes/edges for that file
         └── Insert new nodes/edges into SQLite
      │
      ▼
   Chokidar watcher (starts after index)
   └── On file save → re-parse that file only (debounced 300ms)
      │
      ▼
   SQLite (WAL, shared across sessions)
   ├── nodes: symbols per file
   ├── edges: import relationships
   └── nodes_fts: FTS5 index over symbol names
```

**Incremental indexing**: each file is hashed by `mtime + content`. Only files that changed since the last run are re-parsed. A project with 500 files re-indexes in milliseconds on subsequent sessions.

**Louvain clustering**: after indexing, the dependency graph is analyzed with the Louvain community detection algorithm (via `graphology-communities-louvain`). Files with dense mutual imports are grouped into clusters. Cluster names are derived from the common directory prefix of cluster members (e.g., `src/auth`).

---

## Tools

### `index_project`

Indexes a codebase into the dependency graph.

```
Inputs:  path (absolute path to project root)
Output:  { project_id, files_indexed, files_skipped, symbols, edges }
```

- Incremental: only re-parses files changed since last index
- Starts a live file watcher after indexing
- Automatically runs Louvain clustering on the resulting graph

**When to use**: once per project on first use. Subsequent sessions auto-index on startup (most recently used project only).

---

### `get_active_project`

Returns index status for the current working directory.

```
Inputs:  cwd (absolute path)
Output:  { cwd, vault, grammars, indexed, last_indexed_at, note }
```

**When to use**: at session start to confirm the project is indexed and ready.

---

### `list_projects`

Lists all indexed projects with their last-indexed timestamps.

```
Inputs:  (none)
Output:  [{ id, root_path, name, last_indexed_at }]
```

---

### `get_watcher_status`

Returns which project the live file watcher is currently watching.

```
Inputs:  (none)
Output:  { watching: bool, project_path?, project_id? }
```

---

### `get_dependencies`

Returns all files this file imports, direct and transitive.

```
Inputs:  project_path, file (both absolute paths)
Output:  {
  file,
  direct:     [{ file, symbols }],
  transitive: [{ file, depth }]
}
```

**Example use**: "What does `src/api/users.ts` depend on?" — useful before refactoring a file to understand its full dependency surface.

**Implementation**: BFS from the target node, following edges in the forward direction (this file → imported files).

---

### `get_blast_radius`

Returns all files that import this file, direct and transitive.

```
Inputs:  project_path, file (both absolute paths)
Output:  {
  file,
  direct:     [{ file }],
  transitive: [{ file, depth }],
  total:      number
}
```

**Example use**: "What breaks if I change `src/auth/session.ts`?" — run this before any non-trivial edit to know the scope of impact.

**Implementation**: BFS from the target node, following edges in the reverse direction (files that import this file).

---

### `get_module_context`

Returns the architectural cluster a file belongs to and all related files in that cluster.

```
Inputs:  project_path, file (both absolute paths)
Output:  {
  file,
  cluster_id,
  cluster_name,   // e.g. "src/auth"
  related_files:  [string]
}
```

**Example use**: "What other files are in the same architectural module as `src/auth/jwt.ts`?" — helps understand the boundary of a feature area.

**Implementation**: looks up the file's `cluster_id` in the `nodes` table (assigned during Louvain detection), then returns all files with the same `cluster_id`.

---

### `find_similar_code`

Finds files structurally and lexically similar to a given file.

```
Inputs:  project_path, file (both absolute paths), limit? (default 10)
Output:  [{
  file,
  cluster_match:   bool,   // same Louvain cluster
  shared_symbols:  string[] // overlapping exported/imported names
}]
```

**Ranked by**: `(cluster_match ? 10 : 0) + shared_symbols.length` — cluster membership weighted heavily.

**Example use**: "Show me files similar to `src/repositories/user.repository.ts`" — useful when adding a new repository and wanting to follow existing patterns.

---

## What gets parsed

| Language | Symbols extracted | Edge type |
|---|---|---|
| TypeScript / TSX | `import`, function/class/interface/variable declarations | `imports` |
| JavaScript / JSX | `import`, `require()`, function/class declarations | `imports` |
| Python | `import`, `from … import`, function/class definitions | `imports` |

### Adding a language

Install the Tree-sitter grammar and register it in config:

```bash
npm install tree-sitter-go
```

```json
// project-graph.config.json
{
  "grammars": [
    { "name": "go", "extensions": [".go"] }
  ]
}
```

No code changes required — the parser loads grammars dynamically.

---

## Configuration

```json
{
  "watchDebounce": 300,
  "grammars": [
    { "name": "typescript", "extensions": [".ts", ".tsx"] },
    { "name": "javascript", "extensions": [".js", ".jsx", ".mjs"] },
    { "name": "python",     "extensions": [".py"] }
  ],
  "ignore": [
    "node_modules", "dist", ".git", "coverage",
    "__pycache__", ".next", ".angular"
  ]
}
```

---

## Source files

| File | Responsibility |
|---|---|
| `src/graph/store.ts` | SQLite schema, FTS5, all DB queries for projects/files/nodes/edges |
| `src/graph/builder.ts` | Incremental indexer — orchestrates parser + store |
| `src/graph/algorithms.ts` | BFS for `get_dependencies` and `get_blast_radius` |
| `src/graph/communities.ts` | Louvain clustering, `get_module_context`, `find_similar_code` |
| `src/graph/watcher.ts` | Chokidar watcher, debounced per-file re-index |
| `src/parsers/code-parser.ts` | Tree-sitter parser, ESM-safe, handles TS dual-export |
