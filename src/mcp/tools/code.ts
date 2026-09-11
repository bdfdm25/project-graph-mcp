/**
 * Code-graph tools: indexing a repository and answering structural questions
 * (imports, blast radius, architectural clusters) from the stored graph.
 *
 * Every answer here is derived by this server from parsed source, so it is
 * `trusted` provenance — the only risk is staleness, which is reported.
 */

import { z } from 'zod';
import { existsSync, statSync } from 'fs';
import { indexProject } from '../../graph/builder.js';
import { getDependencies, getBlastRadius } from '../../graph/algorithms.js';
import { getFilesForProject, getProjectByPath, listProjects, searchNodes } from '../../graph/store.js';
import { getModuleContext, findSimilarFiles } from '../../graph/communities.js';
import { getActiveWatcherInfo } from '../../graph/watcher.js';
import { searchVault } from '../../vault/reader.js';
import { codeGraphProvenance, vaultProvenance } from '../provenance.js';
import { config } from '../../config.js';
import {
  ERROR_CODES,
  absolutePath,
  admitPath,
  fail,
  fitPayload,
  isToolResult,
  limitNumber,
  ok,
  queryString,
  requireProject,
  sealItem,
  untrustedListMeta,
  type RawToolDef,
  UNTRUSTED_NOTICE,
} from './shared.js';

/** Count indexed files whose on-disk mtime is newer than the stored one. */
function countStaleFiles(projectId: string): number {
  let stale = 0;
  for (const row of getFilesForProject(projectId)) {
    try {
      if (statSync(row.path).mtimeMs > row.mtime) stale++;
    } catch {
      stale++; // deleted since indexing — the graph still mentions it
    }
  }
  return stale;
}

const projectPathInput = absolutePath('Project root, as passed to index_project.');
const fileInput = absolutePath('File to analyze.');

