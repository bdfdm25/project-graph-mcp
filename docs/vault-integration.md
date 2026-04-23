# Vault Integration

Read and write integration with an Obsidian vault stored as plain Markdown files. Provides access to conventions, architecture decisions, project summaries, and session handoffs — structured knowledge that persists across sessions without requiring the code graph.

---

## How it works

The vault is a directory of Markdown files with YAML frontmatter and `[[wikilinks]]`. The server accesses it directly via the filesystem — no Obsidian process required.

```
~/Development/obsidian-vault/          (configurable via "vault" in config)
├── Areas/
│   └── claude-code-workflow.md        ← get_conventions
├── Resources/
│   ├── decisions/
│   │   └── YYYY-MM-DD-<slug>.md       ← write_decision output
│   └── projects/
│       └── <project>/summary.md       ← write_project_summary output
└── Archive/
    └── sessions/
        └── <timestamp>-handoff.md     ← write_session_handoff output
```

**Parsing**: each note is parsed with `gray-matter` (frontmatter) + regex (wikilinks). The result includes `title`, `tags`, `links` (wikilink targets), `content` (body only), and `raw` (full file).

**Search**: substring match across `raw` content. Score = occurrence count. Results sorted by score descending.

---

## Tools

### `search_vault`

Full-text substring search across all notes in the vault.

```
Inputs:  query (string), limit? (default 20)
Output:  [{
  path:    string,   // relative to vault root
  title:   string,
  tags:    string[],
  snippet: string,   // surrounding context of first match
  score:   number    // match count
}]
```

**Example use**: "Search vault for 'auth middleware'" — surfaces notes from any area of the vault without knowing where they are.

---

### `search_knowledge`

Unified search across both the code graph (FTS5) and vault notes (substring), merged into a single ranked result list.

```
Inputs:  query, project_path? (scope code results), limit? (default 10)
Output:  {
  query,
  code:  [{ source: 'code', symbol, type, path, file, rank }],
  vault: [{ source: 'vault', title, path, tags, snippet, score }],
  total: number
}
```

**Example use**: "Find everything related to 'session'" — returns both the `SessionService` class from code and the `session-design.md` decision note from the vault in one call.

---

### `get_conventions`

Reads the coding conventions and workflow preferences from the vault.

```
Inputs:  (none)
Output:  { content: string }  // markdown text of Areas/claude-code-workflow.md
```

Returns `null`-equivalent error if the file does not exist.

---

### `get_project_context`

Returns conventions + recent architecture decisions in a single call. Use at session start to load standing context.

```
Inputs:  decisions_limit? (default 10)
Output:  {
  conventions:       string,   // content of claude-code-workflow.md
  recent_decisions:  [{
    title, date, status, path, snippet
  }]
}
```

**Why**: eliminates the need to read conventions and decisions separately, saving two tool calls at the start of every session.

---

### `write_decision`

Saves an Architecture Decision Record (ADR) to the vault.

```
Inputs:
  title   (string)            — becomes the filename slug
  body    (string)            — full decision text in markdown
  tags?   (string[])
  status? ('proposed'|'accepted'|'rejected'|'superseded')  default: 'accepted'
  context? (string)           — short rationale line for frontmatter

Output:  { created: string }  // relative path of created file
```

**Output path**: `Resources/decisions/YYYY-MM-DD-<slug>.md`

**Frontmatter written**:
```yaml
---
title: My Decision
date: 2026-04-23
status: accepted
tags:
  - decision
  - my-tag
context: Optional rationale here
---
```

**Example use**: after deciding to use FTS5 instead of vector search, record the decision so future sessions don't re-debate it.

---

### `write_session_handoff`

Saves a session summary to the vault for the next session to pick up.

```
Inputs:
  summary  (string)    — session summary in markdown
  project? (string)    — project name for frontmatter
  tags?    (string[])

Output:  { created: string }  // relative path of created file
```

**Output path**: `Archive/sessions/<ISO-timestamp>-handoff.md`

Called automatically by the `/compact` skill at the end of a session. The `session-context.sh` hook injects the most recent handoff file at the start of the next session.

---

### `summarize_project_doc`

Reads a repository document and returns its content so Claude can summarize it.

```
Inputs:  path (absolute path to file)
Output:  { path, content, instruction }
```

This tool is a two-step workflow:
1. Call `summarize_project_doc` — returns raw content
2. Claude produces a compressed summary
3. Call `write_project_summary` — persists the summary

**Why a two-step flow**: the compression step requires Claude's judgment. The tool handles I/O; Claude handles the cognitive work.

---

### `write_project_summary`

Persists a compressed project document summary to the vault.

```
Inputs:
  project_name  (string)   — used for folder name and frontmatter
  summary       (string)   — compressed summary in markdown
  source_doc    (string)   — relative path of the original document
  tags?         (string[])

Output:  { created: string }  // relative path of created file
```

**Output path**: `Resources/projects/<slug>/summary.md`

**Example use**: summarize a long `ARCHITECTURE.md` once and reference the vault note in all future sessions instead of re-reading the full document.

---

## Vault structure

The vault layout is based on the PARA method (Projects, Areas, Resources, Archive). Only the paths that the server writes to are required — everything else is optional.

```
vault/
├── Areas/
│   └── claude-code-workflow.md   ← REQUIRED for get_conventions
├── Projects/                     ← exploratory project notes (cafe, civil-engineering)
├── Resources/
│   ├── decisions/                ← auto-created on first write_decision
│   └── projects/                 ← auto-created on first write_project_summary
└── Archive/
    └── sessions/                 ← auto-created on first write_session_handoff
```

All directories are created with `mkdirSync({ recursive: true })` on first write. Vault path is configurable via `"vault"` in `project-graph.config.json`.

---

## Source files

| File | Responsibility |
|---|---|
| `src/vault/reader.ts` | `searchVault`, `getConventions`, `getRecentDecisions`, `getNoteByRelPath` |
| `src/vault/writer.ts` | `writeDecision`, `writeSessionHandoff`, `writeProjectSummary`, `graduateObservations` |
| `src/parsers/vault-parser.ts` | `parseVaultNote` — gray-matter + wikilink regex, returns `VaultNote` |
