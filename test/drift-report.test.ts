import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDriftReport } from '../src/domain/noise/drift-report.ts';
import type { CrossSpectrumBin, DriftRunInput, SpectrumBin } from '../src/domain/types.ts';

const FFT = 64;
const BIN_COUNT = FFT / 2 + 1;
const SAMPLE_RATE = 1000;
const SPACING = SAMPLE_RATE / FFT;

function frequencyAt(index: number): number {
  return (index * SAMPLE_RATE) / FFT;
}

function powerAt(index: number): number {
  const ripple = 0.004 * (1 + 0.3 * Math.cos(index / 2));
  return 0.02 + ripple;
}

function makeSpectrum(scale = 1, options: { drop?: number[]; peakAt?: number } = {}): SpectrumBin[] {
  const drop = new Set(options.drop ?? []);
  const bins: SpectrumBin[] = [];
  for (let index = 0; index < BIN_COUNT; index += 1) {
    if (drop.has(index)) continue;
    let power = powerAt(index);
    if (options.peakAt !== undefined && index === options.peakAt) power = 0.6;
    power *= (1 + (0.3 * index) / BIN_COUNT) * scale;
    bins.push({ frequencyHz: frequencyAt(index), power, amplitude: Math.sqrt(power) });
  }
  return bins;
}

function makeCrossSpectrum(coherence: number, peakIndex: number): CrossSpectrumBin[] {
  return Array.from({ length: BIN_COUNT }, (_, index) => ({ frequencyHz: frequencyAt(index), power: 0.02, amplitude: Math.sqrt(0.02), coherence: index === peakIndex ? 1 : coherence, phaseRad: 0 }));
}

function run(label: string, spectrum: SpectrumBin[], extra: Partial<DriftRunInput> = {}): DriftRunInput {
  return { label, sampleRateHz: SAMPLE_RATE, spectrum, ...extra };
}

test('identical runs produce a stable verdict without modifying inputs', () => {
  const first = run('cycle-1', makeSpectrum());
  const second = run('cycle-2', makeSpectrum());
  const snapshot = JSON.stringify([first, second]);
  const report = buildDriftReport({ runs: [first, second] });
  assert.equal(report.verdict, 'stable');
  assert.equal(report.frequencyGrid.comparable, true);
  assert.equal(report.frequencyGrid.completeCoverage, true);
  assert.equal(report.frequencyGrid.sharedPositiveBinCount, BIN_COUNT - 1);
  assert.equal(report.abruptIntervals.length, 0);
  assert.deepEqual(report.bands.map((band) => band.stable), [true, true]);
  assert.equal(report.peak?.applicable, false);
  assert.equal(report.correlation?.applicable, false);
  assert.equal(report.reasons.length, 0);
  assert.equal(JSON.stringify([first, second]), snapshot);
});

test('report is deterministic for repeated calls', () => {
  const input = { runs: [run('cycle-1', makeSpectrum()), run('cycle-2', makeSpectrum(1.01))] };
  assert.deepEqual(buildDriftReport(input), buildDriftReport(JSON.parse(JSON.stringify(input))));
});

test('a tenfold power step marks abrupt intervals in every band and requires review', () => {
  const report = buildDriftReport({ runs: [run('cycle-1', makeSpectrum()), run('cycle-2', makeSpectrum(10))] });
  assert.equal(report.verdict, 'needs-review');
  assert.ok(report.reasons.includes('abrupt-power-interval'));
  assert.equal(report.abruptIntervals.length, 2);
  assert.deepEqual(report.abruptIntervals.map((interval) => interval.bandId), ['low-frequency-drift', 'broadband-white-floor']);
  for (const interval of report.abruptIntervals) {
    assert.equal(interval.fromRun, 'cycle-1');
    assert.equal(interval.toRun, 'cycle-2');
    assert.ok(interval.peakDeltaDb! >= 6);
  }
  const low = report.bands.find((band) => band.id === 'low-frequency-drift')!;
  assert.equal(low.direction, 'rising');
  assert.equal(low.monotonic, true);
});

