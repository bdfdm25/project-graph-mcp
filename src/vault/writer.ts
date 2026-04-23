import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { config } from '../config.js';
import type { ObservationRow } from '../graph/store.js';

// ─── Frontmatter builder ──────────────────────────────────────────────────────

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildFrontmatter(fields: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function writeNote(relPath: string, frontmatter: Record<string, unknown>, body: string): string {
  const absPath = join(config.vault, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  const content = buildFrontmatter(frontmatter) + '\n\n' + body.trim() + '\n';
  writeFileSync(absPath, content, 'utf-8');
  return absPath;
}

// ─── Decision ─────────────────────────────────────────────────────────────────

export interface WriteDecisionOptions {
  title: string;
  body: string;
  tags?: string[];
  status?: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  context?: string;
}

export function writeDecision(opts: WriteDecisionOptions): string {
  const slug = opts.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const date = isoDate();
  const relPath = `Resources/decisions/${date}-${slug}.md`;

  const frontmatter: Record<string, unknown> = {
    title: opts.title,
    date,
    status: opts.status ?? 'accepted',
    tags: ['decision', ...(opts.tags ?? [])],
  };
  if (opts.context) frontmatter['context'] = opts.context;

  const body = opts.body;
  return writeNote(relPath, frontmatter, body);
}

// ─── Session handoff ──────────────────────────────────────────────────────────

export interface WriteHandoffOptions {
  summary: string;
  project?: string;
  tags?: string[];
}

export function writeSessionHandoff(opts: WriteHandoffOptions): string {
  const date = isoDate();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const relPath = `Archive/sessions/${timestamp}-handoff.md`;

  const frontmatter: Record<string, unknown> = {
    date,
    type: 'session-handoff',
    tags: ['handoff', ...(opts.tags ?? [])],
  };
  if (opts.project) frontmatter['project'] = opts.project;

  return writeNote(relPath, frontmatter, opts.summary);
}

// ─── Project doc summary ──────────────────────────────────────────────────────

export interface WriteProjectSummaryOptions {
  projectName: string;
  summary: string;
  sourceDoc: string;   // relative path of the original doc (for reference)
  tags?: string[];
}

export function writeProjectSummary(opts: WriteProjectSummaryOptions): string {
  const date = isoDate();
  const slug = opts.projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const relPath = `Resources/projects/${slug}/summary.md`;

  const frontmatter: Record<string, unknown> = {
    title: `${opts.projectName} — Summary`,
    date,
    status: 'current',
    source: opts.sourceDoc,
    tags: ['project-summary', slug, ...(opts.tags ?? [])],
  };

  return writeNote(relPath, frontmatter, opts.summary);
}

// ─── Graduate observations → vault note ──────────────────────────────────────

export interface GraduateObservationsOptions {
  title: string;
  observations: ObservationRow[];
  projectTag?: string;
  tags?: string[];
}

export function graduateObservations(opts: GraduateObservationsOptions): string {
  const date = isoDate();
  const slug = opts.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const relPath = `Resources/graduated/${date}-${slug}.md`;

  const frontmatter: Record<string, unknown> = {
    title: opts.title,
    date,
    type: 'graduated-observations',
    tags: ['graduated', ...(opts.projectTag ? [opts.projectTag] : []), ...(opts.tags ?? [])],
  };
  if (opts.projectTag) frontmatter['project'] = opts.projectTag;

  // Group observations by type
  const byType: Record<string, ObservationRow[]> = {};
  for (const obs of opts.observations) {
    if (!byType[obs.type]) byType[obs.type] = [];
    byType[obs.type].push(obs);
  }

  const typeLabels: Record<string, string> = {
    decision: 'Decisions',
    discovery: 'Discoveries',
    error: 'Errors & Fixes',
    'code-change': 'Code Changes',
    note: 'Notes',
    pattern: 'Patterns',
  };

  let body = '';
  for (const [type, rows] of Object.entries(byType)) {
    body += `\n## ${typeLabels[type] ?? type}\n\n`;
    for (const row of rows) {
      const ts = new Date(row.created_at).toISOString().slice(0, 16).replace('T', ' ');
      const ctx = row.context ? ` _(${JSON.parse(row.context).file ?? row.context})_` : '';
      body += `- **${ts}**${ctx}: ${row.content}\n`;
    }
  }

  body += `\n---\n_Graduated from ${opts.observations.length} episodic observations on ${date}._\n`;

  return writeNote(relPath, frontmatter, body);
}

// ─── Append backlink to an existing note ──────────────────────────────────────

export function appendBacklink(relPath: string, symbol: string, noteTitle: string): void {
  const absPath = join(config.vault, relPath);
  if (!existsSync(absPath)) return;
  const current = readFileSync(absPath, 'utf-8');
  const link = `\n- [[${noteTitle}]] ← \`${symbol}\``;
  if (current.includes(link.trim())) return;
  writeFileSync(absPath, current.trimEnd() + link + '\n', 'utf-8');
}
