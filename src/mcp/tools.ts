import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config.js';

const MAX_DOC_BYTES = 512_000;

function validatePath(input: string): string | null {
  const abs = resolve(input);
  const roots = [...config.trustedRoots, config.vault];
  return roots.some((root) => abs === root || abs.startsWith(root + '/')) ? abs : null;
}

function wrapUntrusted(content: string, source: string): string {
  return `<external-content source="${source}">\n${content}\n</external-content>`;
}
import { indexProject } from '../graph/builder.js';
import { getDependencies, getBlastRadius } from '../graph/algorithms.js';
import { listProjects, getProjectByPath, upsertSession, closeSession, insertObservation, searchObservations, getSessionTimeline, getObservation, listSessions } from '../graph/store.js';
import type { ObservationType } from '../graph/store.js';
import { searchVault, getConventions, getRecentDecisions } from '../vault/reader.js';
import { writeDecision, writeSessionHandoff, writeProjectSummary, graduateObservations } from '../vault/writer.js';
import { getVaultIndex, traceIdea, detectEmergingClusters } from '../vault/intelligence.js';
import { searchObservations as searchObs, getObservation as getObs, promoteObservation } from '../graph/store.js';
import { getActiveWatcherInfo } from '../graph/watcher.js';
import { searchNodes } from '../graph/store.js';
import { getModuleContext, findSimilarFiles } from '../graph/communities.js';

