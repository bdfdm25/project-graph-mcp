# Episodic Memory

Persistent observation store that records what happened across all Claude Code sessions. Captures decisions, discoveries, errors, and code changes — either automatically via shell hooks or intentionally via `write_observation` — and surfaces them through FTS5 search and session timelines.

---

## How it works

```
Two capture paths:

  Automatic (hooks)                    Intentional (Claude)
  ─────────────────                    ────────────────────
  PostToolUse → capture-observation.sh → sqlite3 CLI
    Edit/Write   → code-change           write_observation MCP tool
    Bash (git/npm/docker/…) → code-change    type = decision | discovery | error
    write_decision → decision                    | code-change | note | pattern
    write_session_handoff → note
```

**Storage**: `observations` table + `observations_fts` FTS5 virtual table in `~/.project-graph/graph.db`.

**FTS5 triggers**: INSERT/UPDATE/DELETE on `observations` are automatically synced to `observations_fts` via SQL triggers. No manual indexing needed.

**Session tracking**: every Claude Code session is registered in the `sessions` table by `open-session.sh` (UserPromptSubmit hook). Each observation is linked to its session via `session_id`.

---

## Observation types

| Type | When to use |
|---|---|
| `decision` | Architecture choices, approach trade-offs, rejected alternatives |
| `discovery` | Non-obvious facts: API quirks, env constraints, undocumented behaviors |
| `error` | Bugs found and fixed; failed attempts with root cause |
| `code-change` | Meaningful edits — refactors, new features, significant fixes |
| `note` | General session notes, handoffs, reminders |
| `pattern` | Recurring structures or conventions worth naming |

---

## Tools

### `write_observation`

Records a new observation in the episodic store.

```
Inputs:
  session_id   (string)          — Claude session ID (from CLAUDE_SESSION_ID or detected via ls)
  project_tag  (string)          — semantic project name (e.g. "cafe", "project-graph-mcp")
  type         (ObservationType) — see table above
  content      (string)          — observation text
  context?     (object)          — structured metadata: { file?, line?, tool? }
  tags?        (string[])

Output:  { id: string }          — generated observation ID
```

**When to call**: after any significant decision, discovery, error fix, or meaningful code change. Do not wait for end of session — write observations as events happen.

**`project_tag` vs `project_path`**: `project_tag` is a semantic name independent of CWD. Use the same tag across all sessions for a project (e.g. `cafe`, not `/home/user/projects/cafe`).

**Example use**: after choosing FTS5 over vector search, call `write_observation` with `type=decision`, `content="FTS5 chosen over sqlite-vec: simpler, no model dependency, fast enough for <10k symbols"`.

---

### `search_observations`

Full-text search across all observations using FTS5.

```
Inputs:  query, project_tag? (scope to one project), limit? (default 20)
Output:  [{
  id, session_id, project_tag, type, content, context,
  tags, promoted, created_at, rank
}]
```

**FTS5 query**: each word in `query` is automatically suffixed with `*` for prefix matching. `"session context"` matches `"session_context"`, `"sessions"`, etc.

**When to use**: at session start, search with current task keywords to surface relevant prior context before starting work.

**Example**: `search_observations("auth middleware session")` — returns all past observations about authentication across all projects.

---

### `get_session_timeline`

Returns all observations from a specific session in chronological order.

```
Inputs:  session_id (string)
Output:  [ObservationRow]  // ordered by created_at ASC
```

**When to use**: to replay what happened in a past session — useful for debugging or understanding decisions made in a session you're resuming.

---

### `get_observation`

Fetches a single observation by ID.

```
Inputs:  id (string)
Output:  ObservationRow | null
```

**When to use**: when you have an ID from search results and need the full record (e.g., to check the `context` field or `promoted` status).

---

### `list_sessions`

Lists recorded sessions, optionally filtered by project.

```
Inputs:  project_tag? (string), limit? (default 20)
Output:  [{
  id, project_tag, project_path, started_at, ended_at, summary
}]
```

Sessions are ordered by `started_at DESC`. `ended_at` is null for sessions that ended without calling `close_session` (e.g., crash or kill).

---

### `close_session`

Marks a session as ended in the database.

```
Inputs:  session_id (string), summary? (string)
Output:  { closed: true }
```

**When called**: automatically by `close-session.sh` (Stop hook) at the end of each Claude Code session.

**`summary`**: optional short description of what was accomplished. The `/compact` skill sets this to `"[compact]"` to mark sessions that were properly closed.

---

## Hooks system

