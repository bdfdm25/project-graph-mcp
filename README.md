# project-graph-mcp

Personal MCP server for Claude Code. Combines three systems: a code dependency graph, an Obsidian vault integration, and a persistent episodic memory store — all sharing a single SQLite database, exposed over stdio.

## How it works

```
Claude Code session (any directory)
         │
         ├── UserPromptSubmit hooks
         │   ├── open-session.sh       → registers session in DB
         │   ├── memory-inject.sh      → injects vault index + recent observations
         │   └── session-context.sh    → injects last handoff note
         │
         ├── PostToolUse hook
         │   └── capture-observation.sh → structural observation → SQLite
         │
         └── Stop hook
             └── close-session.sh      → marks session ended
                      │
                      ▼
         project-graph-mcp (--scope user, stdio)
                      │
         ┌────────────┼──────────────────┬──────────────┐
         ▼            ▼                  ▼              ▼
    Code graph    Vault I/O      Episodic memory     Search
    (8 tools)    (6 tools)         (6 tools)        (2 tools)
                      │
              Vault intelligence
                 (4 tools)
                      │
                      ▼
         ~/.project-graph/graph.db (SQLite, WAL mode)
```

**Three-layer memory model:**

```
WORKING MEMORY     — session-context.sh (last handoff) + memory-inject.sh (vault index)
EPISODIC MEMORY    — observations + sessions in SQLite, captured by hooks + write_observation
SEMANTIC MEMORY    — Obsidian vault: decisions, conventions, wikilinks, graduated notes
```

## Requirements