// ─── Tool definitions ────────────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    name: 'get_active_project',
    description:
      'Returns the active project based on the provided working directory. ' +
      'Pass the absolute path of the current working directory. ' +
      'Returns project metadata and index status.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Absolute path of the current working directory',
        },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'list_projects',
    description: 'Lists all indexed projects with their last indexed time.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'index_project',
    description:
      'Indexes a codebase into the dependency graph. ' +
      'Parses TypeScript, JavaScript, and Python files, extracts imports/exports/symbols. ' +
      'Incremental: only re-parses files that have changed since last index.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the project root to index',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_dependencies',
    description:
      'Returns direct and transitive imports for a given file. ' +
      'Run index_project first if the project has not been indexed.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Absolute path to the project root',
        },
        file: {
          type: 'string',
          description: 'Absolute path to the file to analyze',
        },
      },
      required: ['project_path', 'file'],
    },
  },
  {
    name: 'get_blast_radius',
    description:
      'Returns all files that depend (directly or transitively) on the given file. ' +
      'Answers: "what breaks if I change this file?". ' +
      'Run index_project first if the project has not been indexed.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Absolute path to the project root',
        },
        file: {
          type: 'string',
          description: 'Absolute path to the file to analyze',
        },
      },
      required: ['project_path', 'file'],
    },
  },
  {
    name: 'search_knowledge',
    description:
      'Unified search across code symbols (FTS5) and vault notes (substring). ' +
      'Returns ranked results from both sources merged into a single list. ' +
      'Optionally scope code results to a specific project.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        project_path: {
          type: 'string',
          description: 'Optional: scope code results to this project root',
        },
        limit: {
          type: 'number',
          description: 'Max results per source (default: 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_project_context',
    description:
      'Returns current coding conventions and recent architecture decisions from the vault. ' +
      'Use at the start of a session to load standing context without reading many files.',
    inputSchema: {
      type: 'object',
      properties: {
        decisions_limit: {
          type: 'number',
          description: 'Max recent decisions to return (default: 10)',
        },
      },
    },
  },
  {
    name: 'get_module_context',
    description:
      'Returns the architectural cluster a file belongs to, plus all related files in the same cluster. ' +
      'Cluster names are auto-derived from the common directory prefix of cluster members. ' +
      'Run index_project first.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Absolute path to the project root',
        },
        file: {
          type: 'string',
          description: 'Absolute path to the file to inspect',
        },
      },
      required: ['project_path', 'file'],
    },
  },
  {
    name: 'find_similar_code',
    description:
      'Finds files similar to the given file based on cluster membership and shared symbol names. ' +
      'Structural similarity: same architectural cluster. Lexical similarity: overlapping symbol names. ' +
      'Run index_project first.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Absolute path to the project root',
        },
        file: {
          type: 'string',
          description: 'Absolute path to the file to find similar code for',
        },
        limit: {
          type: 'number',
          description: 'Max results (default: 10)',
        },
      },
      required: ['project_path', 'file'],
    },
  },
  {
    name: 'get_watcher_status',
    description: 'Returns which project (if any) is currently being watched for live graph updates.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_conventions',
    description:
      'Reads the coding conventions and workflow preferences from the Obsidian vault. ' +
      'Returns the content of Areas/claude-code-workflow.md.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'search_vault',
    description:
      'Full-text substring search across all notes in the Obsidian vault. ' +
      'Returns matching notes with title, tags, and a context snippet ranked by match count.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 20)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'write_decision',
    description:
      'Persists an architecture decision record to the Obsidian vault at Resources/decisions/. ' +
      'Creates a markdown note with frontmatter (date, status, tags) and the decision body.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Decision title (becomes the filename slug)',
        },
        body: {
          type: 'string',
          description: 'Full decision text in markdown',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional tags (decision tag is always added)',
        },
        status: {
          type: 'string',
          enum: ['proposed', 'accepted', 'rejected', 'superseded'],
          description: 'Decision status (default: accepted)',
        },
        context: {
          type: 'string',
          description: 'Optional short context/rationale line for frontmatter',
        },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'write_session_handoff',
    description:
      'Saves a session summary to the Obsidian vault at Archive/sessions/. ' +
      'Use at the end of a work session to preserve context for the next one.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Session summary in markdown',
        },
        project: {
          type: 'string',
          description: 'Project name this session was about (optional)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional tags',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'summarize_project_doc',
    description:
      'Reads a repository document and returns its content so Claude can summarize it. ' +
      'After receiving the content, Claude should produce a compressed summary and call ' +
      'write_project_summary to persist it to the vault at Resources/projects/<name>/.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the repository document to read',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_observation',
    description:
      'Saves a memory observation to the episodic store (SQLite). ' +
      'Use to record decisions, discoveries, errors, code changes, notes, or patterns during a session. ' +
      'Observations are searchable across sessions via search_observations.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Current session ID (from CLAUDE_SESSION_ID env or hook)',
        },
        type: {
          type: 'string',
          enum: ['decision', 'discovery', 'error', 'code-change', 'note', 'pattern'],
          description: 'Observation type',
        },
        content: {
          type: 'string',
          description: 'One-sentence human-readable observation',
        },
        project_tag: {
          type: 'string',
          description: 'Semantic project name (e.g. cafe, civil-engineering). Independent of CWD.',
        },
        context: {
          type: 'object',
          description: 'Optional structured context: { file?, line?, tool?, symbol?, url? }',
          properties: {
            file: { type: 'string' },
            line: { type: 'number' },
            tool: { type: 'string' },
            symbol: { type: 'string' },
            url: { type: 'string' },
          },
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for filtering',
        },
      },
      required: ['session_id', 'type', 'content'],
    },
  },
  {
    name: 'search_observations',
    description:
      'Full-text search (FTS5) across all episodic memory observations. ' +
      'Returns ranked results with session context. Optionally filter by project_tag.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        project_tag: {
          type: 'string',
          description: 'Optional: scope to this project (e.g. cafe)',
        },
        limit: {
          type: 'number',
          description: 'Max results (default: 20)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_session_timeline',
    description:
      'Returns all observations for a session in chronological order. ' +
      'Use to reconstruct what happened during a past session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID to inspect',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'list_sessions',
    description:
      'Lists recent Claude Code sessions with their project tag, start/end time, and observation count. ' +
      'Optionally filter by project_tag.',
    inputSchema: {
      type: 'object',
      properties: {
        project_tag: {
          type: 'string',
          description: 'Optional: filter to sessions for this project',
        },
        limit: {
          type: 'number',
          description: 'Max sessions to return (default: 20)',
        },
      },
    },
  },
  {
    name: 'close_session',
    description: 'Marks a session as ended with an optional summary. Called automatically by close-session.sh hook and /compact.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID to close',
        },
        summary: {
          type: 'string',
          description: 'Optional session summary',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'get_observation',
    description: 'Returns a single observation by ID with full context.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Observation ID',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_vault_index',
    description:
      'Returns a structured index of all vault notes grouped by area (Areas, Projects, Resources, etc.). ' +
      'Includes title, tags, wikilinks, and mtime for each note. ' +
      'Use at session start for a compact overview of the knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          description: 'Optional: filter to a specific vault area (e.g. "Areas", "Resources")',
        },
      },
    },
  },
  {
    name: 'trace_idea',
    description:
      'Traces the evolution of an idea or topic across the vault. ' +
      'Searches for the topic by content, title, and wikilinks; follows one-hop connections. ' +
      'Returns a timeline (oldest → newest) showing how the idea developed. ' +
      'Uses Obsidian CLI for richer results when Obsidian is running.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Topic or idea to trace (e.g. "episodic memory", "RxJS", "auth")',
        },
        limit: {
          type: 'number',
          description: 'Max notes to return (default: 30)',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'detect_emerging_clusters',
    description:
      'Detects idea clusters forming in the vault based on wikilink connectivity. ' +
      'Uses connected component analysis on the wikilink graph. ' +
      'Returns clusters ranked by internal link strength, suggesting which groups of notes ' +
      'are coalescing into projects, essays, or products.',
    inputSchema: {
      type: 'object',
      properties: {
        min_cluster_size: {
          type: 'number',
          description: 'Minimum notes per cluster (default: 2)',
        },
        limit: {
          type: 'number',
          description: 'Max clusters to return (default: 10)',
        },
      },
    },
  },
  {
    name: 'graduate_observations',
    description:
      'Promotes episodic memory observations into a structured vault note. ' +
      'Searches observations by query, groups them by type, and writes a graduated note ' +
      'to Resources/graduated/. Marks observations as promoted in the DB.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the graduated note',
        },
        query: {
          type: 'string',
          description: 'Search query to find observations to graduate',
        },
        project_tag: {
          type: 'string',
          description: 'Optional: filter observations to this project tag',
        },
        limit: {
          type: 'number',
          description: 'Max observations to include (default: 50)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional tags for the graduated note',
        },
      },
      required: ['title', 'query'],
    },
  },
  {
    name: 'write_project_summary',
    description:
      'Writes a compressed project document summary to the vault at Resources/projects/<name>/summary.md.',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: {
          type: 'string',
          description: 'Project name (used for folder name and frontmatter)',
        },
        summary: {
          type: 'string',
          description: 'Compressed summary in markdown',
        },
        source_doc: {
          type: 'string',
          description: 'Relative path of the original document (for reference)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional tags',
        },
      },
      required: ['project_name', 'summary', 'source_doc'],
    },
  },
];

