import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpectralDriftReport } from '../src/domain/noise/drift.ts';
import { summarizeNoise } from '../src/domain/noise/classify.ts';
import { createServer } from '../src/http/server.ts';
import type { SpectralDriftRequest, SpectralRunInput, SpectrumBin } from '../src/domain/types.ts';

function bins(powers: number[], spacingHz = 1, offsetHz = 0): SpectrumBin[] {
  return powers.map((power, index) => ({ frequencyHz: offsetHz + index * spacingHz, power, amplitude: Math.sqrt(power) }));
}

function run(runLabel: string, powers: number[], overrides: Partial<SpectralRunInput> = {}): SpectralRunInput {
  return { runLabel, sampleRateHz: 1_000, spectrum: bins(powers), ...overrides };
}

function flat(length: number, power: number): number[] {
  return Array.from({ length }, () => power);
}

test('stable runs produce a stable verdict over the full comparable band', () => {
  const report = buildSpectralDriftReport({ runs: [run('cool-1', flat(64, 1)), run('cool-2', flat(64, 1.02)), run('cool-3', flat(64, 0.99))] });
  assert.equal(report.verdict, 'stable');
  assert.equal(report.direction, 'flat');
  assert.equal(report.abruptIntervals.length, 0);
  assert.deepEqual(report.comparableBandHz, { lowHz: 0, highHz: 63 });
  assert.equal(report.comparableBinCount, 64);
  assert.equal(report.baseline.length, 64);
  assert.equal(report.baseline[5].medianPower, 1);
  assert.ok(Math.abs(report.runs[1].bandIntegratedPower! - 65.28) < 1e-6);
  assert.equal(report.runs[0].missingBinCount, 0);
  assert.ok(report.reasons[0].includes('same noise class'));
});

test('report is deterministic and never mutates the input spectra', () => {
  const shuffled = [...bins(flat(64, 1))].reverse();
  const request: SpectralDriftRequest = { runs: [run('cool-1', flat(64, 1)), { runLabel: 'cool-2', sampleRateHz: 1_000, spectrum: shuffled }] };
  const snapshot = JSON.stringify(request);
  const first = buildSpectralDriftReport(request);
  const second = buildSpectralDriftReport(request);
  assert.deepEqual(first, second);
  assert.equal(first.inputDigest, second.inputDigest);
  assert.equal(JSON.stringify(request), snapshot);
  assert.equal(request.runs[1].spectrum[0].frequencyHz, 63);
  assert.deepEqual(first.runs[0].noise, first.runs[1].noise);
});

test('monotonic power growth is reported as increasing and needs review', () => {
  const report = buildSpectralDriftReport({ runs: [run('cool-1', flat(64, 1)), run('cool-2', flat(64, 2)), run('cool-3', flat(64, 4))] });
  assert.equal(report.direction, 'increasing');
  assert.equal(report.verdict, 'needs-review');
  assert.ok(report.reasons.some((reason) => reason.includes('trends increasing')));
});

test('a narrowband burst is flagged as an abrupt interval with reused noise classes', () => {
  const spiked = flat(64, 1);
  spiked[10] = 100;
  spiked[11] = 100;
  spiked[12] = 50;
  const report = buildSpectralDriftReport({ runs: [run('cool-1', flat(64, 1)), run('cool-2', spiked)] });
  assert.equal(report.verdict, 'needs-review');
  assert.deepEqual(report.abruptIntervals, [{ startHz: 10, endHz: 12, maxJumpRatio: 100, betweenRuns: ['cool-1', 'cool-2'] }]);
  assert.equal(report.runs[0].noise.class, 'drift');
  assert.equal(report.runs[1].noise.class, 'periodic');
  assert.ok(report.reasons.some((reason) => reason.includes('Noise class changes')));
  const tolerant = buildSpectralDriftReport({ jumpThresholdRatio: 200, runs: [run('cool-1', flat(64, 1)), run('cool-2', spiked)] });
  assert.equal(tolerant.abruptIntervals.length, 0);
});

test('different sample rates are reported as not comparable instead of being mixed', () => {
  const report = buildSpectralDriftReport({ runs: [run('cool-1', flat(64, 1)), run('cool-2', flat(64, 1), { sampleRateHz: 2_000 })] });
  assert.equal(report.verdict, 'not-comparable');
  assert.ok(report.reasons.some((reason) => reason.includes('sample rates')));
  assert.equal(report.comparableBandHz, null);
  assert.equal(report.comparableBinCount, 0);
  assert.equal(report.baseline.length, 0);
  assert.equal(report.direction, null);
  assert.equal(report.runs[0].bandIntegratedPower, null);
  assert.equal(report.runs[0].noise.class, 'drift');
});

