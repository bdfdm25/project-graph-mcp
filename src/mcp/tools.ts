import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config.js';
import { indexProject } from '../graph/builder.js';
import { getDependencies, getBlastRadius } from '../graph/algorithms.js';
import { listProjects, getProjectByPath } from '../graph/store.js';
import { searchVault, getConventions, getRecentDecisions } from '../vault/reader.js';
import { writeDecision, writeSessionHandoff, writeProjectSummary } from '../vault/writer.js';
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
      if (!existsSync(cwd)) return err(`Directory not found: ${cwd}`);

      const abs = resolve(cwd);
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
      if (!existsSync(path)) return err(`Directory not found: ${path}`);

      const result = indexProject(path);
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
      const results = searchVault(query, limit);
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
      if (!existsSync(docPath)) return err(`File not found: ${docPath}`);

      const content = readFileSync(docPath, 'utf-8');
      return ok({
        path: docPath,
        content,
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

    default:
      return err(`Unknown tool: ${name}`);
  }
}
