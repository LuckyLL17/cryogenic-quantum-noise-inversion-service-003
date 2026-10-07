import { invariant } from '../errors.ts';
import { lowFrequencySlope, summarizeNoise } from './classify.ts';
import type {
  CrossSpectrumBin,
  DriftAbruptInterval,
  DriftBandReport,
  DriftCorrelationReport,
  DriftPeakReport,
  DriftReport,
  DriftReportRequest,
  DriftRunAssessment,
  DriftRunInput,
  DriftVerdict,
  NoiseClass,
  NoiseSummary,
  SpectrumBin,
} from '../types.ts';

const GRID_TOLERANCE = 1e-6;
const LOW_FRACTION = 0.1;
const WHITE_FRACTION = 0.2;
const POWER_CHANGE_DB_STABLE = 3;
const ABRUPT_DB_THRESHOLD = 6;
const COHERENCE_STABLE_DELTA = 0.1;
const CORRELATED_THRESHOLD = 0.7;
const PEAK_BIN_TOLERANCE = 1;

type PreparedRun = {
  label: string;
  sampleRateHz: number;
  spectrum: SpectrumBin[];
  byIndex: Map<number, SpectrumBin>;
  spacingHz: number;
  positiveIndices: number[];
  missingFrequencyHz: number[];
  coherence: number | null;
  crossByIndex: Map<number, CrossSpectrumBin> | null;
  noise: NoiseSummary;
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateBin(bin: SpectrumBin, runIndex: number, binIndex: number): void {
  invariant(finite(bin.frequencyHz) && bin.frequencyHz >= 0, 'INVALID_BIN_FREQUENCY', 'Spectrum bin frequency must be finite and non-negative', { runIndex, binIndex });
  invariant(finite(bin.power) && bin.power >= 0, 'INVALID_BIN_POWER', 'Spectrum bin power must be finite and non-negative', { runIndex, binIndex });
  invariant(finite(bin.amplitude) && bin.amplitude >= 0, 'INVALID_BIN_AMPLITUDE', 'Spectrum bin amplitude must be finite and non-negative', { runIndex, binIndex });
}

function prepareRun(input: DriftRunInput, runIndex: number, seenLabels: Set<string>): PreparedRun {
  invariant(input && typeof input === 'object', 'INVALID_RUN', 'Each run must be an object', { runIndex });
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  invariant(label.length > 0, 'INVALID_RUN_LABEL', 'Every run requires a non-empty label', { runIndex });
  invariant(!seenLabels.has(label), 'DUPLICATE_RUN_LABEL', 'Run labels must be unique', { label });
  seenLabels.add(label);
  invariant(finite(input.sampleRateHz) && input.sampleRateHz > 0, 'INVALID_RUN_SAMPLE_RATE', 'Run sample rate must be positive', { label });
  invariant(Array.isArray(input.spectrum) && input.spectrum.length >= 2, 'EMPTY_RUN_SPECTRUM', 'Run spectrum must contain at least two bins', { label });
  const spectrum = input.spectrum.map((bin) => ({ frequencyHz: bin.frequencyHz, power: bin.power, amplitude: bin.amplitude }));
  spectrum.forEach((bin, binIndex) => validateBin(bin, runIndex, binIndex));
  for (let index = 1; index < spectrum.length; index += 1) {
    invariant(spectrum[index].frequencyHz > spectrum[index - 1].frequencyHz, 'UNSORTED_SPECTRUM', 'Spectrum bins must be strictly ordered by frequency', { label, binIndex: index });
  }
  const deltas = spectrum.slice(1).map((bin, index) => bin.frequencyHz - spectrum[index].frequencyHz);
  const spacingHz = Math.min(...deltas);
  invariant(spacingHz > 0, 'INVALID_GRID_SPACING', 'Frequency grid spacing must be positive', { label });
  for (let index = 1; index < spectrum.length; index += 1) {
    const ratio = deltas[index - 1] / spacingHz;
    invariant(Math.abs(ratio - Math.round(ratio)) <= GRID_TOLERANCE * 2 + 1e-9 && Math.round(ratio) >= 1, 'NON_UNIFORM_GRID', 'Spectrum frequency grid must lie on a uniform spacing (interior gaps are reported as missing bins)', { label, binIndex: index });
  }
  const firstIndex = Math.round(spectrum[0].frequencyHz / spacingHz);
  invariant(Math.abs(firstIndex * spacingHz - spectrum[0].frequencyHz) <= GRID_TOLERANCE + GRID_TOLERANCE * Math.abs(firstIndex * spacingHz), 'GRID_NOT_ALIGNED', 'Spectrum grid must align to integer multiples of its spacing', { label });
  spectrum.forEach((bin) => {
    const index = Math.round(bin.frequencyHz / spacingHz);
    invariant(Math.abs(index * spacingHz - bin.frequencyHz) <= GRID_TOLERANCE + GRID_TOLERANCE * Math.abs(index * spacingHz), 'GRID_NOT_ALIGNED', 'Spectrum bins must align to integer multiples of the grid spacing', { label, frequencyHz: bin.frequencyHz });
  });
  const lastIndex = Math.round(spectrum.at(-1)!.frequencyHz / spacingHz);
  const nFromRate = input.sampleRateHz / spacingHz;
  invariant(Number.isInteger(Math.round(nFromRate)) && Math.abs(nFromRate - Math.round(nFromRate)) <= GRID_TOLERANCE * 2 + 1e-9, 'GRID_RATE_MISMATCH', 'Sample rate is not consistent with the frequency grid spacing', { label, sampleRateHz: input.sampleRateHz, spacingHz });
  invariant(spectrum.at(-1)!.frequencyHz * 2 <= input.sampleRateHz + GRID_TOLERANCE, 'GRID_ABOVE_NYQUIST', 'Spectrum contains bins above the Nyquist frequency', { label });
  const byIndex = new Map<number, SpectrumBin>();
  for (const bin of spectrum) {
    const index = Math.round(bin.frequencyHz / spacingHz);
    invariant(!byIndex.has(index), 'DUPLICATE_SPECTRUM_BIN', 'Spectrum contains duplicate frequency bins', { label, frequencyHz: bin.frequencyHz });
    byIndex.set(index, bin);
  }
  const positiveIndices = [...byIndex.keys()].filter((index) => index > 0).sort((a, b) => a - b);
  invariant(positiveIndices.length >= 2, 'INSUFFICIENT_POSITIVE_BINS', 'Run spectrum needs at least two positive-frequency bins', { label });
  const missingFrequencyHz: number[] = [];
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    if (!byIndex.has(index)) missingFrequencyHz.push(index * spacingHz);
  }

  let coherence: number | null = input.coherence === undefined || input.coherence === null ? null : input.coherence;
  if (coherence !== null) invariant(finite(coherence) && coherence >= 0 && coherence <= 1, 'INVALID_COHERENCE', 'Run coherence must be within [0, 1]', { label });
  let crossByIndex: Map<number, CrossSpectrumBin> | null = null;
  if (input.crossSpectrum !== undefined) {
    invariant(Array.isArray(input.crossSpectrum) && input.crossSpectrum.length > 0, 'EMPTY_CROSS_SPECTRUM', 'Cross-spectrum declared for a run must not be empty', { label });
    input.crossSpectrum.forEach((bin, binIndex) => {
      invariant(finite(bin.frequencyHz) && bin.frequencyHz >= 0, 'INVALID_CROSS_BIN_FREQUENCY', 'Cross-spectrum bin frequency must be finite and non-negative', { label, binIndex });
      invariant(finite(bin.coherence) && bin.coherence >= 0 && bin.coherence <= 1, 'INVALID_CROSS_COHERENCE', 'Cross-spectrum coherence must be within [0, 1]', { label, binIndex });
    });
    crossByIndex = new Map();
    for (const bin of input.crossSpectrum) {
      const index = Math.round(bin.frequencyHz / spacingHz);
      invariant(Math.abs(index * spacingHz - bin.frequencyHz) <= GRID_TOLERANCE + GRID_TOLERANCE * Math.abs(index * spacingHz), 'CROSS_BIN_OFF_GRID', 'Cross-spectrum bins must align with the spectrum grid spacing', { label, frequencyHz: bin.frequencyHz });
      invariant(byIndex.has(index), 'CROSS_BIN_NO_MATCH', 'Cross-spectrum bins must align with spectrum grid frequencies', { label, frequencyHz: bin.frequencyHz });
      invariant(!crossByIndex.has(index), 'DUPLICATE_CROSS_BIN', 'Cross-spectrum contains duplicate frequency bins', { label, frequencyHz: bin.frequencyHz });
      crossByIndex.set(index, bin);
    }
    if (coherence === null) coherence = input.crossSpectrum.reduce((sum, bin) => sum + bin.coherence, 0) / input.crossSpectrum.length;
  }

  const ordered = [...spectrum].sort((a, b) => a.frequencyHz - b.frequencyHz);
  const noise = summarizeNoise(ordered, coherence);
  return { label, sampleRateHz: input.sampleRateHz, spectrum: ordered, byIndex, spacingHz, positiveIndices, missingFrequencyHz, coherence, crossByIndex, noise };
}