test('gradual 3 dB steps across three runs require review but do not create abrupt intervals', () => {
  const report = buildDriftReport({ runs: [run('a', makeSpectrum()), run('b', makeSpectrum(2)), run('c', makeSpectrum(4))] });
  assert.equal(report.verdict, 'needs-review');
  assert.equal(report.abruptIntervals.length, 0);
  assert.ok(report.reasons.includes('baseline-change-exceeds-threshold'));
  assert.deepEqual(report.bands.map((band) => band.direction), ['rising', 'rising']);
  assert.deepEqual(report.bands.map((band) => band.monotonic), [true, true]);
});

test('missing interior bins restrict comparison to shared bins and require review', () => {
  const full = makeSpectrum();
  const holed = makeSpectrum(1, { drop: [20, 21] });
  const report = buildDriftReport({ runs: [run('cycle-1', full), run('cycle-2', holed)] });
  assert.equal(report.verdict, 'needs-review');
  assert.equal(report.frequencyGrid.completeCoverage, false);
  assert.equal(report.frequencyGrid.sharedPositiveBinCount, BIN_COUNT - 3);
  assert.deepEqual(report.runs.find((item) => item.label === 'cycle-2')!.missingFrequencyHz, [frequencyAt(20), frequencyAt(21)]);
  assert.ok(report.reasons.includes('missing-frequency-bins'));
  assert.ok(report.warnings.some((message) => message.includes('not interpolated')));
});

test('a shifted narrowband peak is flagged as peak-frequency shift', () => {
  const report = buildDriftReport({ runs: [run('cycle-1', makeSpectrum(1, { peakAt: 15 })), run('cycle-2', makeSpectrum(1, { peakAt: 22 }))] });
  assert.equal(report.verdict, 'needs-review');
  assert.equal(report.peak?.applicable, true);
  assert.ok(report.peak!.reasons.includes('narrowband-peak-frequency-shift'));
  assert.ok((report.peak!.frequencySpreadHz ?? 0) > SPACING);
});

test('coherence crossing the 0.7 threshold is a reviewable correlation change', () => {
  const report = buildDriftReport({
    runs: [
      run('cycle-1', makeSpectrum(), { crossSpectrum: makeCrossSpectrum(0.9, 15) }),
      run('cycle-2', makeSpectrum(), { crossSpectrum: makeCrossSpectrum(0.2, 15) }),
    ],
  });
  assert.equal(report.verdict, 'needs-review');
  assert.equal(report.correlation?.applicable, true);
  assert.ok(report.correlation!.reasons.includes('correlation-threshold-crossing'));
  assert.ok(report.reasons.includes('noise-class-change'));
  assert.deepEqual(report.runs.map((item) => item.noiseClass), ['correlated', 'white']);
});

test('different sample rates are incomparable and no bands are computed', () => {
  const first = run('cycle-1', makeSpectrum());
  const second: DriftRunInput = { label: 'cycle-2', sampleRateHz: 2000, spectrum: makeSpectrum() };
  const report = buildDriftReport({ runs: [first, second] });
  assert.equal(report.verdict, 'incomparable');
  assert.equal(report.frequencyGrid.comparable, false);
  assert.deepEqual(report.reasons, ['sample-rate-mismatch']);
  assert.equal(report.bands.length, 0);
  assert.equal(report.peak, null);
});

test('different grid spacings are incomparable', () => {
  const spacedA: SpectrumBin[] = Array.from({ length: 26 }, (_, index) => ({ frequencyHz: index * 20, power: powerAt(index), amplitude: Math.sqrt(powerAt(index)) }));
  const report = buildDriftReport({ runs: [run('cycle-1', makeSpectrum()), { label: 'cycle-2', sampleRateHz: SAMPLE_RATE, spectrum: spacedA }] });
  assert.equal(report.verdict, 'incomparable');
  assert.deepEqual(report.reasons, ['frequency-grid-spacing-mismatch']);
});

