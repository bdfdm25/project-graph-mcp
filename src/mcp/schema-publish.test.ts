import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { publishedInputSchema } from './schema-publish.js';

describe('publishedInputSchema', () => {
  const schema = publishedInputSchema({
    query: z.string().trim().min(1).max(512).describe('Search text.'),
    limit: z.number().int().min(1).max(100).optional(),
    body: z.string().max(100_000).optional(),
    context: z.object({ file: z.string().max(500).optional(), line: z.number().int().min(0).optional() }).optional(),
    tags: z.array(z.string().max(64)).max(20).optional(),
  });
  const json = JSON.stringify(schema);

  it('keeps what changes how a call is written', () => {
    expect(schema).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string', description: 'Search text.' } },
      required: ['query'],
    });
    expect((schema.properties as Record<string, Record<string, unknown>>).limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 100,
    });
  });

  it('strips machine noise that no caller reads', () => {
    expect(json).not.toContain('$schema');
    expect(json).not.toContain('additionalProperties');
    expect(json).not.toContain('minLength');
    expect(json).not.toContain('maxLength');
    expect(json).not.toContain('maxItems');
  });

  it('strips zod integer ceilings but keeps real numeric bounds', () => {
    expect(json).not.toContain('9007199254740991');
    expect(json).toContain('"minimum":0');
  });

  it('prunes nested object schemas too', () => {
    const context = (schema.properties as Record<string, Record<string, unknown>>).context;
    expect(JSON.stringify(context)).not.toContain('maxLength');
    expect(JSON.stringify(context)).toContain('"file"');
  });
});
