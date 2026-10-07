import { createHash } from 'node:crypto';
import { invariant } from '../errors.ts';
import { summarizeNoise } from './classify.ts';
import type { NoiseSummary, SpectralAbruptInterval, SpectralBaselineBin, SpectralDriftDirection, SpectralDriftReport, SpectralDriftRequest, SpectralDriftVerdict, SpectralRunInput, SpectrumBin } from '../types.ts';

const GRID_RELATIVE_TOLERANCE = 1e-6;
const SAMPLE_RATE_RELATIVE_TOLERANCE = 1e-9;
const MIN_COMPARABLE_BINS = 3;
const LOW_CONFIDENCE_THRESHOLD = 0.5;
const POWER_EPSILON = 1e-30;
const DEFAULT_JUMP_THRESHOLD_RATIO = 3;
const DEFAULT_DRIFT_TOLERANCE_RATIO = 0.2;

type NormalizedRun = {
  runLabel: string;
  sampleRateHz: number;
  bins: SpectrumBin[];
  spacingHz: number | null;
  noise: NoiseSummary;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function trendSlope(values: number[]): number {
  const count = values.length;
  const meanX = (count - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / count;
  const denominator = values.reduce((sum, _, index) => sum + (index - meanX) ** 2, 0);
  return denominator ? values.reduce((sum, value, index) => sum + (index - meanX) * (value - meanY), 0) / denominator : 0;
}

function normalizeRun(run: SpectralRunInput, index: number): NormalizedRun {
  invariant(run !== null && typeof run === 'object', 'INVALID_RUN', 'Each run must be an object', { index });
  const runLabel = typeof run.runLabel === 'string' ? run.runLabel.trim() : '';
  invariant(runLabel.length > 0, 'INVALID_RUN_LABEL', 'Each run needs a non-empty label', { index });
  invariant(Number.isFinite(run.sampleRateHz) && run.sampleRateHz > 0, 'INVALID_SAMPLE_RATE', 'Run sample rate must be positive', { runLabel });
  invariant(Array.isArray(run.spectrum) && run.spectrum.length > 0, 'EMPTY_RUN_SPECTRUM', 'Run spectrum must contain at least one bin', { runLabel });
  run.spectrum.forEach((bin, binIndex) => {
    invariant(Number.isFinite(bin?.frequencyHz) && bin.frequencyHz >= 0, 'INVALID_SPECTRUM_BIN', 'Bin frequency must be finite and non-negative', { runLabel, binIndex });
    invariant(Number.isFinite(bin?.power) && bin.power >= 0, 'INVALID_SPECTRUM_BIN', 'Bin power must be finite and non-negative', { runLabel, binIndex });
  });
  const coherence = run.coherence ?? null;
  invariant(coherence === null || (Number.isFinite(coherence) && coherence >= 0 && coherence <= 1), 'INVALID_COHERENCE', 'Run coherence must be within [0, 1]', { runLabel });
  const bins = [...run.spectrum].sort((a, b) => a.frequencyHz - b.frequencyHz);
  for (let position = 1; position < bins.length; position += 1) {
    invariant(bins[position].frequencyHz !== bins[position - 1].frequencyHz, 'DUPLICATE_FREQUENCY_BIN', 'Run spectrum contains duplicate frequency bins', { runLabel, frequencyHz: bins[position].frequencyHz });
  }
  let spacingHz: number | null = null;
  if (bins.length >= 2) {
    const steps: number[] = [];
    for (let position = 1; position < bins.length; position += 1) steps.push(bins[position].frequencyHz - bins[position - 1].frequencyHz);
    spacingHz = median(steps);
    invariant(spacingHz > 0, 'INVALID_FREQUENCY_GRID', 'Frequency grid spacing must be positive', { runLabel });
  }
  return { runLabel, sampleRateHz: run.sampleRateHz, bins, spacingHz, noise: summarizeNoise(bins, coherence) };
}

function matchPowers(bins: SpectrumBin[], expected: number[], spacingHz: number): Array<number | null> {
  const frequencies = bins.map((bin) => bin.frequencyHz);
  return expected.map((frequencyHz) => {
    const tolerance = Math.min(GRID_RELATIVE_TOLERANCE * Math.max(1, Math.abs(frequencyHz)), spacingHz / 4);
    let low = 0;
    let high = frequencies.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (frequencies[middle] < frequencyHz) low = middle + 1;
      else high = middle;
    }
    for (const candidate of [low, low - 1]) {
      if (candidate >= 0 && candidate < frequencies.length && Math.abs(frequencies[candidate] - frequencyHz) <= tolerance) return bins[candidate].power;
    }
    return null;
  });
}

export function buildSpectralDriftReport(request: SpectralDriftRequest): SpectralDriftReport {
  invariant(request !== null && typeof request === 'object' && Array.isArray(request.runs), 'INVALID_RUNS', 'Runs must be provided as an array');
  invariant(request.runs.length >= 2, 'INSUFFICIENT_RUNS', 'At least two runs are required for a drift report');
  const jumpThresholdRatio = request.jumpThresholdRatio ?? DEFAULT_JUMP_THRESHOLD_RATIO;
  invariant(Number.isFinite(jumpThresholdRatio) && jumpThresholdRatio > 1, 'INVALID_JUMP_THRESHOLD', 'Jump threshold ratio must be greater than 1');
  const driftToleranceRatio = request.driftToleranceRatio ?? DEFAULT_DRIFT_TOLERANCE_RATIO;
  invariant(Number.isFinite(driftToleranceRatio) && driftToleranceRatio >= 0 && driftToleranceRatio < 1, 'INVALID_DRIFT_TOLERANCE', 'Drift tolerance ratio must be within [0, 1)');
  const runs = request.runs.map(normalizeRun);
  const seenLabels = new Set<string>();
  for (const run of runs) {
    invariant(!seenLabels.has(run.runLabel), 'DUPLICATE_RUN_LABEL', 'Run labels must be unique', { runLabel: run.runLabel });
    seenLabels.add(run.runLabel);
  }

  const incomparable: string[] = [];
  const referenceRate = runs[0].sampleRateHz;
  if (runs.some((run) => Math.abs(run.sampleRateHz - referenceRate) > SAMPLE_RATE_RELATIVE_TOLERANCE * Math.max(1, referenceRate))) {
    incomparable.push(`Runs use different sample rates and cannot be mixed: ${runs.map((run) => `${run.runLabel}=${run.sampleRateHz} Hz`).join(', ')}`);
  }
  const gridRuns = runs.filter((run) => run.spacingHz !== null);
  const spacingHz = gridRuns.length ? gridRuns[0].spacingHz : null;
  const offsetHz = gridRuns.length ? gridRuns[0].bins[0].frequencyHz : null;
  if (!gridRuns.length) incomparable.push('Cannot determine a frequency grid from single-bin spectra');
  if (spacingHz !== null && offsetHz !== null) {
    if (gridRuns.some((run) => Math.abs(run.spacingHz! - spacingHz) > GRID_RELATIVE_TOLERANCE * Math.max(spacingHz, run.spacingHz!))) {
      incomparable.push(`Frequency grid spacing differs across runs: ${gridRuns.map((run) => `${run.runLabel}=${run.spacingHz} Hz`).join(', ')}`);
    } else {
      const misaligned = gridRuns.filter((run) => {
        const phase = (run.bins[0].frequencyHz - offsetHz) / spacingHz;
        return Math.abs(phase - Math.round(phase)) > GRID_RELATIVE_TOLERANCE * Math.max(1, Math.abs(phase));
      });
      if (misaligned.length) incomparable.push(`Frequency grids are offset differently across runs and cannot be aligned: ${misaligned.map((run) => run.runLabel).join(', ')}`);
    }
  }

  const lowHz = Math.max(...runs.map((run) => run.bins[0].frequencyHz));
  const highHz = Math.min(...runs.map((run) => run.bins.at(-1)!.frequencyHz));
  let expected: number[] = [];
  let powerTable: Array<Array<number | null>> = [];
  let commonIndices: number[] = [];
  if (!incomparable.length && spacingHz !== null && offsetHz !== null) {
    if (lowHz > highHz) {
      incomparable.push('Runs do not overlap in frequency');
    } else {
      const firstGridIndex = Math.ceil((lowHz - offsetHz) / spacingHz - GRID_RELATIVE_TOLERANCE);
      const lastGridIndex = Math.floor((highHz - offsetHz) / spacingHz + GRID_RELATIVE_TOLERANCE);
      for (let gridIndex = firstGridIndex; gridIndex <= lastGridIndex; gridIndex += 1) expected.push(offsetHz + gridIndex * spacingHz);
      powerTable = runs.map((run) => matchPowers(run.bins, expected, spacingHz));
      commonIndices = expected.map((_, index) => index).filter((index) => powerTable.every((powers) => powers[index] !== null));
      if (commonIndices.length < MIN_COMPARABLE_BINS) incomparable.push(`Runs share only ${commonIndices.length} frequency point(s); at least ${MIN_COMPARABLE_BINS} are required`);
    }
  }
  const comparable = incomparable.length === 0;

  const warnings: string[] = [];
  const missingByRun: Array<number | null> = runs.map(() => null);
  if (comparable) {
    runs.forEach((run, runIndex) => {
      const missing = expected.length - powerTable[runIndex].filter((power) => power !== null).length;
      missingByRun[runIndex] = missing;
      if (missing > 0) warnings.push(`Run '${run.runLabel}' is missing ${missing} frequency point(s) inside the comparable band; comparison uses shared points only`);
    });
  }

  const baseline: SpectralBaselineBin[] = comparable ? commonIndices.map((gridIndex) => {
    const powers = powerTable.map((runPowers) => runPowers[gridIndex]!);
    const minPower = Math.min(...powers);
    const maxPower = Math.max(...powers);
    return { frequencyHz: expected[gridIndex], medianPower: median(powers), minPower, maxPower, spreadRatio: maxPower / Math.max(minPower, POWER_EPSILON) };
  }) : [];

  let direction: SpectralDriftDirection | null = null;
  const integratedPower: Array<number | null> = runs.map(() => null);
  if (comparable) {
    runs.forEach((_, runIndex) => { integratedPower[runIndex] = commonIndices.reduce((sum, gridIndex) => sum + powerTable[runIndex][gridIndex]!, 0); });
    const totalChange = trendSlope(integratedPower.map((power) => Math.log(Math.max(power!, POWER_EPSILON)))) * (runs.length - 1);
    const tolerance = Math.log(1 + driftToleranceRatio);
    direction = totalChange > tolerance ? 'increasing' : totalChange < -tolerance ? 'decreasing' : 'flat';
  }

  const abruptIntervals: SpectralAbruptInterval[] = [];
  if (comparable) {
    type MutableInterval = SpectralAbruptInterval & { lastGridIndex: number };
    const intervals: MutableInterval[] = [];
    for (const gridIndex of commonIndices) {
      let bestRatio = 0;
      let bestPair: [string, string] | null = null;
      for (let runIndex = 0; runIndex + 1 < runs.length; runIndex += 1) {
        const before = powerTable[runIndex][gridIndex]!;
        const after = powerTable[runIndex + 1][gridIndex]!;
        const ratio = Math.max(before, after) / Math.max(Math.min(before, after), POWER_EPSILON);
        if (ratio > jumpThresholdRatio && ratio > bestRatio) { bestRatio = ratio; bestPair = [runs[runIndex].runLabel, runs[runIndex + 1].runLabel]; }
      }
      if (!bestPair) continue;
      const frequencyHz = expected[gridIndex];
      const last = intervals.at(-1);
      if (last && gridIndex === last.lastGridIndex + 1) {
        last.endHz = frequencyHz;
        last.lastGridIndex = gridIndex;
        if (bestRatio > last.maxJumpRatio) { last.maxJumpRatio = bestRatio; last.betweenRuns = bestPair; }
      } else {
        intervals.push({ startHz: frequencyHz, endHz: frequencyHz, maxJumpRatio: bestRatio, betweenRuns: bestPair, lastGridIndex: gridIndex });
      }
    }
    abruptIntervals.push(...intervals.map(({ lastGridIndex, ...interval }) => interval));
  }

  const reasons: string[] = [];
  let verdict: SpectralDriftVerdict;
  if (!comparable) {
    verdict = 'not-comparable';
    reasons.push(...incomparable);
  } else {
    if (new Set(runs.map((run) => run.noise.class)).size > 1) reasons.push(`Noise class changes across runs: ${runs.map((run) => `${run.runLabel}=${run.noise.class}`).join(', ')}`);
    const insufficient = runs.filter((run) => run.noise.class === 'insufficient-data').map((run) => run.runLabel);
    if (insufficient.length) reasons.push(`Noise class is insufficient-data for: ${insufficient.join(', ')}`);
    const lowConfidence = runs.filter((run) => run.noise.confidence < LOW_CONFIDENCE_THRESHOLD).map((run) => run.runLabel);
    if (lowConfidence.length) reasons.push(`Noise classification confidence is low for: ${lowConfidence.join(', ')}`);
    const gapped = runs.map((run, runIndex) => ({ runLabel: run.runLabel, missing: missingByRun[runIndex] ?? 0 })).filter((entry) => entry.missing > 0);
    if (gapped.length) reasons.push(`Runs are missing frequency points inside the comparable band: ${gapped.map((entry) => `${entry.runLabel} (${entry.missing})`).join(', ')}`);
    if (direction !== 'flat') reasons.push(`Integrated power trends ${direction} across runs`);
    if (abruptIntervals.length) reasons.push(`Abrupt power changes appear in ${abruptIntervals.length} frequency interval(s)`);
    verdict = reasons.length ? 'needs-review' : 'stable';
    if (!reasons.length) reasons.push('All runs share the same noise class and remain within drift tolerance');
  }

  return {
    inputDigest: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    runCount: runs.length,
    verdict,
    reasons,
    warnings,
    runs: runs.map((run, runIndex) => ({ runLabel: run.runLabel, sampleRateHz: run.sampleRateHz, noise: run.noise, bandIntegratedPower: integratedPower[runIndex], missingBinCount: missingByRun[runIndex] })),
    comparableBandHz: comparable ? { lowHz: expected[commonIndices[0]], highHz: expected[commonIndices.at(-1)!] } : null,
    comparableBinCount: comparable ? commonIndices.length : 0,
    baseline,
    direction,
    abruptIntervals,
  };
}
