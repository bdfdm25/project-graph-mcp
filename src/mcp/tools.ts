import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config.js';

// ─── Tool definitions ────────────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    name: 'get_active_project',
    description:
      'Returns the active project based on the provided working directory. ' +
      'Pass the absolute path of the current working directory. ' +
      'In Phase 1 this returns project metadata only — graph indexing is available from Phase 2.',
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
    description: 'Lists all indexed projects. In Phase 1, returns an empty list — indexing is available from Phase 2.',
    inputSchema: {
      type: 'object',
      properties: {},
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

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'get_active_project': {
      const cwd = String(args.cwd ?? '').trim();
      if (!cwd) return err('cwd is required');
      if (!existsSync(cwd)) return err(`Directory not found: ${cwd}`);

      return ok({
        cwd: resolve(cwd),
        vault: config.vault,
        grammars: config.grammars.map((g) => g.name),
        phase: 1,
        note: 'Graph not yet indexed. index_project() available in Phase 2.',
      });
    }

    case 'list_projects': {
      return ok({
        projects: [],
        phase: 1,
        note: 'Project indexing available in Phase 2.',
      });
    }

    default:
      return err(`Unknown tool: ${name}`);
  }
}