function relativeGrid(value: number, reference: number): boolean {
  return Math.abs(value - reference) <= GRID_TOLERANCE + GRID_TOLERANCE * Math.abs(reference);
}

function baselineDbChange(from: number, to: number): number | null {
  if (from <= 0 || to <= 0) return null;
  return 10 * Math.log10(to / from);
}

function assessRuns(runs: PreparedRun[]): DriftRunAssessment[] {
  return runs.map((run) => ({
    label: run.label,
    sampleRateHz: run.sampleRateHz,
    binCount: run.spectrum.length,
    positiveBinCount: run.positiveIndices.length,
    noiseClass: run.noise.class,
    noise: run.noise,
    grid: { spacingHz: run.spacingHz, firstFrequencyHz: run.spectrum[0].frequencyHz, lastFrequencyHz: run.spectrum.at(-1)!.frequencyHz },
    missingFrequencyHz: run.missingFrequencyHz,
  }));
}

function incomparableReport(runs: PreparedRun[], reasons: string[], spacingHz: number | null, sharedCount: number): DriftReport {
  const warnings: string[] = [];
  if ([...new Set(runs.map((run) => run.noise.class))].length > 1) warnings.push('Noise class is not consistent across runs');
  return {
    verdict: 'incomparable',
    runs: assessRuns(runs),
    frequencyGrid: { comparable: false, sampleRateHz: runs.every((run) => relativeGrid(run.sampleRateHz, runs[0].sampleRateHz)) ? runs[0].sampleRateHz : null, spacingHz, sharedPositiveBinCount: sharedCount, frequencyRangeHz: null, completeCoverage: false },
    bands: [],
    peak: null,
    correlation: null,
    abruptIntervals: [],
    reasons,
    warnings,
    conclusion: 'Runs were not compared: frequency grids are incompatible, so no shared band statistics were computed.',
  };
}