// ─── Tool handlers ───────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
}

function requireProject(projectPath: string): { id: string } | ToolResult {
  const abs = resolve(projectPath);
  const project = getProjectByPath(abs);
  if (!project) {
    return err(`Project not indexed: ${abs}. Run index_project first.`);
  }
  return { id: project.id };
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'get_active_project': {
      const cwd = String(args.cwd ?? '').trim();
      if (!cwd) return err('cwd is required');
      const abs = validatePath(cwd);
      if (!abs) return err(`Path not allowed: ${cwd}. Must be under a trusted root.`);
      if (!existsSync(abs)) return err(`Directory not found: ${cwd}`);
      const project = getProjectByPath(abs);

      return ok({
        cwd: abs,
        vault: config.vault,
        grammars: config.grammars.map((g) => g.name),
        indexed: project !== undefined,
        last_indexed_at: project?.last_indexed_at ?? null,
        note: project
          ? 'Project indexed. Use get_dependencies or get_blast_radius.'
          : 'Project not indexed. Run index_project to build the graph.',
      });
    }

    case 'list_projects': {
      const projects = listProjects();
      return ok({ projects });
    }

    case 'index_project': {
      const path = String(args.path ?? '').trim();
      if (!path) return err('path is required');
      const absPath = validatePath(path);
      if (!absPath) return err(`Path not allowed: ${path}. Must be under a trusted root.`);
      if (!existsSync(absPath)) return err(`Directory not found: ${path}`);

      const result = indexProject(absPath);
      return ok(result);
    }

    case 'get_dependencies': {
      const projectPath = String(args.project_path ?? '').trim();
      const file = String(args.file ?? '').trim();
      if (!projectPath) return err('project_path is required');
      if (!file) return err('file is required');

      const project = requireProject(projectPath);
      if ('content' in project) return project;

      const result = getDependencies(project.id, resolve(file));
      return ok(result);
    }

    case 'get_blast_radius': {
      const projectPath = String(args.project_path ?? '').trim();
      const file = String(args.file ?? '').trim();
      if (!projectPath) return err('project_path is required');
      if (!file) return err('file is required');

      const project = requireProject(projectPath);
      if ('content' in project) return project;

      const result = getBlastRadius(project.id, resolve(file));
      return ok(result);
    }

    case 'search_knowledge': {
      const query = String(args.query ?? '').trim();
      if (!query) return err('query is required');
      const limit = typeof args.limit === 'number' ? args.limit : 10;

      // Code symbols — FTS5
      let projectId: string | undefined;
      if (args.project_path) {
        const proj = getProjectByPath(resolve(String(args.project_path)));
        projectId = proj?.id;
      }
      const codeResults = searchNodes(query, projectId, limit).map((r) => ({
        source: 'code' as const,
        symbol: r.symbol,
        type: r.type,
        path: r.path,
        file: r.source_file,
        rank: r.rank,
      }));

      // Vault notes — substring
      const vaultResults = searchVault(query, limit).map((r) => ({
        source: 'vault' as const,
        title: r.title,
        path: r.path,
        tags: r.tags,
        snippet: r.snippet,
        score: r.score,
      }));

      return ok({
        query,
        code: codeResults,
        vault: vaultResults,
        total: codeResults.length + vaultResults.length,
      });
    }

    case 'get_project_context': {
      const decisionsLimit = typeof args.decisions_limit === 'number' ? args.decisions_limit : 10;
      const conventions = getConventions();
      const decisions = getRecentDecisions(decisionsLimit);
      return ok({
        conventions: conventions ?? 'Conventions file not found.',
        recent_decisions: decisions,
        note: 'Architecture context (module clusters) available in Phase 6 via get_module_context.',
      });
    }

    case 'get_module_context': {
      const projectPath = String(args.project_path ?? '').trim();
      const file = String(args.file ?? '').trim();
      if (!projectPath) return err('project_path is required');
      if (!file) return err('file is required');

      const project = requireProject(projectPath);
      if ('content' in project) return project;

      const ctx = getModuleContext(project.id, resolve(projectPath), resolve(file));
      return ok(ctx);
    }

    case 'find_similar_code': {
      const projectPath = String(args.project_path ?? '').trim();
      const file = String(args.file ?? '').trim();
      if (!projectPath) return err('project_path is required');
      if (!file) return err('file is required');
      const limit = typeof args.limit === 'number' ? args.limit : 10;

      const project = requireProject(projectPath);
      if ('content' in project) return project;

      const results = findSimilarFiles(project.id, resolve(file), limit);
      return ok({ file: resolve(file), similar: results });
    }

    case 'get_watcher_status': {
      const info = getActiveWatcherInfo();
      return ok(info ?? { watching: false });
    }

    case 'get_conventions': {
      const content = getConventions();
      if (!content) return err('Conventions file not found: Areas/claude-code-workflow.md');
      return ok({ content });
    }

    case 'search_vault': {
      const query = String(args.query ?? '').trim();
      if (!query) return err('query is required');
      const limit = typeof args.limit === 'number' ? args.limit : 20;
      const results = searchVault(query, limit).map((r) => ({
        ...r,
        snippet: wrapUntrusted(r.snippet, r.path),
      }));
      return ok({ query, results, count: results.length });
    }

    case 'write_decision': {
      const title = String(args.title ?? '').trim();
      const body = String(args.body ?? '').trim();
      if (!title) return err('title is required');
      if (!body) return err('body is required');

      const absPath = writeDecision({
        title,
        body,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
        status: (['proposed','accepted','rejected','superseded'].includes(String(args.status))
          ? args.status as 'proposed' | 'accepted' | 'rejected' | 'superseded'
          : 'accepted'),
        context: args.context ? String(args.context) : undefined,
      });
      return ok({ created: absPath.replace(config.vault + '/', '') });
    }

    case 'write_session_handoff': {
      const summary = String(args.summary ?? '').trim();
      if (!summary) return err('summary is required');

      const absPath = writeSessionHandoff({
        summary,
        project: args.project ? String(args.project) : undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
      });
      return ok({ created: absPath.replace(config.vault + '/', '') });
    }

    case 'summarize_project_doc': {
      const docPath = String(args.path ?? '').trim();
      if (!docPath) return err('path is required');
      const absDocPath = validatePath(docPath);
      if (!absDocPath) return err(`Path not allowed: ${docPath}. Must be under a trusted root.`);
      if (!existsSync(absDocPath)) return err(`File not found: ${docPath}`);

      const raw = readFileSync(absDocPath, 'utf-8');
      const byteLength = Buffer.byteLength(raw);
      if (byteLength > MAX_DOC_BYTES) {
        return err(`File too large (${Math.round(byteLength / 1024)} KB). Max: ${MAX_DOC_BYTES / 1024} KB.`);
      }

      return ok({
        path: absDocPath,
        content: wrapUntrusted(raw, absDocPath),
        instruction:
          'Produce a compressed summary of the above document, then call write_project_summary to persist it.',
      });
    }

    case 'write_project_summary': {
      const projectName = String(args.project_name ?? '').trim();
      const summary = String(args.summary ?? '').trim();
      const sourceDoc = String(args.source_doc ?? '').trim();
      if (!projectName) return err('project_name is required');
      if (!summary) return err('summary is required');
      if (!sourceDoc) return err('source_doc is required');

      const absPath = writeProjectSummary({
        projectName,
        summary,
        sourceDoc,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
      });
      return ok({ created: absPath.replace(config.vault + '/', '') });
    }

    case 'get_vault_index': {
      const index = getVaultIndex();
      if (args.area) {
        const area = String(args.area);
        const filtered = index.by_area[area];
        if (!filtered) return err(`Area not found: ${area}. Available: ${Object.keys(index.by_area).join(', ')}`);
        return ok({ area, notes: filtered, count: filtered.length, generated_at: index.generated_at });
      }
      return ok(index);
    }

    case 'trace_idea': {
      const topic = String(args.topic ?? '').trim();
      if (!topic) return err('topic is required');
      const limit = typeof args.limit === 'number' ? args.limit : 30;
      const result = await traceIdea(topic, limit);
      return ok(result);
    }

    case 'detect_emerging_clusters': {
      const minSize = typeof args.min_cluster_size === 'number' ? args.min_cluster_size : 2;
      const limit = typeof args.limit === 'number' ? args.limit : 10;
      const result = detectEmergingClusters(minSize, limit);
      return ok(result);
    }

    case 'graduate_observations': {
      const title = String(args.title ?? '').trim();
      const query = String(args.query ?? '').trim();
      if (!title) return err('title is required');
      if (!query) return err('query is required');
      const projectTag = args.project_tag ? String(args.project_tag) : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : 50;

      const observations = searchObs(query, projectTag, limit);
      if (observations.length === 0) return err(`No observations found for query: "${query}"`);

      const absPath = graduateObservations({
        title,
        observations,
        projectTag,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
      });

      // Mark as promoted
      for (const obs of observations) {
        promoteObservation(obs.id);
      }

      return ok({
        created: absPath.replace(config.vault + '/', ''),
        observations_graduated: observations.length,
        observations_promoted: observations.length,
      });
    }

    case 'write_observation': {
      const sessionId = String(args.session_id ?? '').trim();
      const type = String(args.type ?? '').trim() as ObservationType;
      const content = String(args.content ?? '').trim();
      if (!sessionId) return err('session_id is required');
      if (!content) return err('content is required');

      const validTypes: ObservationType[] = ['decision', 'discovery', 'error', 'code-change', 'note', 'pattern'];
      if (!validTypes.includes(type)) return err(`type must be one of: ${validTypes.join(', ')}`);

      const projectTag = args.project_tag ? String(args.project_tag) : null;

      // Ensure session row exists (idempotent)
      upsertSession(sessionId, projectTag, null);

      const id = `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      insertObservation({
        id,
        session_id: sessionId,
        project_tag: projectTag,
        type,
        content,
        context: args.context && typeof args.context === 'object' ? args.context as Record<string, unknown> : undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
      });
      return ok({ id, session_id: sessionId, type, content });
    }

    case 'search_observations': {
      const query = String(args.query ?? '').trim();
      if (!query) return err('query is required');
      const projectTag = args.project_tag ? String(args.project_tag) : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : 20;
      const results = searchObservations(query, projectTag, limit).map((r) => ({
        ...r,
        content: wrapUntrusted(r.content, `observation:${r.id}`),
      }));
      return ok({ query, results, count: results.length });
    }

    case 'get_session_timeline': {
      const sessionId = String(args.session_id ?? '').trim();
      if (!sessionId) return err('session_id is required');
      const observations = getSessionTimeline(sessionId).map((r) => ({
        ...r,
        content: wrapUntrusted(r.content, `observation:${r.id}`),
      }));
      return ok({ session_id: sessionId, observations, count: observations.length });
    }

    case 'list_sessions': {
      const projectTag = args.project_tag ? String(args.project_tag) : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : 20;
      const sessions = listSessions(projectTag, limit);
      return ok({ sessions, count: sessions.length });
    }

    case 'close_session': {
      const sessionId = String(args.session_id ?? '').trim();
      if (!sessionId) return err('session_id is required');
      const summary = args.summary ? String(args.summary) : undefined;
      closeSession(sessionId, summary);
      return ok({ closed: sessionId, summary: summary ?? null });
    }

    case 'get_observation': {
      const id = String(args.id ?? '').trim();
      if (!id) return err('id is required');
      const obs = getObservation(id);
      if (!obs) return err(`Observation not found: ${id}`);
      return ok(obs);
    }

    default:
      return err(`Unknown tool: ${name}`);
  }
}
