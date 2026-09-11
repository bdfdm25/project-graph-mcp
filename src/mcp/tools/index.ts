/**
 * Tool registry and dispatcher.
 *
 * Every call goes through the same three steps: resolve the tool, validate the
 * arguments against its zod schema, run the handler inside a failure boundary.
 * No handler ever sees an unvalidated argument, and no exception ever escapes as
 * a protocol error when it can be reported as a structured tool failure.
 */

import { z } from 'zod';
import { ERROR_CODES, fail, type ToolResult } from '../response.js';
import { renderDoc, type RawToolDef, type ToolDef } from './shared.js';
import { codeTools } from './code.js';
import { vaultTools } from './vault.js';
import { memoryTools } from './memory.js';

export type { ToolDef, RawToolDef };

const RAW_DEFS: RawToolDef[] = [...codeTools, ...vaultTools, ...memoryTools];

/** Descriptions are derived once, so the inline/full split cannot drift per tool. */
export const TOOL_DEFS: ToolDef[] = RAW_DEFS.map((def) => ({ ...def, description: renderDoc(def.doc) }));

const BY_NAME = new Map(TOOL_DEFS.map((def) => [def.name, def]));

export function getToolDef(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

function formatIssue(issue: z.core.$ZodIssue): { field?: string; message: string } {
  const field = issue.path.map(String).join('.');
  return { ...(field ? { field } : {}), message: field ? `${field}: ${issue.message}` : issue.message };
}

/**
 * Strict parsing is deliberate: an unexpected key is almost always a wrong argument
 * name, and silently dropping it produces a confident answer to the wrong call.
 */
export function validateArgs(
  def: ToolDef,
  args: Record<string, unknown>,
): { data: Record<string, unknown> } | ToolResult {
  const parsed = z.strictObject(def.inputSchema).safeParse(args);
  if (parsed.success) return { data: parsed.data as Record<string, unknown> };

  const issue = parsed.error.issues[0]!;
  const { field, message } = formatIssue(issue);
  return fail(def.name, ERROR_CODES.INVALID_INPUT, message, {
    ...(field ? { field } : {}),
    hint: `Accepted arguments: ${Object.keys(def.inputSchema).join(', ') || '(none)'}.`,
    details: { issues: parsed.error.issues.map((i) => formatIssue(i).message) },
  });
}

export async function handleTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const def = BY_NAME.get(name);
  if (!def) {
    return fail(name, ERROR_CODES.UNKNOWN_TOOL, `Unknown tool: ${name}`, {
      hint: `Available tools: ${[...BY_NAME.keys()].join(', ')}.`,
    });
  }

  const validated = validateArgs(def, args);
  if ('content' in validated) return validated;

  try {
    return await def.handler(validated.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(def.name, ERROR_CODES.INTERNAL, `${def.name} failed: ${message}`, {
      hint: 'This is a server-side failure, not a bad argument. Retry once; if it persists, check the server logs.',
      retryable: true,
    });
  }
}