function buildBand(id: DriftBandReport['id'], shared: number[], runs: PreparedRun[]): DriftBandReport {
  const selected = id === 'low-frequency-drift'
    ? shared.slice(0, Math.max(1, Math.floor(shared.length * LOW_FRACTION)))
    : shared.slice(-Math.max(1, Math.floor(shared.length * WHITE_FRACTION)));
  const baselines = runs.map((run) => {
    const present = selected.map((index) => run.byIndex.get(index)!).filter((bin) => bin.power > 0);
    return {
      run: run.label,
      meanPower: present.length ? present.reduce((sum, bin) => sum + bin.power, 0) / present.length : 0,
      zeroPowerBins: selected.filter((index) => run.byIndex.get(index)!.power <= 0).map((index) => index * run.spacingHz),
    };
  });
  const lowFrequencySlopes = runs.map((run) => ({ run: run.label, slope: lowFrequencySlope(selected.map((index) => run.byIndex.get(index)!)) }));
  const changes = baselines.slice(1).map((entry, pairIndex) => ({ from: baselines[pairIndex], to: entry, db: baselineDbChange(baselines[pairIndex].meanPower, entry.meanPower) }));
  const finiteChanges = changes.map((change) => change.db).filter((value): value is number => value !== null);
  const totalChangeDb = baselines[0].meanPower > 0 && baselines.at(-1)!.meanPower > 0 ? 10 * Math.log10(baselines.at(-1)!.meanPower / baselines[0].meanPower) : null;
  const rising = finiteChanges.length > 0 && finiteChanges.every((db) => db > 0.5);
  const fading = finiteChanges.length > 0 && finiteChanges.every((db) => db < -0.5);
  const direction: DriftBandReport['direction'] = rising ? 'rising' : fading ? 'fading' : 'flat';
  const monotonic = finiteChanges.length === changes.length && finiteChanges.length > 0 && finiteChanges.every((db) => Math.sign(db) === Math.sign(finiteChanges[0]));
  const maxAdjacentChangeDb = finiteChanges.length ? Math.max(...finiteChanges.map((db) => Math.abs(db))) : null;

  const abruptIntervals: DriftAbruptInterval[] = [];
  for (let runIndex = 1; runIndex < runs.length; runIndex += 1) {
    const previous = runs[runIndex - 1];
    const current = runs[runIndex];
    let group: { indices: number[]; peak: number | null; zeroPowerTransition: boolean } | null = null;
    const flush = () => {
      if (!group || group.indices.length === 0) return;
      const first = group.indices[0] * runs[0].spacingHz;
      const lastIndex = group.indices.at(-1)!;
      abruptIntervals.push({ bandId: id, startFrequencyHz: first, endFrequencyHz: (lastIndex + 1) * runs[0].spacingHz, binCount: group.indices.length, fromRun: previous.label, toRun: current.label, peakDeltaDb: group.peak, zeroPowerTransition: group.zeroPowerTransition });
      group = null;
    };
    for (let position = 0; position < selected.length; position += 1) {
      const index = selected[position];
      const before = previous.byIndex.get(index)!;
      const after = current.byIndex.get(index)!;
      const db = baselineDbChange(before.power, after.power);
      const isAbrupt = before.power <= 0 || after.power <= 0 || db !== null && Math.abs(db) >= ABRUPT_DB_THRESHOLD;
      const contiguous = position > 0 && selected[position - 1] === index - 1;
      if (!isAbrupt) { flush(); continue; }
      if (!group || !contiguous) { flush(); group = { indices: [], peak: null, zeroPowerTransition: false }; }
      group.indices.push(index);
      group.peak = db === null ? group.peak : group.peak === null ? Math.abs(db) : Math.max(group.peak, Math.abs(db));
      if (before.power <= 0 || after.power <= 0) group.zeroPowerTransition = true;
    }
    flush();
  }

  const measuredSlopes = lowFrequencySlopes.map((entry) => entry.slope).filter((value): value is number => value !== null);
  const slopeStable = measuredSlopes.every((value) => Math.abs(value - measuredSlopes[0]) < 0.2);

  const stable = abruptIntervals.length === 0
    && (maxAdjacentChangeDb === null || maxAdjacentChangeDb < POWER_CHANGE_DB_STABLE)
    && (totalChangeDb === null || Math.abs(totalChangeDb) < POWER_CHANGE_DB_STABLE)
    && baselines.every((entry) => entry.zeroPowerBins.length === 0)
    && (id !== 'low-frequency-drift' || slopeStable);

  return {
    id,
    frequencyRangeHz: { start: selected[0] * runs[0].spacingHz, end: (selected.at(-1)! + 1) * runs[0].spacingHz },
    binCount: selected.length,
    baselines,
    lowFrequencySlopes,
    direction,
    monotonic,
    totalChangeDb,
    maxAdjacentChangeDb,
    abruptIntervals,
    stable,
  };
}