test('different frequency grid spacing is not comparable', () => {
  const report = buildSpectralDriftReport({ runs: [run('cool-1', flat(64, 1)), { runLabel: 'cool-2', sampleRateHz: 1_000, spectrum: bins(flat(64, 1), 0.5) }] });
  assert.equal(report.verdict, 'not-comparable');
  assert.ok(report.reasons.some((reason) => reason.includes('grid spacing')));
});

test('missing frequency points shrink the comparable set and require review', () => {
  const gapped = bins(flat(64, 1)).filter((bin) => bin.frequencyHz < 5 || bin.frequencyHz > 9);
  const report = buildSpectralDriftReport({ runs: [run('cool-1', flat(64, 1)), { runLabel: 'cool-2', sampleRateHz: 1_000, spectrum: gapped }] });
  assert.equal(report.verdict, 'needs-review');
  assert.equal(report.comparableBinCount, 59);
  assert.equal(report.runs[1].missingBinCount, 5);
  assert.ok(report.warnings.some((warning) => warning.includes('cool-2') && warning.includes('missing 5')));
  assert.ok(report.reasons.some((reason) => reason.includes('missing frequency points')));
});

test('runs without enough shared frequencies are not comparable', () => {
  const noOverlap = buildSpectralDriftReport({ runs: [run('cool-1', flat(5, 1)), { runLabel: 'cool-2', sampleRateHz: 1_000, spectrum: bins(flat(5, 1), 1, 10) }] });
  assert.equal(noOverlap.verdict, 'not-comparable');
  assert.ok(noOverlap.reasons.some((reason) => reason.includes('do not overlap')));
  const tooThin = buildSpectralDriftReport({ runs: [run('cool-1', flat(5, 1)), { runLabel: 'cool-2', sampleRateHz: 1_000, spectrum: bins(flat(5, 1), 1, 3) }] });
  assert.equal(tooThin.verdict, 'not-comparable');
  assert.ok(tooThin.reasons.some((reason) => reason.includes('share only 2')));
});

test('invalid runs are rejected instead of being silently mixed', () => {
  assert.throws(() => buildSpectralDriftReport({ runs: [run('cool-1', flat(8, 1))] }), (error: any) => error.code === 'INSUFFICIENT_RUNS');
  assert.throws(() => buildSpectralDriftReport({ runs: [run('cool-1', flat(8, 1)), run('cool-2', [])] }), (error: any) => error.code === 'EMPTY_RUN_SPECTRUM');
  assert.throws(() => buildSpectralDriftReport({ runs: [run('cool-1', flat(8, 1)), run('cool-1', flat(8, 2))] }), (error: any) => error.code === 'DUPLICATE_RUN_LABEL');
  const duplicatedBin = bins(flat(8, 1));
  duplicatedBin.push({ frequencyHz: 3, power: 1, amplitude: 1 });
  assert.throws(() => buildSpectralDriftReport({ runs: [run('cool-1', flat(8, 1)), { runLabel: 'cool-2', sampleRateHz: 1_000, spectrum: duplicatedBin }] }), (error: any) => error.code === 'DUPLICATE_FREQUENCY_BIN');
});

test('noise classification semantics are reused for every run', () => {
  const spectrum = bins(flat(64, 1));
  const report = buildSpectralDriftReport({ runs: [
    { runLabel: 'cool-1', sampleRateHz: 1_000, spectrum, coherence: 0.9 },
    { runLabel: 'cool-2', sampleRateHz: 1_000, spectrum: bins(flat(64, 1)), coherence: 0.1 },
  ] });
  assert.deepEqual(report.runs[0].noise, summarizeNoise(spectrum, 0.9));
  assert.equal(report.runs[0].noise.class, 'correlated');
  assert.equal(report.runs[1].noise.class, 'drift');
  assert.equal(report.verdict, 'needs-review');
});

test('http endpoint serves drift reports and surfaces domain errors', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as { port: number };
    const ok = await fetch(`http://127.0.0.1:${port}/v1/spectra/drift-report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runs: [run('cool-1', flat(64, 1)), run('cool-2', flat(64, 1))] }) });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.verdict, 'stable');
    const bad = await fetch(`http://127.0.0.1:${port}/v1/spectra/drift-report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runs: [run('cool-1', flat(8, 1)), run('cool-1', flat(8, 1))] }) });
    assert.equal(bad.status, 422);
    assert.equal((await bad.json()).error.code, 'DUPLICATE_RUN_LABEL');
  } finally {
    server.close();
  }
});
