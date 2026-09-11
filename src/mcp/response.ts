/**
 * Uniform tool response envelope.
 *
 * Every tool returns a single JSON text block with the same top-level shape, so
 * a caller (model or script) can branch on `ok` without knowing the tool.
 *
 *   success: { ok: true,  tool, data, meta? }
 *   failure: { ok: false, tool, error: { code, message, field?, hint?, retryable } }
 *
 * Failures also set `isError: true` on the MCP result, per the MCP spec, so the
 * client can distinguish a tool-level failure from a protocol failure.
 *
 * Payloads are serialized without indentation: every response is read by a model,
 * and pretty-printing costs 18-38% more tokens for whitespace nobody reads.
 */

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** Stable, machine-branchable error codes. Never remove a code; add new ones. */
export const ERROR_CODES = {
  /** Argument missing, wrong type, or outside allowed bounds. */
  INVALID_INPUT: 'INVALID_INPUT',
  /** Path is outside the configured trusted roots, or hits the sensitive-path deny list. */
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  /** Path/record does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** Project exists on disk but has no graph yet — run index_project. */
  NOT_INDEXED: 'NOT_INDEXED',
  /** Input or target exceeds a hard size cap. */
  TOO_LARGE: 'TOO_LARGE',
  /** Query was valid but matched nothing, and the caller needs a match to proceed. */
  NO_MATCH: 'NO_MATCH',
  /** Tool name is not registered. */
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  /** Unexpected failure inside the server. */
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorOptions {
  /** Argument the error is about, when it is about one. */
  field?: string;
  /** Concrete next action for the caller. Always actionable, never restating the message. */
  hint?: string;
  /** True when the same call may succeed later (e.g. after indexing). */
  retryable?: boolean;
  /** Extra machine-readable context (limits, candidates, counts). */
  details?: Record<string, unknown>;
}

export interface SuccessMeta {
  [key: string]: unknown;
}

function render(payload: unknown, isError: boolean): ToolResult {
  const result: ToolResult = {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
  if (isError) result.isError = true;
  return result;
}

export function ok(tool: string, data: unknown, meta?: SuccessMeta): ToolResult {
  return render(meta ? { ok: true, tool, data, meta } : { ok: true, tool, data }, false);
}

export function fail(
  tool: string,
  code: ErrorCode,
  message: string,
  options: ErrorOptions = {},
): ToolResult {
  return render(
    {
      ok: false,
      tool,
      error: {
        code,
        message,
        ...(options.field ? { field: options.field } : {}),
        ...(options.hint ? { hint: options.hint } : {}),
        retryable: options.retryable ?? false,
        ...(options.details ? { details: options.details } : {}),
      },
    },
    true,
  );
}

/** Parse a rendered envelope back into an object. Used by tests and by the server layer. */
export function parseEnvelope(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}