function buildPeakReport(runs: PreparedRun[], shared: number[]): DriftPeakReport {
  const sharedSet = new Set(shared);
  const perRun = runs.map((run) => {
    const dominantFrequencyHz = run.noise.dominantFrequencyHz;
    const bin = dominantFrequencyHz === null ? undefined : run.byIndex.get(Math.round(dominantFrequencyHz / run.spacingHz));
    const power = bin ? bin.power : null;
    const whitePresent = shared.map((index) => run.byIndex.get(index)!).filter((item) => item.power > 0);
    const whiteLevel = whitePresent.slice(-Math.max(1, Math.floor(whitePresent.length / 5))).reduce((sum, item) => sum + item.power, 0) / Math.max(1, Math.floor(whitePresent.length / 5));
    const prominence = power !== null && whiteLevel > 0 ? power / whiteLevel : null;
    const onSharedGrid = dominantFrequencyHz === null || sharedSet.has(Math.round(dominantFrequencyHz / run.spacingHz));
    return { run: run.label, dominantFrequencyHz, power, prominence, periodic: run.noise.class === 'periodic', onSharedGrid };
  });
  const applicable = perRun.some((entry) => entry.periodic && entry.prominence !== null && entry.prominence >= 8);
  const base = perRun.map((entry) => ({ run: entry.run, dominantFrequencyHz: entry.dominantFrequencyHz, power: entry.power, prominence: entry.prominence, periodic: entry.periodic }));
  if (!applicable) return { applicable: false, comparable: true, perRun: base, frequencySpreadHz: null, reasons: [], stable: true };
  const reasons: string[] = [];
  const comparable = perRun.every((entry) => entry.onSharedGrid);
  if (!comparable) reasons.push('peak-outside-shared-band');
  const frequencies = perRun.map((entry) => entry.dominantFrequencyHz).filter((value): value is number => value !== null);
  const frequencySpreadHz = frequencies.length ? Math.max(...frequencies) - Math.min(...frequencies) : null;
  if (comparable && frequencySpreadHz !== null && frequencySpreadHz > PEAK_BIN_TOLERANCE * runs[0].spacingHz) reasons.push('narrowband-peak-frequency-shift');
  const prominences = perRun.map((entry) => entry.prominence).filter((value): value is number => value !== null);
  if (prominences.length >= 2) {
    const prominenceSpread = Math.max(...prominences) / Math.min(...prominences);
    if (prominenceSpread > 2) reasons.push('narrowband-peak-prominence-change');
  }
  if (perRun.some((entry) => entry.periodic) && perRun.some((entry) => !entry.periodic)) reasons.push('periodic-classification-changes');
  return { applicable: true, comparable, perRun: base, frequencySpreadHz, reasons, stable: comparable && reasons.length === 0 };
}

