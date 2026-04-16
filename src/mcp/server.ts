import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, handleTool } from './tools.js';
import { getRecentProjects } from '../graph/store.js';
import { indexProject } from '../graph/builder.js';

// ─── On startup: sync the most recently used project only ────────────────────
// Each session is a separate process sharing the same SQLite DB.
// Syncing all projects on every boot causes write contention in multi-session use.
// Syncing only the most recent project is safe and covers the common case.

function bootSync(): void {
  const projects = getRecentProjects(1);
  const project = projects[0];
  if (!project) return;
  try {
    indexProject(project.root_path);
  } catch {
    // project directory may no longer exist — skip silently
  }
}

bootSync();

const server = new Server(
  { name: 'project-graph', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  return handleTool(name, args as Record<string, unknown>);
});

const transport = new StdioServerTransport();
await server.connect(transport);
