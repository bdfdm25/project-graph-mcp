import { describe, it, expect } from 'vitest';
import {
  compact,
  codeGraphProvenance,
  fileProvenance,
  inferOrigin,
  observationProvenance,
  vaultProvenance,
} from './provenance.js';

const DAY = 86_400_000;
const daysAgo = (n: number) => Date.now() - n * DAY;

function observation(overrides: Partial<Parameters<typeof observationProvenance>[0]> = {}) {
  return {
    id: 'obs_1',
    type: 'decision',
    content: 'Chose SQLite for episodic memory.',
    context: null,
    created_at: daysAgo(1),
    origin: 'agent',
    ...overrides,
  };
}

describe('inferOrigin', () => {
  it('trusts a recorded origin', () => {
    expect(inferOrigin({ origin: 'user', content: 'anything', context: null })).toBe('user');
  });

  it('infers hook for a tool-stamped mechanical one-liner', () => {
    expect(
      inferOrigin({ origin: null, content: 'Ran: npm test', context: '{"tool":"Bash"}' }),
    ).toBe('hook');
  });

  it('stays unknown for a legacy row that reads like judgement', () => {
    expect(
      inferOrigin({ origin: null, content: 'Prisma returns a Proxy without models.', context: null }),
    ).toBe('unknown');
  });
});

describe('observationProvenance', () => {
  it('rates a recent agent decision high', () => {
    expect(observationProvenance(observation())).toMatchObject({ confidence: 'high', origin: 'agent' });
  });

  it('rates a mechanical hook capture low', () => {
    const p = observationProvenance(observation({ origin: 'hook', content: 'Ran: ls', type: 'note' }));
    expect(p.confidence).toBe('low');
    expect(p.reason).toContain('mechanical');
  });

  it('drops one band past 180 days and two past a year', () => {
    expect(observationProvenance(observation({ created_at: daysAgo(200) })).confidence).toBe('medium');
    expect(observationProvenance(observation({ created_at: daysAgo(400) })).confidence).toBe('low');
  });

  it('forces low when the content trips injection signals', () => {
    const p = observationProvenance(observation(), true);
    expect(p.confidence).toBe('low');
    expect(p.reason).toContain('injection');
  });

  it('always marks stored content untrusted', () => {
    expect(observationProvenance(observation({ origin: 'user' })).trust).toBe('untrusted');
  });
});

describe('compact', () => {
  it('renders origin/confidence and omits the reason when the band is predictable', () => {
    expect(compact(observationProvenance(observation()))).toEqual({ prov: 'agent/high' });
    expect(compact(observationProvenance(observation({ origin: 'hook', content: 'Ran: ls' })))).toEqual({
      prov: 'hook/low',
    });
  });

  it('explains a low band the caller could not have predicted', () => {
    const flagged = compact(observationProvenance(observation(), true));
    expect(flagged.prov).toBe('agent/low');
    expect(flagged.why).toContain('injection');
  });
});

describe('vaultProvenance', () => {
  it('promotes a strongly matched recent note', () => {
    expect(vaultProvenance('Areas/x.md', 5, { mtime: daysAgo(3) }).confidence).toBe('high');
  });

  it('demotes a single weak match', () => {
    expect(vaultProvenance('Areas/x.md', 1, { mtime: daysAgo(3) }).confidence).toBe('low');
  });

  it('demotes a strong match in a stale note', () => {
    expect(vaultProvenance('Areas/x.md', 5, { mtime: daysAgo(400) }).confidence).toBe('low');
  });
});

describe('codeGraphProvenance', () => {
  it('is trusted and high for a fresh index', () => {
    expect(codeGraphProvenance('/repo', daysAgo(1), 0)).toMatchObject({
      trust: 'trusted',
      origin: 'derived',
      confidence: 'high',
    });
  });

  it('drops to medium and says which files drifted', () => {
    const p = codeGraphProvenance('/repo', daysAgo(1), 4);
    expect(p.confidence).toBe('medium');
    expect(p.reason).toContain('4 file(s) changed');
  });

  it('is low when the project was never indexed', () => {
    expect(codeGraphProvenance('/repo', null).confidence).toBe('low');
  });
});

describe('fileProvenance', () => {
  it('marks file content untrusted and drops to low on injection signals', () => {
    expect(fileProvenance('/repo/README.md', false)).toMatchObject({ trust: 'untrusted', confidence: 'medium' });
    expect(fileProvenance('/repo/README.md', true).confidence).toBe('low');
  });
});
