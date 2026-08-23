/**
 * Provider-independent validation + normalization of AI detection output.
 *
 * Model output is UNTRUSTED. Everything that reaches the rest of the backend
 * passes through here first. The rules are deliberately conservative:
 *
 *   - nothing is ever invented (no default device, no default confidence)
 *   - anything unusable is DROPPED and explained in `warnings`
 *   - anything slightly out of range is CLAMPED and explained in `warnings`
 *
 * This file must contain no provider-specific knowledge. Each provider is
 * responsible for mapping its own coordinate convention (e.g. Gemini's
 * `box_2d` ordering) into the neutral `{ x, y, width, height }` fractions this
 * module expects; this module decides whether those numbers can be trusted.
 */

import {
  DetectedComponent,
  DetectedDevice,
  DetectionResult,
  NormalizedBox,
  RawProviderDetection,
  RawStepVerification,
  StepObservation
} from '../../types/ai';

/** Hard ceilings so a runaway model response cannot bloat a response payload. */
const MAX_COMPONENTS = 40;
const MAX_TEXT_LENGTH = 120;
/** Observations are shown to a technician mid-repair; a handful is plenty. */
const MAX_OBSERVATIONS = 8;
const MAX_OBSERVATION_LENGTH = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Returns a trimmed, length-capped string, or null if there is no usable text. */
const readText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TEXT_LENGTH ? trimmed.slice(0, MAX_TEXT_LENGTH) : trimmed;
};

const readFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Confidence is expected as a 0..1 fraction. A 0..100 percentage is accepted
 * (models frequently emit one) and rescaled. Anything else is unusable.
 */
const readConfidence = (value: unknown): number | null => {
  const parsed = readFiniteNumber(value);
  if (parsed === null || parsed < 0) return null;
  if (parsed <= 1) return parsed;
  if (parsed <= 100) return parsed / 100;
  return null;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

interface BoxOutcome {
  box: NormalizedBox | null;
  clamped: boolean;
}

/**
 * Accepts `{ x, y, width, height }` or `[x, y, width, height]`, each already
 * expressed as a 0..1 fraction of the frame.
 */
const readBox = (value: unknown): BoxOutcome => {
  let rawX: unknown;
  let rawY: unknown;
  let rawWidth: unknown;
  let rawHeight: unknown;

  if (Array.isArray(value) && value.length === 4) {
    [rawX, rawY, rawWidth, rawHeight] = value;
  } else if (isRecord(value)) {
    rawX = value.x;
    rawY = value.y;
    rawWidth = value.width;
    rawHeight = value.height;
  } else {
    return { box: null, clamped: false };
  }

  const x = readFiniteNumber(rawX);
  const y = readFiniteNumber(rawY);
  const width = readFiniteNumber(rawWidth);
  const height = readFiniteNumber(rawHeight);

  if (x === null || y === null || width === null || height === null) {
    return { box: null, clamped: false };
  }
  // A zero-area or inverted box carries no information.
  if (width <= 0 || height <= 0) {
    return { box: null, clamped: false };
  }

  const clampedX = clamp01(x);
  const clampedY = clamp01(y);
  // Keep the box inside the frame rather than letting it overflow the render.
  const clampedWidth = Math.min(width, 1 - clampedX);
  const clampedHeight = Math.min(height, 1 - clampedY);

  if (clampedWidth <= 0 || clampedHeight <= 0) {
    return { box: null, clamped: false };
  }

  const clamped =
    clampedX !== x || clampedY !== y || clampedWidth !== width || clampedHeight !== height;

  return {
    box: { x: clampedX, y: clampedY, width: clampedWidth, height: clampedHeight },
    clamped
  };
};

const normalizeDevice = (value: unknown, warnings: string[]): DetectedDevice | null => {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    warnings.push('Device was ignored: expected an object.');
    return null;
  }

  const type = readText(value.type) ?? readText(value.deviceType);
  if (!type) {
    warnings.push('Device was ignored: no device type reported.');
    return null;
  }

  const confidence = readConfidence(value.confidence);
  if (confidence === null) {
    // Confidence is never invented, so an unusable value means the whole
    // identification has to go.
    warnings.push(`Device "${type}" was ignored: missing or invalid confidence.`);
    return null;
  }

  const device: DetectedDevice = { type, confidence };

  const brand = readText(value.brand);
  if (brand) device.brand = brand;

  const model = readText(value.model);
  if (model) device.model = model;

  return device;
};

const normalizeComponents = (value: unknown, warnings: string[]): DetectedComponent[] => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push('Components were ignored: expected an array.');
    return [];
  }

  const components: DetectedComponent[] = [];
  let droppedCount = 0;
  let clampedCount = 0;

  for (const entry of value) {
    if (components.length >= MAX_COMPONENTS) {
      warnings.push(`Only the first ${MAX_COMPONENTS} components were kept.`);
      break;
    }

    if (!isRecord(entry)) {
      droppedCount++;
      continue;
    }

    const name = readText(entry.name) ?? readText(entry.label);
    const confidence = readConfidence(entry.confidence);
    const { box, clamped } = readBox(entry.boundingBox ?? entry.box ?? entry.bbox);

    if (!name || confidence === null || !box) {
      droppedCount++;
      continue;
    }
    if (clamped) clampedCount++;

    components.push({ name, confidence, boundingBox: box });
  }

  if (droppedCount > 0) {
    warnings.push(
      `${droppedCount} component${droppedCount === 1 ? '' : 's'} dropped: missing name, confidence, or a usable bounding box.`
    );
  }
  if (clampedCount > 0) {
    warnings.push(
      `${clampedCount} bounding box${clampedCount === 1 ? '' : 'es'} clamped to the frame.`
    );
  }

  return components;
};