function buildCorrelationReport(runs: PreparedRun[], shared: number[]): DriftCorrelationReport {
  const perRun = runs.map((run) => {
    let meanCoherence: number | null = run.coherence;
    if (run.crossByIndex) {
      const bins = shared.map((index) => run.crossByIndex!.get(index)).filter((bin): bin is CrossSpectrumBin => bin !== undefined);
      meanCoherence = bins.length ? bins.reduce((sum, bin) => sum + bin.coherence, 0) / bins.length : null;
    }
    return { run: run.label, meanCoherence, correlated: meanCoherence !== null && meanCoherence >= CORRELATED_THRESHOLD };
  });
  const measured = perRun.filter((entry) => entry.meanCoherence !== null);
  if (measured.length === 0) return { applicable: false, comparable: true, perRun, maxDelta: null, thresholdCrossed: false, reasons: [], stable: true };
  const reasons: string[] = [];
  if (measured.length < runs.length) reasons.push('correlation-missing-for-some-runs');
  const comparable = measured.length === runs.length;
  const values = measured.map((entry) => entry.meanCoherence!);
  const maxDelta = Math.max(...values) - Math.min(...values);
  const thresholdCrossed = measured.some((entry) => entry.correlated) && measured.some((entry) => !entry.correlated);
  if (thresholdCrossed) reasons.push('correlation-threshold-crossing');
  if (maxDelta > COHERENCE_STABLE_DELTA) reasons.push('coherence-drift-exceeds-threshold');
  return { applicable: true, comparable, perRun, maxDelta, thresholdCrossed, reasons, stable: comparable && reasons.length === 0 };
}

