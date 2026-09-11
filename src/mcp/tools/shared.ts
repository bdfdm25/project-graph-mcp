/**
 * Building blocks shared by every tool definition: the contract type, the
 * description renderer, common input fragments, and the guards that turn a bad
 * call into a structured error instead of a stack trace.
 */

import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { getProjectByPath, type ProjectRow } from '../../graph/store.js';
import {
  CAPS,
  checkPath,
  prepareExternal,
  redactSecrets,
  sealExternal,
  UNTRUSTED_LIST_NOTICE,
  UNTRUSTED_NOTICE,
} from '../security.js';
import { ERROR_CODES, fail, ok, type ToolResult } from '../response.js';
import { compact, PROVENANCE_LEGEND_LINE, type Provenance } from '../provenance.js';

export { ok, fail, ERROR_CODES };
export type { ToolResult };

// ─── Contract ─────────────────────────────────────────────────────────────────

export type ZodShape = Record<string, z.ZodTypeAny>;

/** What a tool module declares. The registry derives `description` from `doc`. */
export interface RawToolDef {
  name: string;
  /** Short human label for tool pickers. */
  title: string;
  doc: ToolDoc;
  inputSchema: ZodShape;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
}

export interface ToolDef extends RawToolDef {
  description: string;
}

/**
 * Structured tool documentation.
 *
 * Every field is mandatory-by-convention except `notFor` and `notes`: a tool the
 * model cannot mis-call is a tool whose purpose, boundaries, output shape, failure
 * modes and at least one happy-path plus one edge-case example are all stated.
 */
export interface ToolDoc {
  purpose: string;
  useWhen: string;
  notFor?: string;
  returns: string;
  /** "CODE — when it fires" */
  errors?: string[];
  /** "{args} -> outcome". First is the happy path, at least one is an edge case. */
  examples?: string[];
  notes?: string[];
}

/** Examples kept in the tool description itself. The rest stay in the resource. */
const INLINE_EXAMPLES = 2;

/**
 * Keep the first example plus the first edge case, not merely the first two:
 * the edge case is what stops a confidently wrong call, so it must survive the trim
 * regardless of where it was declared.
 */
function selectInlineExamples(examples: string[]): string[] {
  const [first, ...rest] = examples;
  if (!first) return [];
  const edge = rest.find((example) => example.startsWith('edge:')) ?? rest[0];
  return edge ? [first, edge].slice(0, INLINE_EXAMPLES) : [first];
}

/**
 * Description shipped in every `tools/list`, and therefore paid for in every
 * session: purpose, boundaries, output shape, and one happy path plus one edge
 * case. Error catalogue, notes and further examples move to the `tool-examples`
 * resource, announced once in the server instructions rather than per tool.
 */
export function renderDoc(doc: ToolDoc): string {
  const lines = [
    `Purpose: ${doc.purpose}`,
    `Use when: ${doc.useWhen}${doc.notFor ? ` Not for: ${doc.notFor}` : ''}`,
    `Returns: ${doc.returns}`,
  ];
  const examples = selectInlineExamples(doc.examples ?? []);
  if (examples.length) lines.push(`Examples: ${examples.join(' | ')}`);
  return lines.join('\n');
}

/** Everything, for the resource. Nothing declared on a tool is lost — only relocated. */
export function renderDocFull(doc: ToolDoc): string {
  const lines = [
    `Purpose: ${doc.purpose}`,
    `Use when: ${doc.useWhen}${doc.notFor ? ` Not for: ${doc.notFor}` : ''}`,
    `Returns: ${doc.returns}`,
  ];
  if (doc.errors?.length) lines.push(`Errors: ${doc.errors.join('; ')}`);
  if (doc.notes?.length) lines.push(`Notes: ${doc.notes.join(' ')}`);
  if (doc.examples?.length) {
    lines.push('Examples:');
    for (const [i, example] of doc.examples.entries()) lines.push(`  ${i + 1}) ${example}`);
  }
  return lines.join('\n');
}

// ─── Common input fragments ───────────────────────────────────────────────────

/** `what` is used verbatim as the field description — keep it a short noun phrase. */
export const absolutePath = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => value.startsWith('/'), { message: 'must be an absolute path starting with "/"' })
    .describe(what);

export const queryString = z
  .string()
  .trim()
  .min(1)
  .max(CAPS.queryChars)
  .describe('Search text.');

