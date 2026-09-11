import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../config.js', () => ({
  config: {
    vault: '/tmp/pgmcp-server-test-vault',
    trustedRoots: ['/tmp'],
    grammars: [{ name: 'typescript', extensions: ['.ts'] }],
    ignore: [],
    db: '/tmp/pgmcp-server-test.db',
    watchDebounce: 300,
  },
}));

vi.mock('../graph/store.js', () => ({
  listProjects: vi.fn(() => [{ id: 'p1', root_path: '/tmp/proj', name: 'proj', last_indexed_at: 1 }]),
  getProjectByPath: vi.fn(),
  getFilesForProject: vi.fn(() => []),
  upsertSession: vi.fn(),
  closeSession: vi.fn(),
  insertObservation: vi.fn(),
  searchObservations: vi.fn(() => []),
  getSessionTimeline: vi.fn(() => []),
  getObservation: vi.fn(),
  listSessions: vi.fn(() => []),
  searchNodes: vi.fn(() => []),
  promoteObservation: vi.fn(),
}));

vi.mock('../graph/builder.js', () => ({ indexProject: vi.fn() }));
vi.mock('../graph/watcher.js', () => ({ getActiveWatcherInfo: vi.fn(() => null) }));
vi.mock('../vault/reader.js', () => ({
  searchVault: vi.fn(() => []),
  getConventions: vi.fn(() => null),
  getRecentDecisions: vi.fn(() => []),
}));

const { createServer, SERVER_INSTRUCTIONS } = await import('./create-server.js');

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
});

describe('server wiring', () => {
  it('advertises the trust model in its instructions', () => {
    expect(SERVER_INSTRUCTIONS).toContain('<external-content>');
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it('publishes JSON Schema and annotations for every tool', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(20);

    const searchVaultTool = tools.find((tool) => tool.name === 'search_vault')!;
    expect(searchVaultTool.inputSchema).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
    expect(searchVaultTool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(searchVaultTool.description).toContain('Purpose:');
  });

  it('publishes usable caps and no schema boilerplate', async () => {
    const { tools } = await client.listTools();
    const searchVault = tools.find((tool) => tool.name === 'search_vault')!;
    const limit = (searchVault.inputSchema.properties as Record<string, { maximum?: number }>).limit;
    expect(limit?.maximum).toBe(100);

    const published = JSON.stringify(tools);
    expect(published).not.toContain('$schema');
    expect(published).not.toContain('additionalProperties');
  });

  it('announces the strictness and the resources once, in the instructions', () => {
    expect(SERVER_INSTRUCTIONS).toContain('Unknown argument names are rejected');
    expect(SERVER_INSTRUCTIONS).toContain('tool-examples');
  });

  it('serves a successful call through the envelope', async () => {
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(result.isError).toBeFalsy();
    const envelope = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(envelope).toMatchObject({ ok: true, tool: 'list_projects' });
  });

  it('marks a tool failure with isError so the client can branch on it', async () => {
    const result = await client.callTool({ name: 'index_project', arguments: { path: '/etc' } });
    expect(result.isError).toBe(true);
    const envelope = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(envelope.error.code).toBe('PATH_NOT_ALLOWED');
  });

  it('reports a schema violation as an INVALID_INPUT envelope, not a protocol error', async () => {
    const result = await client.callTool({
      name: 'write_observation',
      arguments: { session_id: 's1', type: 'thought', content: 'not a valid type' },
    });
    expect(result.isError).toBe(true);
    const envelope = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', field: 'type' } });
  });

  it('exposes the provenance guide and example catalog as resources', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.name).sort()).toEqual(['provenance-and-trust', 'tool-examples']);

    const guide = await client.readResource({ uri: 'project-graph://docs/provenance' });
    expect((guide.contents[0] as { text: string }).text).toContain('## Confidence');

    const examples = await client.readResource({ uri: 'project-graph://docs/examples' });
    expect((examples.contents[0] as { text: string }).text).toContain('### search_vault');
  });
});
