/**
 * Episodic memory tools: the SQLite observation store and the sessions around it.
 *
 * Stored observations are text written by earlier sessions, so reads are sealed
 * and carry a confidence band derived from origin, type and age.
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  closeSession,
  countSessionObservations,
  getObservation,
  getSessionTimeline,
  insertObservation,
  listSessions,
  promoteObservation,
  searchObservations,
  upsertSession,
  type ObservationRow,
  type ObservationType,
} from '../../graph/store.js';
import { graduateObservations } from '../../vault/writer.js';
import { config } from '../../config.js';
import { observationProvenance } from '../provenance.js';
import {
  ERROR_CODES,
  fail,
  fitPayload,
  limitNumber,
  ok,
  projectTagString,
  queryString,
  sealItem,
  untrustedListMeta,
  sessionIdString,
  tagList,
  type RawToolDef,
  UNTRUSTED_NOTICE,
} from './shared.js';

const OBSERVATION_TYPES = ['decision', 'discovery', 'error', 'code-change', 'note', 'pattern'] as const;
const ORIGINS = ['agent', 'user', 'hook'] as const;

/** Hook-written context fields that tell a reader nothing and cost tokens on every row. */
const NOISE_CONTEXT_KEYS = new Set(['duration_ms']);

function presentContext(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const parsed = parseJsonColumn<Record<string, unknown>>(raw, {});
  const kept = Object.entries(parsed).filter(([key]) => !NOISE_CONTEXT_KEYS.has(key));
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/** Stored JSON columns are written by hooks too; a malformed one must not sink the whole result. */
function parseJsonColumn<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Shape one stored row for return.
 *
 * Fields a caller can re-derive are left out: `rank` (rows already arrive ordered
 * by it) and `promoted`. `session_id` is dropped when the whole result set belongs
 * to one session, and empty columns are omitted rather than serialized as null.
 */
function presentObservation(row: ObservationRow, options: { withSession?: boolean } = {}) {
  const context = presentContext(row.context);
  return {
    id: row.id,
    ...(options.withSession === false ? {} : { session_id: row.session_id }),
    ...(row.project_tag ? { project_tag: row.project_tag } : {}),
    type: row.type,
    ...(row.tags ? { tags: parseJsonColumn<string[]>(row.tags, []) } : {}),
    ...(context ? { context } : {}),
    created_at: row.created_at,
    ...sealItem(row.content, (suspicious) => observationProvenance(row, suspicious)),
  };
}

export const memoryTools: RawToolDef[] = [
  {
    name: 'write_observation',
    title: 'Write observation',
    doc: {
      purpose: 'Record one durable fact from this session into episodic memory.',
      useWhen: 'A decision, a non-obvious discovery, a diagnosed error, or a reusable pattern.',
      notFor: 'Routine edits — hooks capture those already, and they dilute search.',
      returns: '{ id, session_id, type, origin, project_tag }.',
      errors: [
        'INVALID_INPUT — missing session_id/content, type outside the enum, or content over 2000 chars',
      ],
      notes: [
        'origin defaults to "agent". Pass "user" only when repeating something the human stated; provenance ranks user statements highest.',
        'One fact per call. Content is one sentence, self-contained enough to make sense with no session context.',
      ],
      examples: [
        '{"session_id":"8e20…","type":"discovery","content":"Prisma getter on a PrismaClient subclass returns a Proxy without models; use the injected instance.","project_tag":"expense-tracker","tags":["prisma"]} -> id:"obs_1789…"',
        '{"session_id":"8e20…","type":"decision","content":"Chose SQLite over Postgres for episodic memory: single-user, zero ops.","project_tag":"project-graph-mcp","origin":"user"} -> stored with confidence "high"',
        'edge: {"session_id":"8e20…","type":"thought","content":"hm"} -> ok:false, INVALID_INPUT listing the six valid types',
      ],
        },
    inputSchema: {
      session_id: sessionIdString,
      type: z.enum(OBSERVATION_TYPES),
      content: z.string().trim().min(5).max(2_000).describe('One self-contained sentence.'),
      project_tag: projectTagString.optional(),
      context: z
        .object({
          file: z.string().max(500).optional(),
          line: z.number().int().min(0).optional(),
          tool: z.string().max(100).optional(),
          symbol: z.string().max(200).optional(),
          url: z.string().max(500).optional(),
        })
        .optional()
        .describe('Anchor: file/line/tool/symbol/url.'),
      tags: tagList,
      origin: z.enum(ORIGINS).optional().describe('Default: agent. Sets the confidence band.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: (args) => {
      const sessionId = args.session_id as string;
      const projectTag = (args.project_tag as string | undefined) ?? null;
      const origin = (args.origin as (typeof ORIGINS)[number] | undefined) ?? 'agent';

      upsertSession(sessionId, projectTag, null);

      const id = `obs_${Date.now()}_${randomUUID().slice(0, 6)}`;
      insertObservation({
        id,
        session_id: sessionId,
        project_tag: projectTag,
        type: args.type as ObservationType,
        content: args.content as string,
        context: args.context as Record<string, unknown> | undefined,
        tags: args.tags as string[] | undefined,
        origin,
      });

      return ok('write_observation', {
        id,
        session_id: sessionId,
        type: args.type,
        origin,
        project_tag: projectTag,
      });
    },
  },

  {
    name: 'search_observations',
    title: 'Search observations',
    doc: {
      purpose: 'Full-text search across episodic memory from every past session.',
      useWhen: 'At session start, and whenever the current task may have been touched before.',
      notFor: 'Authored notes — that is search_vault.',
      returns: '{ query, results: [{ id, session_id, type, content, prov, why?, flags?, context?, created_at }] }.',
      errors: ['INVALID_INPUT — empty query or limit outside 1-100'],
      notes: [
        UNTRUSTED_NOTICE,
        'Terms are OR-ed with prefix matching, so more words widen the search rather than narrowing it; 2-3 keywords works best.',
        'Rank hook-origin rows (confidence "low") below agent-written decisions and discoveries.',
      ],
      examples: [
        '{"query":"prisma proxy","project_tag":"expense-tracker","limit":5} -> 3 hits, top one an agent-written discovery (confidence "high")',
        'edge: {"query":"zzz"} -> results:[], count:0 (ok:true — absence of memory is a valid answer)',
      ],
        },
    inputSchema: { query: queryString, project_tag: projectTagString.optional(), limit: limitNumber(8) },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (args) => {
      const query = args.query as string;
      const results = searchObservations(
        query,
        args.project_tag as string | undefined,
        (args.limit as number | undefined) ?? 8,
      ).map((row) => presentObservation(row));

      const fitted = fitPayload(results);
      return ok(
        'search_observations',
        { query, results: fitted.items },
        { count: fitted.items.length, ...(fitted.truncated ? { truncated: true, dropped: fitted.dropped } : {}), ...untrustedListMeta() },
      );
    },
  },

  {
    name: 'get_session_timeline',
    title: 'Session timeline',
    doc: {
      purpose: 'Read one session\'s observations in order.',
      useWhen: 'Reconstructing what a specific past session did.',
      notFor: 'Cross-session recall — use search_observations.',
      returns: '{ session_id, observations[] (content + prov) }; meta carries total and whether more remain.',
      errors: ['INVALID_INPUT — missing session_id, or limit outside 1-100'],
      notes: [
        'Sessions can hold hundreds of rows. Default is the first 50; order:"desc" reads the end of a long session instead.',
      ],
      examples: [
        '{"session_id":"2e575cae-…"} -> 50 of 547 observations, meta.total:547, meta.truncated:true',
        'edge: an unknown session id -> observations:[], total:0 (ok:true, not NOT_FOUND: a session may have no observations)',
        '{"session_id":"2e575cae-…","order":"desc","limit":10} -> the last 10 things that happened',
      ],
    },
    inputSchema: {
      session_id: sessionIdString,
      limit: limitNumber(50),
      order: z.enum(['asc', 'desc']).optional().describe('asc (default) oldest first; desc reads the tail.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (args) => {
      const sessionId = args.session_id as string;
      const limit = (args.limit as number | undefined) ?? 50;
      const order = (args.order as 'asc' | 'desc' | undefined) ?? 'asc';
      const total = countSessionObservations(sessionId);
      const observations = getSessionTimeline(sessionId, limit, order).map((row) =>
        presentObservation(row, { withSession: false }),
      );
      const fitted = fitPayload(observations);
      return ok(
        'get_session_timeline',
        { session_id: sessionId, observations: fitted.items },
        {
          count: fitted.items.length,
          total,
          ...(total > fitted.items.length ? { truncated: true } : {}),
          ...untrustedListMeta(),
        },
      );
    },
  },

  {
    name: 'get_observation',
    title: 'Get observation',
    doc: {
      purpose: 'Fetch one observation by id, with full context and provenance.',
      useWhen: 'A search result looked relevant and you need the untruncated record.',
      returns: '{ observation: { id, type, content, prov, context?, created_at } }.',
      errors: ['NOT_FOUND — no observation with that id'],
      examples: [
        '{"id":"obs_1779411275114_rn1c95"} -> the full record, confidence "medium" (agent note, 4 months old)',
        'edge: {"id":"obs_nope"} -> ok:false, NOT_FOUND with a hint to search instead',
      ],
        },
    inputSchema: { id: z.string().trim().min(1).max(128).describe('e.g. "obs_1779411275114_rn1c95".') },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (args) => {
      const id = args.id as string;
      const row = getObservation(id);
      if (!row) {
        return fail('get_observation', ERROR_CODES.NOT_FOUND, `Observation not found: ${id}`, {
          field: 'id',
          hint: 'Ids come from search_observations results; run a search to get a current one.',
        });
      }
      return ok('get_observation', { observation: presentObservation(row) }, untrustedListMeta());
    },
  },

  {
    name: 'list_sessions',
    title: 'List sessions',
    doc: {
      purpose: 'List recent sessions with project tag, start/end time and summary.',
      useWhen: 'You need a session id before calling get_session_timeline.',
      returns: '{ sessions: [{ id, project_tag, started_at, ended_at, summary }] }.',
      errors: ['INVALID_INPUT — limit outside 1-100'],
      examples: [
        '{"project_tag":"project-graph-mcp","limit":5} -> 5 sessions, newest first',
        'edge: {"project_tag":"never-used"} -> sessions:[], count:0 (ok:true)',
      ],
        },
    inputSchema: { project_tag: projectTagString.optional(), limit: limitNumber(10) },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (args) => {
      const sessions = listSessions(
        args.project_tag as string | undefined,
        (args.limit as number | undefined) ?? 10,
      );
      return ok('list_sessions', { sessions }, { count: sessions.length });
    },
  },

  {
    name: 'close_session',
    title: 'Close session',
    doc: {
      purpose: 'Mark a session ended and attach an optional summary.',
      useWhen: 'Wrapping up; normally called by the close-session hook or /compact rather than by hand.',
      notFor: 'Persisting narrative context — that is write_session_handoff.',
      returns: '{ closed, summary }.',
      errors: ['INVALID_INPUT — missing session_id'],
      notes: ['Idempotent: closing an already-closed session refreshes the summary instead of failing.'],
      examples: [
        '{"session_id":"8e20…","summary":"Hardened MCP tool contracts."} -> closed:"8e20…"',
        'edge: calling twice -> ok:true both times (second call just rewrites the summary)',
      ],
        },
    inputSchema: {
      session_id: sessionIdString,
      summary: z.string().trim().max(10_000).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: (args) => {
      const sessionId = args.session_id as string;
      const summary = args.summary as string | undefined;
      closeSession(sessionId, summary);
      return ok('close_session', { closed: sessionId, summary: summary ?? null });
    },
  },

  {
    name: 'graduate_observations',
    title: 'Graduate observations',
    doc: {
      purpose: 'Promote matching observations into a vault note and flag them promoted.',
      useWhen: 'A thread of observations has settled into something worth keeping permanently.',
      notFor: 'Reading memory — this writes a note and mutates rows.',
      returns: '{ created (vault-relative path), observations_graduated, by_type }.',
      errors: [
        'INVALID_INPUT — missing title/query or limit outside 1-100',
        'NO_MATCH — the query matched no observations, so there is nothing to graduate',
      ],
      notes: [
        'Not reversible through this server: promoted rows stay flagged even if you delete the note.',
        'Narrow with project_tag first; a broad query graduates mechanical hook noise into the vault.',
      ],
      examples: [
        '{"title":"Episodic memory design","query":"episodic memory","project_tag":"project-graph-mcp","limit":40} -> created:"Resources/graduated/2026-09-11-episodic-memory-design.md", 23 graduated',
        'edge: {"title":"Nothing","query":"zzzz"} -> ok:false, NO_MATCH (nothing is written and no row is flagged)',
      ],
        },
    inputSchema: {
      title: z.string().trim().min(3).max(200).describe('Title; becomes the filename slug.'),
      query: queryString.describe('Selects the observations to graduate.'),
      project_tag: projectTagString.optional(),
      limit: limitNumber(50),
      tags: tagList,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: (args) => {
      const query = args.query as string;
      const projectTag = args.project_tag as string | undefined;
      const observations = searchObservations(query, projectTag, (args.limit as number | undefined) ?? 50);

      if (observations.length === 0) {
        return fail('graduate_observations', ERROR_CODES.NO_MATCH, `No observations matched: "${query}".`, {
          field: 'query',
          hint: 'Run search_observations with the same query first to confirm there is something to graduate.',
          retryable: true,
        });
      }

      const absPath = graduateObservations({
        title: args.title as string,
        observations,
        projectTag,
        tags: (args.tags as string[] | undefined) ?? [],
      });
      for (const observation of observations) promoteObservation(observation.id);

      const byType: Record<string, number> = {};
      for (const observation of observations) {
        byType[observation.type] = (byType[observation.type] ?? 0) + 1;
      }

      return ok('graduate_observations', {
        created: absPath.replace(config.vault + '/', ''),
        observations_graduated: observations.length,
        by_type: byType,
      });
    },
  },
];