test('runs with fewer than two shared positive bins are incomparable', () => {
  const onlyLow: SpectrumBin[] = [0, 1, 2].map((index) => ({ frequencyHz: frequencyAt(index), power: powerAt(index), amplitude: Math.sqrt(powerAt(index)) }));
  const onlyHigh: SpectrumBin[] = [0, 1, 30].map((index) => ({ frequencyHz: frequencyAt(index), power: powerAt(index), amplitude: Math.sqrt(powerAt(index)) }));
  const report = buildDriftReport({ runs: [run('cycle-1', onlyLow), run('cycle-2', onlyHigh)] });
  assert.equal(report.verdict, 'incomparable');
  assert.deepEqual(report.reasons, ['insufficient-overlapping-bins']);
});

test('structural problems are rejected instead of silently compared', () => {
  assert.throws(() => buildDriftReport({ runs: [run('only', makeSpectrum())] }), /At least two runs/);
  assert.throws(() => buildDriftReport({ runs: [run('a', makeSpectrum()), run('a', makeSpectrum())] }), /unique/);
  assert.throws(() => buildDriftReport({ runs: [run('a', []), run('b', makeSpectrum())] }), /at least two bins/);
  const offGrid = makeSpectrum().map((bin) => bin.frequencyHz === frequencyAt(15) ? { ...bin, frequencyHz: bin.frequencyHz + 0.7 } : bin);
  assert.throws(() => buildDriftReport({ runs: [run('a', offGrid), run('b', makeSpectrum())] }), /uniform spacing/);
  const badPower = makeSpectrum().map((bin) => bin.frequencyHz === 0 ? { ...bin, power: -1 } : bin);
  assert.throws(() => buildDriftReport({ runs: [run('a', badPower), run('b', makeSpectrum())] }), /power must be finite/);
});

test('run assessments reuse the existing noise classification semantics', () => {
  const report = buildDriftReport({ runs: [run('cycle-1', makeSpectrum()), run('cycle-2', makeSpectrum(1.02))] });
  assert.ok(report.runs.every((item) => item.noiseClass === item.noise.class && item.noiseClass === 'white'));
  assert.ok(report.runs.every((item) => item.noise.whiteLevel > 0 && item.noise.dominantFrequencyHz !== null));
});

test('a zero-power follow-up run is flagged as zero-power transition and abrupt interval', () => {
  const flat = makeSpectrum().map((bin) => ({ ...bin, power: 0, amplitude: 0 }));
  const report = buildDriftReport({ runs: [run('cycle-1', makeSpectrum()), run('cycle-2', flat)] });
  assert.equal(report.verdict, 'needs-review');
  assert.ok(report.reasons.includes('zero-power-bin'));
  assert.ok(report.abruptIntervals.every((interval) => interval.zeroPowerTransition));
});

test('a narrowband peak outside the shared band cannot be compared across runs', () => {
  const floor = (index: number) => 0.02 + 0.001 * Math.cos(index);
  const truncated: SpectrumBin[] = [];
  const peaked: SpectrumBin[] = [];
  for (let index = 0; index < BIN_COUNT; index += 1) {
    const frequencyHz = frequencyAt(index);
    if (![10, 11, 12, 13].includes(index)) {
      truncated.push({ frequencyHz, power: floor(index), amplitude: Math.sqrt(floor(index)) });
    }
    const power = index === 12 ? 0.6 : floor(index);
    peaked.push({ frequencyHz, power, amplitude: Math.sqrt(power) });
  }
  const report = buildDriftReport({ runs: [run('cycle-1', truncated), run('cycle-2', peaked)] });
  assert.equal(report.verdict, 'needs-review');
  assert.equal(report.peak?.applicable, true);
  assert.equal(report.peak!.comparable, false);
  assert.ok(report.peak!.reasons.includes('peak-outside-shared-band'));
  assert.ok(report.reasons.includes('missing-frequency-bins'));
});