- Node.js 20+
- Claude Code CLI (`claude` in PATH)
- `sqlite3` CLI — required by shell hooks
- `jq` — required by shell hooks
- Obsidian vault — path configured via `vault` field in `project-graph.config.json`
- **Optional**: [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin — enables enriched backlink results in `trace_idea` and `get_vault_index` via port 27124; both tools degrade gracefully when Obsidian is not running

## Installation

```bash
git clone git@github.com:bdfdm25/project-graph-mcp.git ~/Development/project-graph-mcp
cd ~/Development/project-graph-mcp
npm install
```

### Register with Claude Code

For portability across machines, create a launcher script first:

```bash
mkdir -p ~/.claude/mcp-servers
cat > ~/.claude/mcp-servers/project-graph.sh << 'EOF'
#!/usr/bin/env bash
REPO="$HOME/Development/project-graph-mcp"
exec "$REPO/node_modules/.bin/tsx" "$REPO/src/mcp/server.ts"
EOF
chmod +x ~/.claude/mcp-servers/project-graph.sh
```

Then register the launcher (no hardcoded paths):

```bash
claude mcp add project-graph -s user -- "$HOME/.claude/mcp-servers/project-graph.sh"
```

Verify:

```bash
claude mcp get project-graph
# Status: ✓ Connected
```

> **Scope `user`** — registers once for all your Claude Code sessions, not per-project.

### Shell hooks (optional but recommended)

The hooks power episodic memory and session context injection. Add them to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "~/.claude/hooks/open-session.sh" },
      { "type": "command", "command": "~/.claude/hooks/memory-inject.sh" },
      { "type": "command", "command": "~/.claude/hooks/session-context.sh" }
    ],
    "PostToolUse": [
      { "type": "command", "command": "~/.claude/hooks/capture-observation.sh" }
    ],
    "Stop": [
      { "type": "command", "command": "~/.claude/hooks/close-session.sh" }
    ]
  }
}
```

Hook scripts live in `~/.claude/hooks/`. See [docs/episodic-memory.md](docs/episodic-memory.md) for what each hook does.

### Database

Created automatically at `~/.project-graph/graph.db` on first use. No setup required.

## Configuration

Config is loaded from the first file found among:

1. `./project-graph.config.json` (current working directory)
2. `<repo-root>/project-graph.config.json`
3. `~/.project-graph/config.json` (global fallback)

All fields are optional — only override what you need:

```json
{
  "vault": "~/path/to/your/obsidian-vault",
  "db": "~/.project-graph/graph.db",
  "watchDebounce": 300,
  "trustedRoots": ["~/Development"],
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

```bash
npm install tree-sitter-go
```

```json
{ "name": "go", "extensions": [".go"] }
```

No code changes required — grammars are loaded dynamically.

## Response contract

Every tool returns the same envelope, so a caller branches on `ok` without knowing the tool:

```json
{ "ok": true,  "tool": "search_vault", "data": { }, "meta": { "count": 3 } }
{ "ok": false, "tool": "index_project", "error": { "code": "NOT_INDEXED", "message": "…", "field": "project_path", "hint": "…", "retryable": true } }
```

Payloads are compact JSON (no indentation), list rows carry provenance as `"prov":"agent/high"`,
and the trust boundary is declared once per result set instead of fencing every row.

Failures also set `isError: true`. Codes: `INVALID_INPUT`, `PATH_NOT_ALLOWED`, `NOT_FOUND`, `NOT_INDEXED`, `TOO_LARGE`, `NO_MATCH`, `UNKNOWN_TOOL`, `INTERNAL`.

Arguments are validated with zod before any handler runs, and unknown argument names are rejected rather than ignored.

## Trust model in one paragraph

Text read from disk or the memory store is marked untrusted — fenced in `<external-content … trust="untrusted">` when it is the whole payload, declared once in `meta.untrusted` when it is a list — with credentials redacted and injection-heuristic signals attached as `flags`. It is data to summarize, never instructions to follow. Reads are confined to `trustedRoots` plus the vault, with symlinks resolved before the containment check and a deny list for keys, `.env` files and credential stores. Every item also carries `provenance: { source, source_type, origin, trust, confidence, reason }`, where `origin` distinguishes what a human said, what a model concluded, what a hook captured mechanically, and what the server derived from parsed code.

Full details: [docs/security-and-provenance.md](docs/security-and-provenance.md), or the `project-graph://docs/provenance` resource at runtime.

## Tools reference (26 tools)

Every read tool attaches provenance — `"prov":"origin/confidence"` on list rows, a full block on single-item payloads. Default result counts are small (8 for the searches, 6 for `search_knowledge`, 15 for `trace_idea`); the cap is 100.

### Code graph

| Tool | Args | Description |
|---|---|---|
| `get_active_project` | `cwd` | Index status for the current working directory |
| `list_projects` | — | All indexed projects with last-indexed timestamps |
| `index_project` | `path` | Index or re-index a project (incremental by mtime) |
| `get_watcher_status` | — | Which project the live watcher is currently watching |
| `get_dependencies` | `project_path`, `file` | All files this file imports, direct and transitive |
| `get_blast_radius` | `project_path`, `file` | All files that import this file (scope of impact) |
| `get_module_context` | `project_path`, `file` | The Louvain cluster this file belongs to + related files |
| `find_similar_code` | `project_path`, `file` | Files with similar cluster membership and shared symbols |

### Search

| Tool | Args | Description |
|---|---|---|
| `search_knowledge` | `query`, `project_path?`, `limit?` | Unified FTS5 search: code symbols + vault notes |
| `search_vault` | `query`, `limit?` | Substring search across all vault notes |

### Vault — read

| Tool | Args | Description |
|---|---|---|
| `get_conventions` | — | Reads `Areas/claude-code-workflow.md` from vault |
| `get_project_context` | `decisions_limit?` | Conventions + recent ADRs in one call |

### Vault — write

| Tool | Args | Description |
|---|---|---|
| `write_decision` | `title`, `body`, `tags?`, `status?`, `context?` | Saves an ADR to `Resources/decisions/YYYY-MM-DD-<slug>.md` |
| `write_session_handoff` | `summary`, `project?`, `tags?` | Saves session summary to `Archive/sessions/` |
| `summarize_project_doc` | `path` | Reads a repo doc for Claude to compress, then call `write_project_summary` |
| `write_project_summary` | `project_name`, `summary`, `source_doc`, `tags?` | Saves compressed summary to `Resources/projects/<name>/summary.md` |

### Episodic memory

| Tool | Args | Description |
|---|---|---|
| `write_observation` | `session_id`, `type`, `content`, `project_tag?`, `context?`, `tags?`, `origin?` | Records an observation (decision/discovery/error/code-change/note/pattern). `context` is an optional object `{ file?, line?, tool?, symbol?, url? }` |
| `search_observations` | `query`, `project_tag?`, `limit?` | FTS5 search across all recorded observations |
| `get_session_timeline` | `session_id`, `limit?`, `order?` | Observations from a session in order (first 50 by default; `order:"desc"` reads the tail) |
| `get_observation` | `id` | Fetch a single observation by ID |
| `list_sessions` | `project_tag?`, `limit?` | List recorded sessions |
| `close_session` | `session_id`, `summary?` | Mark a session as ended |

### Vault intelligence

| Tool | Args | Description |
|---|---|---|
| `get_vault_index` | `area?`, `detail?` | Per-area note counts; with `area`, the notes in it (`detail:"full"` adds tags/links/mtime) |
| `trace_idea` | `topic`, `limit?` | Trace how an idea evolved across notes (chronological timeline + backlinks) |
| `detect_emerging_clusters` | `min_cluster_size?`, `limit?` | Louvain community detection on the wikilink graph |
| `graduate_observations` | `title`, `query`, `project_tag?`, `tags?` | Promote SQLite observations to a structured vault note |

## Vault structure

```
<your-vault>/
├── Areas/
│   └── claude-code-workflow.md    ← get_conventions (REQUIRED)
├── Resources/
│   ├── decisions/                 ← write_decision output
│   ├── projects/                  ← write_project_summary output
│   └── graduated/                 ← graduate_observations output
└── Archive/
    └── sessions/                  ← write_session_handoff output
```

Directories are created automatically on first write.

## Usage patterns

### First-time project indexing

```
index_project /absolute/path/to/your/project
```

### Blast radius before a refactor

```
get_blast_radius /path/to/project /path/to/project/src/auth/session.ts
```

### Surface prior context at session start

```
search_observations "auth middleware"
get_project_context
```

### Record a significant decision

```
write_observation session_id="..." project_tag="myproject" type="decision"
  content="Chose FTS5 over vector search: simpler, no model dependency"
```

### Trace how an idea developed

```
trace_idea "session handoff"
```

### Promote accumulated observations to vault

```
graduate_observations title="myproject — Session Memory 2026-04-23"
  query="myproject" project_tag="myproject"
```

## Skills

These are external Claude Code skill files, not part of the MCP server itself. They wrap MCP tool calls into convenient slash commands. To use them, place the skill files in `~/.claude/skills/`:

| Skill | What it does |
|---|---|
| `/compact` | Summarizes the session, saves a handoff note, auto-graduates if ≥20 observations |
| `/trace <topic>` | Calls `trace_idea` and formats the result |
| `/emerge` | Calls `detect_emerging_clusters` |
| `/graduate <project>` | Calls `graduate_observations` for a project |
| `/context` | Loads `get_project_context` + `search_observations` for the current task |

## What gets indexed

For each file, Tree-sitter extracts:

| Language | Symbols | Edge type |
|---|---|---|
| TypeScript / TSX | `import`, function/class/interface/variable declarations | `imports` |
| JavaScript / JSX | `import`, `require()`, function/class declarations | `imports` |
| Python | `import`, `from … import`, function/class definitions | `imports` |

## Development

```bash
npm run dev        # tsx watch — restarts on file change
npm run typecheck  # type check without emitting
npm run build      # compile to dist/
```

### Project structure

```
src/
├── config.ts
├── graph/
│   ├── store.ts           # SQLite schema, FTS5, all DB queries
│   ├── builder.ts         # Incremental indexer
│   ├── algorithms.ts      # BFS for get_dependencies + get_blast_radius
│   ├── communities.ts     # Louvain clustering
│   └── watcher.ts         # Chokidar file watcher
├── parsers/
│   ├── code-parser.ts     # Tree-sitter parser (ESM-safe)
│   └── vault-parser.ts    # gray-matter + wikilink regex → VaultNote
├── vault/
│   ├── reader.ts          # searchVault, getConventions, getRecentDecisions
│   ├── writer.ts          # writeDecision, writeSessionHandoff, graduateObservations
│   ├── intelligence.ts    # getVaultIndex, traceIdea, detectEmergingClusters
│   └── obsidian-cli.ts    # Optional HTTP client for Obsidian REST API (port 27124)
└── mcp/
    ├── server.ts          # Entry point: boot sync + stdio transport
    ├── create-server.ts   # McpServer assembly: registerTool + resources
    ├── response.ts        # ok/fail envelope + error codes
    ├── security.ts        # Path admission, secret redaction, injection scan, caps
    ├── provenance.ts      # Origin inference + confidence bands
    ├── docs.ts            # Long-form docs served as MCP resources
    └── tools/
        ├── index.ts       # Registry, zod validation, dispatch
        ├── shared.ts      # Contract type, doc renderer, guards
        ├── code.ts        # 9 code-graph tools
        ├── vault.ts       # 10 vault tools
        └── memory.ts      # 7 episodic-memory tools
docs/
├── overview.md            # Architecture, system diagram, DB schema, tool inventory
├── code-graph.md          # Code graph tools in detail
├── vault-integration.md   # Vault I/O tools in detail
├── episodic-memory.md     # Episodic memory tools + hooks system
├── vault-intelligence.md  # Intelligence tools + Louvain + Obsidian CLI
└── security-and-provenance.md  # Trust boundary, redaction, confidence bands
```

### Database schema (key tables)

```sql
-- Code graph
projects, files, nodes, edges, nodes_fts (FTS5)

-- Vault
vault_notes  (id, path, title, tags, links, content, mtime)

-- Episodic memory
sessions     (id, project_tag, project_path, started_at, ended_at, summary)
observations (id, session_id, project_tag, type, content, context, tags, promoted, origin, created_at)
observations_fts (FTS5, auto-synced via triggers)
```

### Known constraints

- **Grammar versions**: `tree-sitter-typescript@0.23.2` requires `tree-sitter@^0.21`. JS and Python grammars are pinned to `@0.21.x` for compatibility.
- **Self-healing edges**: an import is resolved against the disk at parse time, so a target written moments later resolves to nothing. Matching mtimes would cache that miss forever, so `index_project` re-parses any file whose stored imports point at paths that no longer exist and reports the count as `filesRepaired`.
- **FTS5 rebuild**: `nodes_fts` is an external content table. After a full index run, `rebuildFts()` is called explicitly — triggers alone do not populate external content tables.
- **Boot sync**: only the most recently used project is synced on startup. Syncing all projects on every session causes write contention in multi-session use.
- **Session-start injection**: the `memory-inject.sh` hook injects recent semantic observations (hook-origin rows excluded) plus per-area note counts — ~450 tokens. Titles come from `get_vault_index({ area })` when a task needs them.
- **Hooks cannot call MCP**: shell hooks write directly to SQLite via the `sqlite3` CLI, stamping `origin = 'hook'` so provenance can rank them below agent-written observations. Only Claude (via MCP tools) can call `write_observation` for rich, semantic observations.
- **Legacy observations**: rows written before the `origin` column keep `NULL` and are inferred at read time (`hook` for tool-stamped one-liners, `unknown` otherwise). No backfill is performed — guessing an origin would be worse than admitting it is unknown.
- **Obsidian CLI**: `trace_idea` and `get_vault_index` augment results via the Obsidian Local REST API plugin when available, but degrade gracefully when Obsidian is not running.