export const limitNumber = (fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(CAPS.limit)
    .optional()
    .describe(`Max results (default: ${fallback}).`);

export const tagList = z
  .array(z.string().trim().min(1).max(64))
  .max(20)
  .optional()
  ;

export const sessionIdString = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .describe('From CLAUDE_SESSION_ID.');

export const projectTagString = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe('Project name, not a path.');

// ─── Guards ───────────────────────────────────────────────────────────────────

const PATH_HINTS: Record<string, string> = {
  not_absolute: 'Pass a full path such as /home/you/Development/my-project.',
  outside_roots: 'Add the directory to "trustedRoots" in ~/.project-graph/config.json if it should be readable.',
  sensitive: 'This class of file is never readable through this server. Open it yourself if you truly need it.',
};

/** Admit a path or produce the matching PATH_NOT_ALLOWED / NOT_FOUND failure. */
export function admitPath(
  tool: string,
  field: string,
  value: string,
): { path: string } | ToolResult {
  const check = checkPath(value);
  if (!check.allowed) {
    return fail(tool, ERROR_CODES.PATH_NOT_ALLOWED, `Path not allowed: ${value}. ${check.detail}`, {
      field,
      hint: PATH_HINTS[check.reason],
    });
  }
  return { path: check.path };
}

export function isToolResult(value: unknown): value is ToolResult {
  return typeof value === 'object' && value !== null && 'content' in value;
}

/** Resolve an indexed project or produce the NOT_INDEXED failure. */
export function requireProject(tool: string, projectPath: string): ProjectRow | ToolResult {
  const admitted = admitPath(tool, 'project_path', projectPath);
  if (isToolResult(admitted)) return admitted;

  const project = getProjectByPath(admitted.path);
  if (!project) {
    return fail(tool, ERROR_CODES.NOT_INDEXED, `Project not indexed: ${admitted.path}.`, {
      field: 'project_path',
      hint: `Call index_project with { "path": "${admitted.path}" } first.`,
      retryable: true,
    });
  }
  return project;
}

// ─── Payload shaping ──────────────────────────────────────────────────────────

export interface FittedList<T> {
  items: T[];
  truncated: boolean;
  dropped: number;
}

/**
 * Drop trailing items until the serialized list fits the payload cap.
 *
 * Truncation is reported rather than silent: a caller that sees `truncated: true`
 * knows to narrow the query instead of assuming it saw everything.
 */
export function fitPayload<T>(items: T[]): FittedList<T> {
  const kept: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > CAPS.payloadBytes) break;
    kept.push(item);
    bytes += size;
  }
  return { items: kept, truncated: kept.length < items.length, dropped: items.length - kept.length };
}

// ─── Untrusted content ────────────────────────────────────────────────────────

/**
 * Seal a field that is the whole payload (a document, one observation): the fence
 * is written out in full, because there is exactly one of it.
 */
export function sealField(
  raw: string,
  source: string,
  buildProvenance: (suspicious: boolean) => Provenance,
  truncateTo: number = CAPS.itemChars,
): { content: string; provenance: Provenance; redacted: boolean; injection_signals: string[] } {
  const sealed = sealExternal(raw, source, truncateTo);
  return {
    content: sealed.content,
    provenance: buildProvenance(sealed.injection.suspicious),
    redacted: sealed.redactions.length > 0,
    injection_signals: sealed.injection.signals,
  };
}

/**
 * Prepare one row of a list: redacted content, compact provenance, and flags only
 * when there is something to flag. The trust boundary for the whole set is declared
 * once in `meta.untrusted` instead of fencing every row.
 */
export function sealItem(
  raw: string,
  buildProvenance: (suspicious: boolean) => Provenance,
  truncateTo: number = CAPS.itemChars,
): { content: string; prov: string; why?: string; flags?: string[] } {
  const prepared = prepareExternal(raw, truncateTo);
  const flags = [
    ...(prepared.redactions.length > 0 ? ['redacted'] : []),
    ...prepared.injection.signals.map((signal) => `injection:${signal}`),
  ];
  return {
    content: prepared.text,
    ...compact(buildProvenance(prepared.injection.suspicious)),
    ...(flags.length ? { flags } : {}),
  };
}

/** Meta block for any tool returning a list of untrusted rows. */
export function untrustedListMeta(): { untrusted: string; legend: string } {
  return { untrusted: UNTRUSTED_LIST_NOTICE, legend: PROVENANCE_LEGEND_LINE };
}

/** Strip credentials from text that stays unfenced (server-authored or user configuration). */
export function redactOnly(raw: string): { text: string; redacted: boolean } {
  const { text, redactions } = redactSecrets(raw);
  return { text, redacted: redactions.length > 0 };
}

export { UNTRUSTED_NOTICE, UNTRUSTED_LIST_NOTICE, CAPS };