/**
 * Turn raw provider output into the single detection shape the backend trusts.
 * Never throws — an unusable response becomes an empty result plus warnings.
 */
export const normalizeDetection = (
  raw: RawProviderDetection,
  source: string,
  initialWarnings: string[] = []
): DetectionResult => {
  const warnings = [...initialWarnings];

  if (!isRecord(raw)) {
    warnings.push('AI response was not a usable object; no detections were returned.');
    return { device: null, components: [], source, warnings };
  }

  const device = normalizeDevice(raw.device, warnings);
  const components = normalizeComponents(raw.components, warnings);

  return { device, components, source, warnings };
};

/** Empty result helper so callers never have to build a DetectionResult by hand. */
export const emptyDetection = (source: string, warnings: string[] = []): DetectionResult => ({
  device: null,
  components: [],
  source,
  warnings
});

/**
 * Read a completion verdict WITHOUT ever guessing "true".
 *
 * This is the single most safety-critical read in the AI layer: a false
 * positive here would advance a technician past a step they have not actually
 * finished — potentially past a high-risk step such as "disconnect the battery
 * before touching the board". So only an explicit, unambiguous affirmative
 * counts, and anything unreadable resolves to false.
 */
const readCompletionFlag = (value: unknown): { completed: boolean; usable: boolean } => {
  if (typeof value === 'boolean') return { completed: value, usable: true };

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes' || normalized === 'completed') {
      return { completed: true, usable: true };
    }
    if (normalized === 'false' || normalized === 'no' || normalized === 'not_completed') {
      return { completed: false, usable: true };
    }
  }

  return { completed: false, usable: false };
};

const normalizeObservations = (value: unknown, warnings: string[]): string[] => {
  if (value === null || value === undefined) return [];

  // A single string is a common model shortcut; accept it as one observation.
  const entries = Array.isArray(value) ? value : [value];

  const observations: string[] = [];
  let dropped = 0;

  for (const entry of entries) {
    if (observations.length >= MAX_OBSERVATIONS) {
      warnings.push(`Only the first ${MAX_OBSERVATIONS} observations were kept.`);
      break;
    }
    if (typeof entry !== 'string' || !entry.trim()) {
      dropped++;
      continue;
    }
    const trimmed = entry.trim();
    observations.push(
      trimmed.length > MAX_OBSERVATION_LENGTH ? trimmed.slice(0, MAX_OBSERVATION_LENGTH) : trimmed
    );
  }

  if (dropped > 0) {
    warnings.push(`${dropped} observation${dropped === 1 ? '' : 's'} dropped: not usable text.`);
  }

  return observations;
};

/**
 * Collect the provider's OWN warnings (the prompt asks for things like "the
 * component is out of frame"). These are evidence a technician should see, so
 * they must not be dropped. Validated as text and capped; a single string is
 * accepted. Returns the strings to append to the observation's warnings.
 */
const readProviderWarnings = (value: unknown): string[] => {
  if (value === null || value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];

  const result: string[] = [];
  for (const entry of entries) {
    if (result.length >= MAX_OBSERVATIONS) break;
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const trimmed = entry.trim();
    result.push(
      trimmed.length > MAX_OBSERVATION_LENGTH ? trimmed.slice(0, MAX_OBSERVATION_LENGTH) : trimmed
    );
  }
  return result;
};

/**
 * Turn raw provider step-verification output into a validated StepObservation.
 *
 * Never throws. An unusable response becomes a fail-closed observation
 * (`stepCompleted: false`, `confidence: null`) plus warnings, which the
 * deterministic evaluator will read as "do not advance".
 */
export const normalizeStepObservation = (
  raw: RawStepVerification,
  source: string,
  initialWarnings: string[] = []
): StepObservation => {
  const warnings = [...initialWarnings];

  if (!isRecord(raw)) {
    warnings.push('AI response was not a usable object; step completion could not be evaluated.');
    return { stepCompleted: false, confidence: null, observations: [], components: [], source, warnings };
  }

  const { completed, usable } = readCompletionFlag(raw.stepCompleted ?? raw.step_completed);
  if (!usable) {
    warnings.push('AI did not report a readable step completion verdict; treated as not completed.');
  }

  const confidence = readConfidence(raw.confidence);
  if (confidence === null) {
    warnings.push('AI did not report a usable confidence value.');
  }

  const observations = normalizeObservations(raw.observations ?? raw.notes, warnings);
  const components = normalizeComponents(raw.components ?? raw.visibleComponents, warnings);

  // The provider's own warnings are evidence, not noise — carry them through
  // rather than letting only the normalizer's validation notes survive.
  for (const providerWarning of readProviderWarnings(raw.warnings)) {
    warnings.push(providerWarning);
  }

  return { stepCompleted: completed, confidence, observations, components, source, warnings };
};

/**
 * Fail-closed observation helper, for when no evidence could be gathered at all
 * (provider error, timeout, unusable frame).
 */
export const emptyStepObservation = (source: string, warnings: string[] = []): StepObservation => ({
  stepCompleted: false,
  confidence: null,
  observations: [],
  components: [],
  source,
  warnings
});
