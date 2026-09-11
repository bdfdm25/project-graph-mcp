/**
 * MCP server entry point: sync the most recent project, then serve over stdio.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './create-server.js';
import { getRecentProjects } from '../graph/store.js';
import { indexProject } from '../graph/builder.js';

// ─── On startup: sync the most recently used project only ────────────────────
// Each session is a separate process sharing the same SQLite DB.
// Syncing all projects on every boot causes write contention in multi-session use.
// Syncing only the most recent project is safe and covers the common case.

function bootSync(): void {
  const project = getRecentProjects(1)[0];
  if (!project) return;
  try {
    indexProject(project.root_path);
  } catch {
    // project directory may no longer exist — skip silently
  }
}

bootSync();

const transport = new StdioServerTransport();
await createServer().connect(transport);
