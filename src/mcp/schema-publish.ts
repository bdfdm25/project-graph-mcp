/**
 * Turns a tool's zod schema into the JSON Schema published in `tools/list`.
 *
 * The published schema is read by a model in every session, so it carries only
 * what changes how a call is written — types, enums, required fields, and caps a
 * caller could realistically hit. Stripped: the SDK's `$schema` URL, zod's integer
 * ceiling, string and array length bounds (never load-bearing when writing a call,
 * and quoted back in the INVALID_INPUT message if one is ever hit), and the
 * `additionalProperties` flag the server instructions already state once.
 *
 * Validation is unaffected — the zod schema still enforces every rule.
 */

import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

function prune(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(prune);
  if (typeof node !== 'object' || node === null) return node;

  const schema = { ...(node as JsonSchema) };
  delete schema['$schema'];
  delete schema['additionalProperties'];
  delete schema['minLength'];
  delete schema['maxLength'];
  delete schema['minItems'];
  delete schema['maxItems'];

  if (typeof schema['maximum'] === 'number' && schema['maximum'] >= Number.MAX_SAFE_INTEGER) {
    delete schema['maximum'];
  }

  for (const [key, value] of Object.entries(schema)) {
    if (typeof value === 'object' && value !== null) schema[key] = prune(value);
  }
  return schema;
}

export function publishedInputSchema(shape: Record<string, z.ZodTypeAny>): JsonSchema {
  return prune(z.toJSONSchema(z.strictObject(shape))) as JsonSchema;
}
