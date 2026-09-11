import { describe, it, expect } from 'vitest';
import { ERROR_CODES, fail, ok, parseEnvelope } from './response.js';

describe('ok', () => {
  it('wraps data with the tool name and no isError flag', () => {
    const result = ok('list_projects', { projects: [] });
    expect(result.isError).toBeUndefined();
    expect(parseEnvelope(result)).toEqual({ ok: true, tool: 'list_projects', data: { projects: [] } });
  });

  it('includes meta only when provided', () => {
    expect(parseEnvelope(ok('search_vault', {}, { count: 0 }))).toMatchObject({ meta: { count: 0 } });
  });
});

describe('fail', () => {
  it('sets isError and a structured, defaulted error body', () => {
    const result = fail('index_project', ERROR_CODES.NOT_FOUND, 'Directory not found: /x', {
      field: 'path',
      hint: 'Check the path.',
    });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result)).toEqual({
      ok: false,
      tool: 'index_project',
      error: {
        code: 'NOT_FOUND',
        message: 'Directory not found: /x',
        field: 'path',
        hint: 'Check the path.',
        retryable: false,
      },
    });
  });

  it('carries retryable and details through', () => {
    const envelope = parseEnvelope(
      fail('summarize_project_doc', ERROR_CODES.TOO_LARGE, 'File too large: 2000 KB.', {
        retryable: false,
        details: { bytes: 2_048_000, max_bytes: 512_000 },
      }),
    ) as { error: Record<string, unknown> };
    expect(envelope.error.details).toEqual({ bytes: 2_048_000, max_bytes: 512_000 });
  });
});