export function buildDriftReport(request: DriftReportRequest): DriftReport {
  invariant(request && typeof request === 'object' && Array.isArray(request.runs), 'INVALID_DRIFT_REQUEST', 'Drift report requires a runs array');
  invariant(request.runs.length >= 2, 'NOT_ENOUGH_RUNS', 'At least two runs are required to compare spectra');
  const seenLabels = new Set<string>();
  const runs = request.runs.map((run, index) => prepareRun(run, index, seenLabels));

  const first = runs[0];
  if (!runs.every((run) => relativeGrid(run.sampleRateHz, first.sampleRateHz))) {
    return incomparableReport(runs, ['sample-rate-mismatch'], null, 0);
  }
  if (!runs.every((run) => relativeGrid(run.spacingHz, first.spacingHz))) {
    return incomparableReport(runs, ['frequency-grid-spacing-mismatch'], null, 0);
  }
  let shared = first.positiveIndices;
  for (const run of runs.slice(1)) shared = shared.filter((index) => run.byIndex.has(index));
  if (shared.length < 2) {
    return incomparableReport(runs, ['insufficient-overlapping-bins'], first.spacingHz, shared.length);
  }

  const completeCoverage = runs.every((run) => run.positiveIndices.length === shared.length && run.missingFrequencyHz.length === 0);
  const bands: DriftBandReport[] = [
    buildBand('low-frequency-drift', shared, runs),
    buildBand('broadband-white-floor', shared, runs),
  ];
  const peak = buildPeakReport(runs, shared);
  const correlation = buildCorrelationReport(runs, shared);
  const abruptIntervals = bands.flatMap((band) => band.abruptIntervals);

  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!completeCoverage) {
    reasons.push('missing-frequency-bins');
    warnings.push('Comparison restricted to bins present in every run; missing bins were not interpolated or mixed');
  }
  for (const run of runs) {
    if (run.missingFrequencyHz.length) warnings.push(`Run ${run.label} omits ${run.missingFrequencyHz.length} grid bins`);
  }
  for (const band of bands) {
    if (band.abruptIntervals.length) reasons.push('abrupt-power-interval');
    if (band.maxAdjacentChangeDb !== null && band.maxAdjacentChangeDb >= POWER_CHANGE_DB_STABLE) reasons.push('baseline-change-exceeds-threshold');
    if (band.baselines.some((entry) => entry.zeroPowerBins.length > 0)) reasons.push('zero-power-bin');
    if (!band.stable && !band.abruptIntervals.length && (band.maxAdjacentChangeDb === null || band.maxAdjacentChangeDb < POWER_CHANGE_DB_STABLE) && !band.baselines.some((entry) => entry.zeroPowerBins.length > 0)) reasons.push('low-frequency-slope-change');
  }
  if (!peak.stable) reasons.push(...peak.reasons);
  if (!correlation.stable) reasons.push(...correlation.reasons);

  const classes: NoiseClass[] = [...new Set(runs.map((run) => run.noise.class))];
  if (classes.length > 1) {
    reasons.push('noise-class-change');
    warnings.push(`Noise class changes across runs: ${classes.join(' -> ')}`);
  }

  const verdict: DriftVerdict = reasons.length ? 'needs-review' : 'stable';
  const uniqueReasons = [...new Set(reasons)];
  const conclusion = verdict === 'stable'
    ? `All ${runs.length} runs share an identical frequency grid and stay within stability thresholds across the comparable ${shared.length} positive-frequency bins.`
    : `Compared on ${shared.length} shared positive-frequency bins; ${uniqueReasons.length} issue(s) require manual review before the runs can be called stable.`;

  return {
    verdict,
    runs: assessRuns(runs),
    frequencyGrid: { comparable: true, sampleRateHz: first.sampleRateHz, spacingHz: first.spacingHz, sharedPositiveBinCount: shared.length, frequencyRangeHz: { start: shared[0] * first.spacingHz, end: (shared.at(-1)! + 1) * first.spacingHz }, completeCoverage },
    bands,
    peak,
    correlation,
    abruptIntervals,
    reasons: uniqueReasons,
    warnings,
    conclusion,
  };
}
