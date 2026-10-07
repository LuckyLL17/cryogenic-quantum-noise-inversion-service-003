export type ExperimentKind = 'rabi' | 'ramsey' | 't1' | 't2-echo' | 'randomized-benchmarking' | 'noise-only';
export type ChannelRole = 'readout-i' | 'readout-q' | 'flux' | 'drive-monitor' | 'temperature';
export type SampleQuality = 'good' | 'suspect' | 'invalid';
export type NoiseClass = 'white' | 'flicker' | 'drift' | 'periodic' | 'correlated' | 'insufficient-data';

export type RawSample = {
  captureId: string;
  experimentId: string;
  channelId: string;
  role: ChannelRole;
  triggerId: string;
  timestampNs: number;
  receivedAtNs: number;
  sequence: number;
  sampleRateHz: number;
  i: number;
  q: number;
  gainDb?: number;
  phaseDeg?: number;
  temperatureK?: number;
  quality?: SampleQuality;
};

export type CalibrationProfile = {
  profileId: string;
  channelId: string;
  role?: ChannelRole;
  validFromNs: number;
  validToNs?: number;
  adcScale: number;
  iOffset: number;
  qOffset: number;
  gainCorrection: number;
  phaseCorrectionRad: number;
  temperatureCoefficientPerK: number;
  referenceTemperatureK: number;
  systematicUncertainty: number;
  sampleUncertainty: number;
};

export type SynchronizedSample = RawSample & {
  calibratedI: number;
  calibratedQ: number;
  amplitude: number;
  phaseRad: number;
  uncertainty: number;
  calibrationProfileId: string;
  syncIndex: number;
};

export type WindowedSeries = {
  startNs: number;
  endNs: number;
  sampleRateHz: number;
  values: number[];
  weights: number[];
};

export type SpectrumBin = { frequencyHz: number; power: number; amplitude: number };
export type CrossSpectrumBin = SpectrumBin & { coherence: number; phaseRad: number };

export type DecayFit = {
  model: 'exponential';
  amplitude0: number | null;
  timeConstantNs: number | null;
  offset: number;
  rSquared: number | null;
  usedPoints: number;
  rejectedPoints: number;
  confidence: { lowerNs: number | null; upperNs: number | null };
};

export type NoiseSummary = {
  class: NoiseClass;
  whiteLevel: number;
  lowFrequencySlope: number | null;
  dominantFrequencyHz: number | null;
  integratedPower: number;
  crossChannelCoherence: number | null;
  confidence: number;
};

export type AnalysisRequest = {
  experimentId: string;
  kind: ExperimentKind;
  samples: RawSample[];
  calibrations: CalibrationProfile[];
  primaryChannelId?: string;
  referenceChannelId?: string;
  analysis?: {
    maxFrequencyHz?: number;
    windowSize?: number;
    overlap?: number;
    syncToleranceNs?: number;
    fitStartNs?: number;
    fitEndNs?: number;
    scan?: Array<{ label: string; startNs?: number; endNs?: number; channelId?: string }>;
  };
};

export type ExperimentMetrics = {
  sampleCount: number;
  channelCount: number;
  durationNs: number;
  triggerCount: number;
  droppedSamples: number;
  medianSkewNs: number;
  amplitudeMean: number;
  amplitudeStdDev: number;
  phaseDriftRad: number;
  decay: DecayFit | null;
};

export type AnalysisResult = {
  analysisId: string;
  experimentId: string;
  kind: ExperimentKind;
  inputDigest: string;
  calibrationVersions: string[];
  metrics: ExperimentMetrics;
  primarySpectrum: SpectrumBin[];
  crossSpectrum: CrossSpectrumBin[];
  noise: NoiseSummary;
  scanResults: Array<{ label: string; noise: NoiseSummary; decay: DecayFit | null }>;
  warnings: string[];
};

export type DriftVerdict = 'stable' | 'needs-review' | 'incomparable';

export type DriftRunInput = {
  label: string;
  sampleRateHz: number;
  spectrum: SpectrumBin[];
  crossSpectrum?: CrossSpectrumBin[];
  coherence?: number | null;
};

export type DriftReportRequest = { runs: DriftRunInput[] };

export type DriftAbruptInterval = {
  bandId: 'low-frequency-drift' | 'broadband-white-floor';
  startFrequencyHz: number;
  endFrequencyHz: number;
  binCount: number;
  fromRun: string;
  toRun: string;
  peakDeltaDb: number | null;
  zeroPowerTransition: boolean;
};

export type DriftBandReport = {
  id: 'low-frequency-drift' | 'broadband-white-floor';
  frequencyRangeHz: { start: number; end: number };
  binCount: number;
  baselines: Array<{ run: string; meanPower: number; zeroPowerBins: number[] }>;
  lowFrequencySlopes: Array<{ run: string; slope: number | null }>;
  direction: 'flat' | 'rising' | 'fading';
  monotonic: boolean;
  totalChangeDb: number | null;
  maxAdjacentChangeDb: number | null;
  abruptIntervals: DriftAbruptInterval[];
  stable: boolean;
};

export type DriftPeakReport = {
  applicable: boolean;
  comparable: boolean;
  perRun: Array<{ run: string; dominantFrequencyHz: number | null; power: number | null; prominence: number | null; periodic: boolean }>;
  frequencySpreadHz: number | null;
  reasons: string[];
  stable: boolean;
};

export type DriftCorrelationReport = {
  applicable: boolean;
  comparable: boolean;
  perRun: Array<{ run: string; meanCoherence: number | null; correlated: boolean }>;
  maxDelta: number | null;
  thresholdCrossed: boolean;
  reasons: string[];
  stable: boolean;
};

export type DriftRunAssessment = {
  label: string;
  sampleRateHz: number;
  binCount: number;
  positiveBinCount: number;
  noiseClass: NoiseClass;
  noise: NoiseSummary;
  grid: { spacingHz: number; firstFrequencyHz: number; lastFrequencyHz: number };
  missingFrequencyHz: number[];
};

export type DriftReport = {
  verdict: DriftVerdict;
  runs: DriftRunAssessment[];
  frequencyGrid: {
    comparable: boolean;
    sampleRateHz: number | null;
    spacingHz: number | null;
    sharedPositiveBinCount: number;
    frequencyRangeHz: { start: number; end: number } | null;
    completeCoverage: boolean;
  };
  bands: DriftBandReport[];
  peak: DriftPeakReport | null;
  correlation: DriftCorrelationReport | null;
  abruptIntervals: DriftAbruptInterval[];
  reasons: string[];
  warnings: string[];
  conclusion: string;
};
