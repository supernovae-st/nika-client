import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Nika, NikaCompatibilityError, NikaOperationError } from '../src/index.js';
import type { NikaLocalConfig } from '../src/index.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-nika.mjs',
);
const SERVER_TOKEN = 's'.repeat(32);

function native(overrides: Omit<NikaLocalConfig, 'bin'> = {}): Nika {
  return new Nika({ bin: FIXTURE, ...overrides });
}

function remote(fetch: typeof globalThis.fetch): Nika {
  return new Nika({
    url: 'https://nika.example/',
    token: SERVER_TOKEN,
    bin: FIXTURE,
    fetch,
  });
}

function healthResponse(): Response {
  return new Response(JSON.stringify({
    status: 'ok',
    service: 'nika-serve',
    engineVersion: '0.114.0',
    machineProtocolVersion: 1,
    snapshotFormatVersion: 1,
    checkReportVersion: 1,
    eventFormatVersion: 1,
    traceFormatVersion: 1,
    supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace'],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function findings(report: Record<string, unknown>): Record<string, unknown>[] {
  expect(Array.isArray(report.findings)).toBe(true);
  return report.findings as Record<string, unknown>[];
}

describe('the engine teaching report survives every transport', () => {
  it('falls back to the plain check report when snapshot capture is red', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse());
    const report = await remote(fetch as typeof globalThis.fetch)
      .check('red-snapshot.nika.yaml');

    expect(report).toMatchObject({ clean: false, exitCode: 2, report_version: 1 });
    expect(findings(report)[0]).toMatchObject({
      code: 'NIKA-AUTH-006',
      gate: 'AUTH',
    });
    expect(String(findings(report)[0]?.message)).toContain('permits.tools');
    // The refused snapshot line is kept, never in place of the findings.
    expect(String((report.snapshot_error as { message?: string })?.message))
      .toContain('cannot export execution snapshot');
    expect(report).not.toHaveProperty('execution_snapshot');
    // Only /health was reached: a red workflow never crosses the network.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.map(([url]) => String(url)))
      .toEqual(['https://nika.example/health']);
  });

  it('keeps a clean remote check on the snapshot admission path', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'accepted',
        snapshot_digest: 'a'.repeat(64),
        root: 'fixture.nika.yaml',
        units: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const report = await remote(fetch as typeof globalThis.fetch).check('flow.nika.yaml');

    expect(report).toMatchObject({ clean: true, exitCode: 0 });
    expect(report).not.toHaveProperty('snapshot_error');
    expect(String(fetch.mock.calls[1]?.[0])).toBe('https://nika.example/v1/check');
  });

  it('reads the native check report the engine wrote to stderr', async () => {
    const report = await native().check('stderr-report.nika.yaml');

    expect(report).toMatchObject({
      clean: false,
      exitCode: 3,
      parse_fatal: true,
      report_version: 1,
    });
    expect(String(findings(report)[0]?.message)).toContain('cannot read');
  });

  it('teaches from stderr when neither stream carries a report', async () => {
    const failure = await native().check('stderr-plain.nika.yaml').catch((cause) => cause);

    expect(failure).toBeInstanceOf(NikaCompatibilityError);
    expect((failure as NikaCompatibilityError).capability).toBe('check');
    expect((failure as Error).message).toContain('(exit 3)');
    expect((failure as Error).message).toContain('could not produce a check report');
  });

  it('surfaces a pre-run engine refusal as a typed operation error', async () => {
    const run = await native().run('refuse-1709.nika.yaml');
    const failure = await run.done.catch((cause) => cause);

    expect(failure).toBeInstanceOf(NikaOperationError);
    expect(failure).toMatchObject({
      name: 'NikaOperationError',
      operation: 'run',
      code: 'NIKA-1709',
      transport: 'native-process',
      status: 2,
    });
    expect((failure as Error).message).toContain('refusing to start');
    expect((failure as Error).message).toContain('--max-cost-usd');
  });

  it('keeps a protocol error for machine output that is not a refusal', async () => {
    const run = await native().run('garbage-line.nika.yaml');
    const failure = await run.done.catch((cause) => cause);

    expect(failure).toMatchObject({ name: 'NikaProtocolError', transport: 'native-process' });
    expect((failure as Error).message).toContain('this line is not machine output at all');
  });

  it('names the engine path and the spawn errno when the engine cannot start', async () => {
    const failure = await new Nika({ bin: '/nonexistent/nika' })
      .check('flow.nika.yaml')
      .catch((cause) => cause);

    expect(failure).toBeInstanceOf(NikaCompatibilityError);
    expect((failure as Error).message).toContain('/nonexistent/nika');
    expect((failure as Error).message).toContain('ENOENT');
  });
});
