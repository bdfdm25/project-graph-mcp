# project-graph-mcp

Personal MCP server for Claude Code. Combines code graph analysis with Obsidian vault integration to reduce token consumption and provide active project knowledge management.

## What it does

- **Code graph** — parses your codebase with Tree-sitter, stores a dependency graph in SQLite. Answers "what breaks if I change X?" without Claude reading 40+ files.
- **Vault integration** — reads and writes your Obsidian vault. Decisions, conventions, and session handoffs become queryable context.
- **Unified search** — one query across code symbols and vault notes.

## Requirements

- Node.js 20+
- Claude Code CLI
- Obsidian vault at `~/Development/obsidian-vault/` (or configured path)

## Setup

```bash
git clone git@github.com:youruser/project-graph-mcp.git ~/Development/project-graph-mcp
cd ~/Development/project-graph-mcp
npm install
```

Registration is handled automatically by `~/.claude-config/install.sh`. To register manually:

```bash
claude mcp add --scope user project-graph \
  ./node_modules/.bin/tsx \
  -- ./src/mcp/server.ts
```

Verify:

```bash
claude mcp get project-graph
# Status: ✓ Connected
```

## Configuration

Edit `project-graph.config.json` in the project root:

```json
{
  "vault": "~/Development/obsidian-vault",
  "grammars": [
    { "name": "typescript", "extensions": [".ts", ".tsx"] },
    { "name": "javascript", "extensions": [".js", ".jsx", ".mjs"] },
    { "name": "python",     "extensions": [".py"] }
  ],
  "ignore": ["node_modules", "dist", ".git", "coverage", "__pycache__", ".next", ".angular"],
  "db": "~/.project-graph/graph.db",
  "watchDebounce": 300
}
```

Adding a new language: install the grammar (`npm install tree-sitter-go`) and add an entry to `grammars`. No code changes required.

## Development

```bash
npm run dev       # tsx watch — restarts on file change
npm run typecheck # type check without emitting
npm run build     # compile to dist/
```

## Tools (by phase)

| Phase | Tool | Description |
|---|---|---|
| 1 | `get_active_project` | Auto-detect active project from CWD |
| 1 | `list_projects` | List all indexed projects |
| 2 | `index_project` | Index a codebase into the graph |
| 2 | `get_dependencies` | Imports, direct + transitive |
| 2 | `get_blast_radius` | What breaks if this file changes |
| 3 | `get_conventions` | Read coding standards from vault |
| 3 | `write_decision` | Persist architecture decision to vault |
| 3 | `search_vault` | Full-text search across vault notes |
| 3 | `write_session_handoff` | Save session summary to vault |
| 3 | `summarize_project_doc` | Compress repo doc into vault summary |
| 4 | *(incremental watcher)* | Live graph updates on file change |
| 5 | `search_knowledge` | Unified code + vault search |
| 5 | `get_project_context` | Conventions + decisions + architecture |
| 6 | `get_module_context` | Architecture cluster for a file |
| 6 | `find_similar_code` | Semantically similar files/symbols |

## Status

Phase 1 complete — MCP skeleton, config loader, server registration.
See `docs/` for the full development plan and publishing guide (forthcoming).
