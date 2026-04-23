# Vault Intelligence

Higher-order analysis of the Obsidian vault: indexing, idea tracing, emerging cluster detection, and observation graduation. Uses file-based parsing by default; augments with the Obsidian REST API when the desktop app is running.

---

## How it works

```
Vault notes (Markdown + YAML frontmatter + [[wikilinks]])
         │
         ▼
  collectAllNotes()
  ├── walk vault directory recursively
  ├── skip .claude.md files (handoffs)
  └── parse each note → { title, tags, links, content, mtime }
         │
         ├── getVaultIndex()  → grouped by PARA area
         ├── traceIdea()      → content/link match + one-hop expansion → timeline
         └── detectEmergingClusters()
               ├── build UndirectedGraph from wikilinks
               ├── run Louvain community detection
               └── fallback: BFS connected components
```

**Parsing**: `src/parsers/vault-parser.ts` — `gray-matter` for YAML frontmatter, regex for `[[wikilinks]]`. Returns `{ title, tags, links, content, raw, mtime }`.

**Louvain**: `graphology` + `graphology-communities-louvain`. Nodes = note titles (lowercased). Edges = wikilinks between notes that exist in the vault. Only internal links are considered (links to non-existent notes are ignored).

**Obsidian CLI**: optional HTTP client at `:27124` (Obsidian Local REST API plugin). 500ms timeout, graceful fallback to file-based search when unavailable.

---

## Tools

### `get_vault_index`

Returns a structured index of all vault notes, grouped by PARA area.

```
Inputs:  (none)
Output:  {
  total:        number,
  generated_at: number,
  by_area: {
    "<area>": [{
      area:    string,
      title:   string,
      relPath: string,     // relative to vault root
      tags:    string[],
      links:   string[],   // wikilink targets
      mtime:   number
    }]
  }
}
```

**Area detection**: first directory component of the relative path. A note at `Areas/projects/foo.md` → area `"Areas"`. Notes at vault root → area `"Root"`.

**Sort order**: within each area, notes are sorted by `mtime` descending (most recently modified first).

**When to use**: at session start via `memory-inject.sh` — provides a compact map of all vault content without loading full note bodies. Also useful for "what notes exist in Areas/Resources?" questions.

---

### `trace_idea`

Traces how an idea evolves across vault notes over time. Returns a chronological timeline of all notes that mention or link to the topic.

```
Inputs:  topic (string), limit? (default 30)
Output:  {
  topic:           string,
  notes_found:     number,
  timeline:        [{
    relPath:      string,
    title:        string,
    mtime:        number,
    snippet:      string,    // surrounding context of first match
    links_to:     string[],  // wikilinks this note contains
    linked_from:  string[]   // notes that link back to this one
  }],
  via_obsidian_cli: boolean
}
```

**Match strategy** (4 layers, applied in order):
1. **Obsidian CLI search** (if available) — alias-aware, transclusion-aware
2. **Content match** — `note.raw.toLowerCase().includes(topic)`
3. **Title match** — filename stem contains topic
4. **Link match** — note's wikilinks contain topic

**One-hop expansion**: after initial matches, follows wikilinks from matched notes one level deep to surface related notes that may not directly mention the topic.

**Backlink index**: built in memory from all notes before matching. Each result's `linked_from` field shows which other notes point to it.

**Sort**: `timeline` is sorted by `mtime` ascending — earliest mentions first, showing idea evolution from initial thought to current state.

**Example use**: `trace_idea("session handoff")` — shows how the session handoff concept developed from an early note to the current implementation decision.

---

### `detect_emerging_clusters`

Runs Louvain community detection on the vault's wikilink graph to surface groups of notes that are tightly interconnected — revealing emerging themes before they're explicitly named.

```
Inputs:  min_cluster_size? (default 2), limit? (default 10)
Output:  {
  clusters: [{
    theme:       string,     // most frequent word across note titles
    notes:       string[],   // relative paths
    note_titles: string[],
    strength:    number,     // internal link count between cluster members
    tags:        string[],   // union of tags across cluster members
    first_seen:  number,     // oldest mtime in cluster (epoch ms)
    last_seen:   number      // newest mtime in cluster (epoch ms)
  }],
  total_notes_analyzed: number,
  generated_at:         number,
  algorithm: 'louvain' | 'connected-components'
}
```

