# project-graph-mcp

Personal MCP server for Claude Code. Combines code dependency graph analysis with Obsidian vault integration to reduce token consumption and provide persistent project knowledge across sessions.

## How it works

Each Claude Code session launches a separate server process over stdio. On startup the server automatically re-indexes the most recently used project (incremental — only changed files). A file watcher keeps the graph live as you edit.

```
Claude Code session
    │
    ▼
project-graph-mcp (stdio)
    ├── Tree-sitter parser     → extracts symbols, imports, exports
    ├── SQLite + FTS5          → dependency graph + full-text search
    ├── Louvain clustering     → groups files into architectural modules
    ├── Chokidar watcher       → live graph updates on file save
    └── Obsidian vault reader  → decisions, conventions, session handoffs
```

**The main payoff**: instead of reading 40+ files to understand blast radius, one tool call answers "what breaks if I change `auth/session.ts`?" from a pre-built graph.

## Requirements

- Node.js 20+
- Claude Code CLI (`claude` in PATH)
- Obsidian vault (default: `~/Development/obsidian-vault/`)

## Installation

```bash
git clone git@github.com:youruser/project-graph-mcp.git ~/Development/project-graph-mcp
cd ~/Development/project-graph-mcp
npm install
```

### Register with Claude Code

```bash
claude mcp add --scope user project-graph \
  "$(pwd)/node_modules/.bin/tsx" \
  -- "$(pwd)/src/mcp/server.ts"
```

> **Scope `user`** — registers once for all your Claude Code sessions, not per-project.

Verify the server is connected:

```bash
claude mcp get project-graph
# Status: ✓ Connected
```

### Database directory

The SQLite database is created automatically at `~/.project-graph/graph.db` on first use. No setup required.

## Configuration

The server loads configuration from the first file found among:

1. `./project-graph.config.json` (current working directory)
2. `<repo-root>/project-graph.config.json`
3. `~/.project-graph/config.json` (global user config)

If none is found, built-in defaults are used. All fields are optional — only override what you need.

```json
{
  "vault": "~/Development/obsidian-vault",
  "db": "~/.project-graph/graph.db",
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

### Adding a language

Install the tree-sitter grammar and add it to `grammars`:

```bash
npm install tree-sitter-go
```

```json
{ "name": "go", "extensions": [".go"] }
```

No code changes required.

## Usage

### First-time project indexing

When working on a new project, index it once:

```
index_project /absolute/path/to/your/project
```

After indexing, a file watcher starts automatically. Changes are picked up within 300ms (configurable via `watchDebounce`).

### Subsequent sessions

The server auto-indexes the most recently used project on startup. No manual action needed for your main project. For other projects, call `index_project` again — it is incremental and only re-parses changed files.

### Multi-session use

Each Claude Code session is a separate server process sharing the same SQLite database. The database uses WAL mode and a 5-second busy timeout, so concurrent reads/writes from multiple sessions are safe. Only one watcher runs per process — opening a second session on a different project will not affect the first session's watcher.

## Tools reference

### Project management

| Tool | Required args | Description |
|---|---|---|
| `get_active_project` | `cwd` | Returns index status for the current working directory |
| `list_projects` | — | Lists all indexed projects with last-indexed timestamps |
| `index_project` | `path` | Indexes or re-indexes a project (incremental by mtime) |
| `get_watcher_status` | — | Shows which project the live watcher is currently watching |

### Dependency graph

| Tool | Required args | Description |
|---|---|---|
| `get_dependencies` | `project_path`, `file` | All files this file imports, direct and transitive |
| `get_blast_radius` | `project_path`, `file` | All files that import this file (what breaks on change) |

### Module architecture

| Tool | Required args | Description |
|---|---|---|
| `get_module_context` | `project_path`, `file` | The architectural cluster this file belongs to and all related files in it |
| `find_similar_code` | `project_path`, `file` | Files similar by cluster membership and shared symbol names |

Clusters are detected automatically via Louvain community detection on the dependency graph. Cluster names are derived from the common directory prefix of cluster members.

### Search

| Tool | Required args | Optional args | Description |
|---|---|---|---|
| `search_knowledge` | `query` | `project_path`, `limit` | Unified search: FTS5 across code symbols + substring across vault notes |
| `search_vault` | `query` | `limit` | Full-text search across Obsidian vault notes only |

### Vault — read

| Tool | Required args | Description |
|---|---|---|
| `get_conventions` | — | Reads `Areas/claude-code-workflow.md` from the vault |
| `get_project_context` | — | Returns conventions + recent architecture decisions in one call |

### Vault — write

| Tool | Required args | Optional args | Description |
|---|---|---|---|
| `write_decision` | `title`, `body` | `tags`, `status`, `context` | Saves an ADR to `Resources/decisions/YYYY-MM-DD-<slug>.md` |
| `write_session_handoff` | `summary` | `project`, `tags` | Saves a session summary to `Archive/sessions/` |
| `summarize_project_doc` | `path` | — | Reads a repo document so Claude can compress it, then call `write_project_summary` |
| `write_project_summary` | `project_name`, `summary`, `source_doc` | `tags` | Saves a compressed doc summary to `Resources/projects/<name>/summary.md` |

### Vault structure expected

```
~/Development/obsidian-vault/
├── Areas/
│   └── claude-code-workflow.md    ← read by get_conventions
├── Resources/
│   ├── decisions/                 ← write_decision output
│   └── projects/                  ← write_project_summary output
└── Archive/
    └── sessions/                  ← write_session_handoff output
```

Directories are created automatically on first write. The vault path is configurable.

## What gets indexed

For each file, the parser extracts:

- **TypeScript / JavaScript**: `import` statements, function declarations, class declarations, interface declarations, variable declarations
- **Python**: `import` / `from … import` statements, function definitions, class definitions

Edges in the graph represent import relationships. The `ignore` list in config controls which directories are skipped.

## Development

```bash
npm run dev        # tsx watch — restarts on file change
npm run typecheck  # type check without emitting
npm run build      # compile to dist/
```

### Project structure

```
src/
├── config.ts              # Config loader (3 candidate paths + defaults)
├── graph/
│   ├── store.ts           # SQLite schema, FTS5, all DB queries
│   ├── builder.ts         # Incremental indexer, orchestrates parser + store
│   ├── algorithms.ts      # BFS for get_dependencies + get_blast_radius
│   ├── communities.ts     # Louvain clustering, get_module_context, find_similar_code
│   └── watcher.ts         # Chokidar file watcher, debounced re-index per file
├── parsers/
│   └── code-parser.ts     # Tree-sitter parser (ESM-safe, handles TS dual export)
└── mcp/
    ├── server.ts           # MCP server, boot sync, stdio transport
    └── tools.ts            # Tool definitions + handlers (16 tools)
```

### Known constraints

- **Grammar versions**: `tree-sitter-typescript@0.23.2` requires `tree-sitter@^0.21`. JS and Python grammars are pinned to `@0.21.x` for compatibility.
- **FTS5 rebuild**: the `nodes_fts` table is an external content table. After a full index run, `rebuildFts()` is called explicitly — triggers alone do not populate external content tables.
- **Boot sync**: only the most recently used project is synced on startup. Syncing all projects on every session start causes SQLite write contention in multi-session use.