export const codeTools: RawToolDef[] = [
  {
    name: 'get_active_project',
    title: 'Active project',
    doc: {
      purpose: 'Report whether a working directory maps to an indexed project.',
      useWhen: 'At session start, before any graph question.',
      notFor: 'Reading code — status only.',
      returns: '{ cwd, vault, grammars[], indexed, last_indexed_at, next_step }.',
      errors: [
        'PATH_NOT_ALLOWED — cwd is relative, sensitive, or outside trustedRoots',
        'NOT_FOUND — directory does not exist',
      ],
      examples: [
        '{"cwd":"/repo"} -> indexed:true, next_step:"Graph is ready."',
        'edge: {"cwd":"/etc"} -> ok:false, PATH_NOT_ALLOWED (outside trustedRoots)',
      ],
        },
    inputSchema: { cwd: projectPathInput.describe('Current working directory.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (args) => {
      const admitted = admitPath('get_active_project', 'cwd', args.cwd as string);
      if (isToolResult(admitted)) return admitted;
      if (!existsSync(admitted.path)) {
        return fail('get_active_project', ERROR_CODES.NOT_FOUND, `Directory not found: ${admitted.path}`, {
          field: 'cwd',
          hint: 'Check the path exists before calling again.',
        });
      }

      const project = getProjectByPath(admitted.path);
      return ok('get_active_project', {
        cwd: admitted.path,
        vault: config.vault,
        grammars: config.grammars.map((g) => g.name),
        indexed: project !== undefined,
        last_indexed_at: project?.last_indexed_at ?? null,
        next_step: project
          ? 'Graph is ready. Use get_dependencies, get_blast_radius or get_module_context.'
          : 'Not indexed. Call index_project with this path to build the graph.',
      });
    },
  },

  {
    name: 'list_projects',
    title: 'List indexed projects',
    doc: {
      purpose: 'List indexed projects, newest index first.',
      useWhen: 'You need a project root path and do not know it.',
      returns: '{ projects: [{ id, root_path, name, last_indexed_at }] }.',
      examples: ['{} -> 3 projects, newest first (empty list when nothing is indexed — still ok:true)'],
        },
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: () => {
      const projects = listProjects();
      return ok('list_projects', { projects }, { count: projects.length });
    },
  },

  {
    name: 'index_project',
    title: 'Index project',
    doc: {
      purpose: 'Parse a repo into the dependency graph (TS/JS/Python) and watch it.',
      useWhen: 'Before the first graph query on a project, or after a large branch switch.',
      notFor: 'Routine re-runs — the watcher picks up file changes.',
      returns: '{ projectId, name, rootPath, filesIndexed, filesRepaired, filesSkipped, nodesCreated, edgesCreated, clusters }.',
      errors: [
        'PATH_NOT_ALLOWED — path is relative, sensitive, or outside trustedRoots',
        'NOT_FOUND — directory does not exist',
        'INTERNAL — parser or database failure (message carries the cause)',
      ],
      notes: [
        'filesSkipped counts unchanged files, so a re-index of an untouched repo reports 0 indexed and is not an error.',
        'filesRepaired counts unchanged files re-parsed because their stored imports pointed at files that no longer exist.',
      ],
      examples: [
        '{"path":"/repo"} -> filesIndexed:214, nodesCreated:1802, clusters:7',
        'edge: re-run immediately -> filesIndexed:0, filesSkipped:214 (incremental no-op, still ok:true)',
      ],
        },
    inputSchema: { path: projectPathInput },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: (args) => {
      const admitted = admitPath('index_project', 'path', args.path as string);
      if (isToolResult(admitted)) return admitted;
      if (!existsSync(admitted.path)) {
        return fail('index_project', ERROR_CODES.NOT_FOUND, `Directory not found: ${admitted.path}`, {
          field: 'path',
          hint: 'Check the path exists before calling again.',
        });
      }
      return ok('index_project', indexProject(admitted.path));
    },
  },

  {
    name: 'get_dependencies',
    title: 'File dependencies',
    doc: {
      purpose: 'List what a file imports, directly and transitively.',
      useWhen: 'Deciding what a change to this file can reach.',
      notFor: 'Reverse direction — use get_blast_radius for "who depends on me".',
      returns: '{ file, direct[], transitive[], provenance (index freshness) }.',
      errors: [
        'NOT_INDEXED — project has no graph yet; call index_project',
        'PATH_NOT_ALLOWED — a path is relative, sensitive, or outside trustedRoots',
      ],
      examples: [
        '{"project_path":"/repo","file":"/repo/src/api.ts"} -> direct:["./db","zod"], transitive:["./db/pool"]',
        'edge: a file with no imports -> direct:[], transitive:[] and confidence "medium" when the index is stale',
      ],
        },
    inputSchema: { project_path: projectPathInput, file: fileInput },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (args) => {
      const project = requireProject('get_dependencies', args.project_path as string);
      if (isToolResult(project)) return project;
      const admittedFile = admitPath('get_dependencies', 'file', args.file as string);
      if (isToolResult(admittedFile)) return admittedFile;

      const result = getDependencies(project.id, admittedFile.path);
      return ok('get_dependencies', {
        ...result,
        provenance: codeGraphProvenance(project.root_path, project.last_indexed_at, countStaleFiles(project.id)),
      });
    },
  },

  {
    name: 'get_blast_radius',
    title: 'Blast radius',
    doc: {
      purpose: 'List every file that depends on the given file, directly or transitively — "what breaks if I change this?".',
      useWhen: 'Before editing a shared module, or when scoping a refactor and its tests.',
      notFor: 'Forward imports — use get_dependencies.',
      returns: '{ file, affected[], provenance (index freshness) }.',
      errors: [
        'NOT_INDEXED — project has no graph yet; call index_project',
        'PATH_NOT_ALLOWED — a path is relative, sensitive, or outside trustedRoots',
      ],
      examples: [
        '{"project_path":"/repo","file":"/repo/src/db.ts"} -> affected: 12 files',
        'edge: a leaf file nobody imports -> affected:[] (ok:true; an empty radius is an answer, not a failure)',
      ],
        },
    inputSchema: { project_path: projectPathInput, file: fileInput },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (args) => {
      const project = requireProject('get_blast_radius', args.project_path as string);
      if (isToolResult(project)) return project;
      const admittedFile = admitPath('get_blast_radius', 'file', args.file as string);
      if (isToolResult(admittedFile)) return admittedFile;

      const result = getBlastRadius(project.id, admittedFile.path);
      return ok('get_blast_radius', {
        ...result,
        provenance: codeGraphProvenance(project.root_path, project.last_indexed_at, countStaleFiles(project.id)),
      });
    },
  },

  {
    name: 'get_module_context',
    title: 'Module cluster',
    doc: {
      purpose: 'Show the Louvain cluster a file belongs to, and its other members.',
      useWhen: 'Orienting in unfamiliar code, or checking a new file sits in the right layer.',
      returns: '{ file, cluster_id, cluster_name, related_files[] }.',
      errors: ['NOT_INDEXED — call index_project first', 'PATH_NOT_ALLOWED — path outside trustedRoots'],
      examples: [
        '{"project_path":"/repo","file":"/repo/src/orders/create.ts"} -> cluster_name:"src/orders", 6 related files',
        'edge: a file with no edges -> cluster_id:null, cluster_name:"unassigned", related_files:[]',
      ],
        },
    inputSchema: { project_path: projectPathInput, file: absolutePath('File to inspect.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (args) => {
      const project = requireProject('get_module_context', args.project_path as string);
      if (isToolResult(project)) return project;
      const admittedFile = admitPath('get_module_context', 'file', args.file as string);
      if (isToolResult(admittedFile)) return admittedFile;

      const context = getModuleContext(project.id, project.root_path, admittedFile.path);
      return ok('get_module_context', {
        ...context,
        provenance: codeGraphProvenance(project.root_path, project.last_indexed_at, countStaleFiles(project.id)),
      });
    },
  },

  {
    name: 'find_similar_code',
    title: 'Find similar code',
    doc: {
      purpose: 'Rank files similar to this one by shared cluster and overlapping symbols.',
      useWhen: 'Finding the existing pattern to copy before writing a similar module.',
      notFor: 'Line-level duplicate detection — similarity is structural, not textual.',
      returns: '{ file, similar: [{ file, score, shared_symbols[], same_cluster }] }.',
      errors: ['NOT_INDEXED — call index_project first', 'PATH_NOT_ALLOWED — path outside trustedRoots'],
      examples: [
        '{"project_path":"/repo","file":"/repo/src/orders/create.ts","limit":5} -> 5 ranked siblings',
        'edge: a file whose symbols are unique -> similar:[] (ok:true, nothing comparable indexed)',
      ],
        },
    inputSchema: {
      project_path: projectPathInput,
      file: absolutePath('Reference file.'),
      limit: limitNumber(10),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (args) => {
      const project = requireProject('find_similar_code', args.project_path as string);
      if (isToolResult(project)) return project;
      const admittedFile = admitPath('find_similar_code', 'file', args.file as string);
      if (isToolResult(admittedFile)) return admittedFile;

      const limit = (args.limit as number | undefined) ?? 10;
      const similar = findSimilarFiles(project.id, admittedFile.path, limit);
      return ok(
        'find_similar_code',
        {
          file: admittedFile.path,
          similar,
          provenance: codeGraphProvenance(project.root_path, project.last_indexed_at, countStaleFiles(project.id)),
        },
        { count: similar.length },
      );
    },
  },

  {
    name: 'get_watcher_status',
    title: 'Watcher status',
    doc: {
      purpose: 'Report which project the watcher is keeping live, if any.',
      useWhen: 'Graph answers look stale and you need to know if updates land.',
      returns: '{ watching: false } or { projectId, root }.',
      examples: ['{} -> {"projectId":"a1b2","root":"/repo"} | edge: no watcher -> {"watching":false}'],
        },
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: () => ok('get_watcher_status', getActiveWatcherInfo() ?? { watching: false }),
  },

  {
    name: 'search_knowledge',
    title: 'Search code + vault',
    doc: {
      purpose: 'One query across both stores: code symbols and vault notes.',
      useWhen: 'You do not know whether the answer lives in code or in notes.',
      notFor: 'Episodic session memory — that is search_observations.',
      returns: '{ query, code[], vault[] }; vault rows carry content + prov, meta declares the trust boundary.',
      errors: ['INVALID_INPUT — empty query or limit outside 1-100'],
      notes: [UNTRUSTED_NOTICE],
      examples: [
        '{"query":"rate limit","limit":5} -> code: 2 symbols, vault: 3 notes with confidence bands',
        'edge: {"query":"qqqq"} -> code:[], vault:[], total:0 (ok:true — no match is not an error)',
      ],
        },
    inputSchema: {
      query: queryString,
      project_path: absolutePath('Project root; scopes code results.').optional(),
      limit: limitNumber(6),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (args) => {
      const query = args.query as string;
      const limit = (args.limit as number | undefined) ?? 6;

      let projectId: string | undefined;
      let projectProvenance: ReturnType<typeof codeGraphProvenance> | undefined;
      if (args.project_path) {
        const admitted = admitPath('search_knowledge', 'project_path', args.project_path as string);
        if (isToolResult(admitted)) return admitted;
        const project = getProjectByPath(admitted.path);
        projectId = project?.id;
        if (project) {
          projectProvenance = codeGraphProvenance(project.root_path, project.last_indexed_at, countStaleFiles(project.id));
        }
      }

      const code = searchNodes(query, projectId, limit).map((row) => ({
        source: 'code' as const,
        symbol: row.symbol,
        type: row.type,
        path: row.path,
        file: row.source_file,
        rank: row.rank,
      }));

      const vault = searchVault(query, limit).map((row) => ({
        source: 'vault' as const,
        title: row.title,
        path: row.path,
        tags: row.tags,
        ...sealItem(row.snippet, (suspicious) =>
          vaultProvenance(row.path, row.score, { mtime: row.mtime, suspicious }),
        ),
      }));

      const fitted = fitPayload([...code, ...vault]);
      return ok(
        'search_knowledge',
        {
          query,
          code: fitted.items.filter((item) => item.source === 'code'),
          vault: fitted.items.filter((item) => item.source === 'vault'),
          ...(projectProvenance ? { code_provenance: projectProvenance } : {}),
        },
        {
          total: fitted.items.length,
          ...(fitted.truncated ? { truncated: true, dropped: fitted.dropped } : {}),
          ...untrustedListMeta(),
        },
      );
    },
  },
];