**Algorithm**:
1. Build `UndirectedGraph` (graphology) — one node per note title, one edge per wikilink between existing notes
2. Run `graphology-communities-louvain` — assigns each node a cluster ID
3. If graph has no edges (or Louvain throws): fall back to BFS connected components
4. Group nodes by cluster ID, filter by `min_cluster_size`, sort by `strength` desc

**Theme derivation**: splits all note titles in the cluster into words, removes stopwords (English + Portuguese), picks the most frequent word as the cluster theme.

**Strength**: count of wikilinks between notes within the same cluster. Higher = more tightly coupled.

**Sort**: clusters are sorted by `strength` descending, then by `notes.length` descending.

**Example use**: `detect_emerging_clusters()` — reveals that 5 notes about "auth", "JWT", "session", "middleware", and "RBAC" form a tight cluster before you've created an explicit "Authentication" folder.

---

### `graduate_observations`

Promotes accumulated episodic observations from SQLite to a structured vault note. Marks promoted observations as `promoted=1` to avoid re-graduating them.

```
Inputs:
  title        (string)     — becomes the filename slug and note title
  query        (string)     — FTS5 query to select observations
  project_tag? (string)     — scope to one project
  tags?        (string[])

Output:  { created: string }  // relative path of created vault note
```

**Output path**: `Resources/graduated/YYYY-MM-DD-<slug>.md`

**Note structure**: observations are grouped by type and rendered as a timestamped bullet list:

```markdown
## Decisions

- **2026-04-23 14:30** _(src/vault/writer.ts)_: FTS5 chosen over sqlite-vec for observations search

## Discoveries

- **2026-04-23 15:02**: Louvain requires at least one edge — added BFS fallback for sparse graphs

## Errors & Fixes

- **2026-04-23 16:11**: capture-observation.sh was capturing rm /tmp/ — fixed by excluding /tmp paths
```

**Footer**: `_Graduated from N episodic observations on YYYY-MM-DD._`

**Frontmatter**:
```yaml
---
title: project-graph-mcp — Session Memory 2026-04-23
date: 2026-04-23
type: graduated-observations
tags:
  - graduated
  - project-graph-mcp
project: project-graph-mcp
---
```

**When called**: automatically by `/compact` if ≥20 unpromoted observations exist for the session's project. Can also be called manually via the `/graduate <project>` skill.

---

## Obsidian CLI integration

`src/vault/obsidian-cli.ts` provides an optional HTTP client for the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.

```
Endpoint: http://localhost:27124
Timeout:  500ms
Fallback: all calls degrade gracefully — file-based equivalents are used when unavailable
```

**Functions**:

| Function | Obsidian endpoint | Purpose |
|---|---|---|
| `isObsidianCliAvailable()` | `GET /` | Availability check (cached per process) |
| `getActiveNote()` | `GET /active/` | Currently open note in Obsidian |
| `openNote(path)` | `POST /active/` | Open a specific note in Obsidian |
| `getNoteContent(path)` | `GET /vault/<path>` | Read note content via API |
| `listVaultFiles()` | `GET /vault/` | List all vault files |
| `searchVaultCli(query)` | `POST /search/simple/` | Wikilink-aware search |

**`traceIdea` integration**: when Obsidian is running, `searchVaultCli` is called first for alias-aware and transclusion-aware results, then file-based content matching is applied on top.

**Why optional**: Obsidian doesn't need to be running for any tool to work. The desktop app enhances results but is never required.

---

## Skills

Four skills use vault intelligence tools:

| Skill | Tool(s) used | Purpose |
|---|---|---|
| `/trace <topic>` | `trace_idea` | Show how an idea evolved across notes |
| `/emerge` | `detect_emerging_clusters` | Surface tight note clusters |
| `/graduate <project>` | `graduate_observations` | Promote observations to vault |
| `/context` | `get_project_context` + `search_observations` | Load full session context |

The `/compact` skill calls `graduate_observations` automatically when ≥20 unpromoted observations exist.

---

## Source files

| File | Responsibility |
|---|---|
| `src/vault/intelligence.ts` | `getVaultIndex`, `traceIdea`, `detectEmergingClusters` |
| `src/vault/writer.ts` | `graduateObservations` — writes structured vault note from observations |
| `src/vault/obsidian-cli.ts` | HTTP client for Obsidian Local REST API, 500ms timeout, graceful fallback |
| `src/parsers/vault-parser.ts` | `parseVaultNote` — gray-matter + wikilink regex, returns `VaultNote` |