Three shell hooks manage session lifecycle and automatic observation capture. All hooks write directly to SQLite via the `sqlite3` CLI — they cannot call MCP tools.

### `open-session.sh` — UserPromptSubmit

Fires once per session (sentinel file at `/tmp/claude-open-session-$SESSION_ID`). Registers the session in the `sessions` table.

**`project_tag` detection** (3-step fallback):
1. Match current CWD against indexed project `root_path` values in DB
2. Grep local `CLAUDE.md` for a `# project:` or project name line
3. Use `basename $CWD` as last resort

**SQL**: `INSERT OR IGNORE INTO sessions (id, project_tag, project_path, started_at) VALUES (...)`

---

### `capture-observation.sh` — PostToolUse

Fires after every tool use. Applies a filter to decide what to capture, then writes to `observations` via `sqlite3`.

**Filter rules** (case statement on tool name):

| Tool | Captured as | Condition |
|---|---|---|
| `Edit`, `Write`, `NotebookEdit` | `code-change` | always |
| `Bash` | `code-change` | command contains `git`, `npm`, `yarn`, `pnpm`, `docker`, `curl`, `wget`, `pip`, `cargo`, `make`, `tsc`, `npx` |
| `Bash` | `code-change` | command contains `rm`, `mv`, `cp`, `mkdir`, `chmod` AND path does NOT match `/tmp/`, `/dev/null`, `*.log`, `sentinel` |
| `mcp__project-graph__write_decision` | `decision` | always |
| `mcp__project-graph__write_session_handoff` | `note` | always |
| anything else | — | skipped |

**Content extraction** (jq, no LLM):
- `Edit` / `Write`: extracts filename + first 40 chars of `old_string` (the "what changed")
- `Bash`: extracts first 80 chars of `command`
- `write_decision`: extracts `title` from tool input

**Design rationale**: removing the Haiku LLM call eliminated the ANTHROPIC_API_KEY dependency (Claude Code subscription is OAuth-based and does not expose raw API keys). Structural jq extraction handles automatic capture; rich semantic observations come from Claude calling `write_observation` intentionally during the session.

---

### `close-session.sh` — Stop

Fires when the Claude Code session ends. Updates `ended_at` in the sessions table:

```sql
UPDATE sessions SET ended_at = <epoch_ms> WHERE id = '<session_id>';
```

---

### `memory-inject.sh` — UserPromptSubmit

Fires once per session (sentinel file). Injects a compact memory block into the conversation context.

**Injected content** (3 parts):
1. Recent 5 observations from DB (for current or all projects)
2. Vault index by area (max 20 notes/area, sorted by mtime desc)
3. List of currently indexed projects

**Token budget**: measured at ~343 tokens with a typical vault; estimated max ~700 tokens even with a large vault. Stays well under the 500-token meta target.

---

## Database schema

```sql
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,     -- Claude session UUID
  project_tag  TEXT,                 -- semantic project name
  project_path TEXT,                 -- CWD at session start
  started_at   INTEGER NOT NULL,     -- epoch ms
  ended_at     INTEGER,              -- null if session still open / crashed
  summary      TEXT                  -- set by close_session or /compact
);

CREATE TABLE observations (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  project_tag TEXT,
  type        TEXT NOT NULL,         -- decision|discovery|error|code-change|note|pattern
  content     TEXT NOT NULL,
  context     TEXT,                  -- JSON: { file?, line?, tool? }
  tags        TEXT,                  -- JSON array
  promoted    INTEGER DEFAULT 0,     -- 1 after graduate_observations
  created_at  INTEGER NOT NULL       -- epoch ms
);

CREATE VIRTUAL TABLE observations_fts USING fts5(
  content,
  context,
  content='observations',
  content_rowid='rowid'
);
-- Auto-synced via INSERT/UPDATE/DELETE triggers
```

---

## Source files

| File | Responsibility |
|---|---|
| `src/graph/store.ts` | `sessions` + `observations` schema, FTS5 triggers, `upsertSession`, `closeSession`, `insertObservation`, `searchObservations`, `getSessionTimeline`, `getObservation`, `listSessions`, `promoteObservation` |
| `~/.claude/hooks/open-session.sh` | UserPromptSubmit — registers session, detects project_tag |
| `~/.claude/hooks/capture-observation.sh` | PostToolUse — jq-only structural capture |
| `~/.claude/hooks/close-session.sh` | Stop — marks session ended |
| `~/.claude/hooks/memory-inject.sh` | UserPromptSubmit — injects vault index + recent observations |
