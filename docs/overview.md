# project-graph-mcp — Architecture Overview

A personal MCP server for Claude Code that combines three systems:

1. **Code graph** — dependency analysis across TypeScript, JavaScript, and Python projects
2. **Obsidian vault** — read/write integration with a structured knowledge base
3. **Episodic memory** — persistent observation store across all Claude Code sessions

All three share a single SQLite database at `~/.project-graph/graph.db`, exposed over stdio via the MCP protocol.

---

## System diagram

```
Claude Code session (any directory)
         │
         ├── UserPromptSubmit hooks
         │   ├── open-session.sh       → registers session in DB
         │   ├── memory-inject.sh      → injects vault index + recent observations
         │   └── session-context.sh    → injects last handoff
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
         ┌────────────┼────────────────┐
         ▼            ▼                ▼
    Code graph    Vault I/O      Episodic memory
    (8 tools)    (8 tools)         (6 tools)
         │            │                │
         └────────────┴────────────────┘
                      │
                      ▼
         ~/.project-graph/graph.db (SQLite, WAL mode)
         ├── projects, files, nodes, edges   ← code graph
         ├── vault_notes, nodes_fts          ← vault index
         ├── sessions                        ← session registry
         └── observations, observations_fts  ← episodic memory
```

---

## Three-layer memory model

```
┌──────────────────────────────────────────────────────┐
│  WORKING MEMORY                                      │
│  session-context.sh — last handoff injected          │
│  memory-inject.sh   — compact vault index            │
│  Scope: current session only                         │
├──────────────────────────────────────────────────────┤
│  EPISODIC MEMORY                                     │
│  observations + sessions → SQLite                    │
│  Capture: PostToolUse hook + write_observation       │
│  Search: search_observations (FTS5)                  │
│  Scope: all sessions, all projects                   │
├──────────────────────────────────────────────────────┤
│  SEMANTIC MEMORY                                     │
│  Obsidian vault — structured notes, wikilinks        │
│  Tools: trace_idea, detect_clusters, graduate        │
│  Skills: /context, /trace, /emerge, /drift           │
│  Scope: permanent, cross-project, cross-domain       │
└──────────────────────────────────────────────────────┘
```

**Bridges between layers:**
- Episodic → Semantic: `/graduate` promotes accumulated observations into a vault note
- Semantic → Working: `memory-inject.sh` injects compact vault index at session start
- Working → Episodic: `write_observation` (intentional, from Claude) + PostToolUse hook (automatic, structural)

---

## Database schema

```sql
-- Code graph
CREATE TABLE projects (id, root_path, name, last_indexed_at);
CREATE TABLE files    (id, project_id, path, mtime, hash);
CREATE TABLE nodes    (id, project_id, source_file, symbol, type, path, line, cluster_id);
CREATE TABLE edges    (id, project_id, source_file, from_node, to_node, type);

-- Vault
CREATE TABLE vault_notes (id, path, title, tags, links, content, mtime);

-- FTS5
CREATE VIRTUAL TABLE nodes_fts USING fts5(symbol, path, ...);

-- Episodic memory
CREATE TABLE sessions     (id, project_tag, project_path, started_at, ended_at, summary);
CREATE TABLE observations (id, session_id, project_tag, type, content, context, tags, promoted, created_at);
CREATE VIRTUAL TABLE observations_fts USING fts5(content, context, ...);
```

---

## Tool inventory (26 tools)

| Group | Tools |
|---|---|
| Project management | `get_active_project`, `list_projects`, `index_project`, `get_watcher_status` |
| Dependency graph | `get_dependencies`, `get_blast_radius` |
| Architecture | `get_module_context`, `find_similar_code` |
| Search | `search_knowledge`, `search_vault` |
| Vault read | `get_conventions`, `get_project_context` |
| Vault write | `write_decision`, `write_session_handoff`, `summarize_project_doc`, `write_project_summary` |
| Episodic memory | `write_observation`, `search_observations`, `get_session_timeline`, `get_observation`, `list_sessions`, `close_session` |
| Vault intelligence | `get_vault_index`, `trace_idea`, `detect_emerging_clusters`, `graduate_observations` |

Detailed documentation for each group:

- [Code Graph](./code-graph.md)
- [Vault Integration](./vault-integration.md)
- [Episodic Memory](./episodic-memory.md)
- [Vault Intelligence](./vault-intelligence.md)
