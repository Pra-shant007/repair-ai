/**
 * Provider-independent AI detection contract.
 *
 * IMPORTANT: nothing in this file may reference Gemini, OpenCV, YOLO or any
 * other specific model or SDK. Provider-specific response shapes and
 * coordinate conventions must stay inside their own provider module so the
 * detection model can be replaced without touching controllers or models.
 */

/**
 * Bounding box in normalized, resolution-independent coordinates.
 * All four values are fractions of the frame in the range 0..1, so the client
 * can render the box over any camera or image size.
 */
export interface NormalizedBox {
  /** Left edge as a fraction of frame width (0..1). */
  x: number;
  /** Top edge as a fraction of frame height (0..1). */
  y: number;
  /** Width as a fraction of frame width (0..1). */
  width: number;
  /** Height as a fraction of frame height (0..1). */
  height: number;
}

export interface DetectedDevice {
  /** Broad category, e.g. 'laptop', 'smartphone', 'router'. */
  type: string;
  brand?: string;
  model?: string;
  /** 0..1. Never fabricated — see normalizer. */
  confidence: number;
}

export interface DetectedComponent {
  name: string;
  /** 0..1. Never fabricated — see normalizer. */
  confidence: number;
  boundingBox: NormalizedBox;
}

/**
 * The normalized result every provider must ultimately produce.
 * This is the only detection shape the rest of the backend should consume.
 */
export interface DetectionResult {
  /**
   * null when the provider could not identify a device.
   * A device is never invented to fill this in.
   */
  device: DetectedDevice | null;
  components: DetectedComponent[];
  /** Which provider produced this result, e.g. 'gemini' or 'mock'. */
  source: string;
  /** Non-fatal validation notes: dropped components, clamped coordinates, etc. */
  warnings: string[];
}

/**
 * An image handed to a provider.
 * `data` is raw base64 with no data-URL prefix.
 */
export interface ProviderImage {
  data: string;
  mimeType: string;
}

/**
 * Raw, UNTRUSTED provider output.
 * Must always be passed through the normalizer before use.
 */
export type RawProviderDetection = unknown;

export interface AnalyzeFrameInput {
  image: ProviderImage;
  /**
   * Optional hint only, used to focus the prompt on relevant components.
   * It is never used to fabricate a scenario or repair procedure.
   */
  scenarioId?: string;
}

/**
 * The single predefined repair step a provider is asked to evaluate.
 *
 * Only the current step is described — never the whole scenario. The provider's
 * job is to report visual evidence about THIS step, not to reason about the
 * repair as a whole and certainly not to decide what comes next.
 */
export interface VerifyStepContext {
  stepIndex: number;
  stepTitle?: string;
  verificationTrigger?: string;
  safetyRisk?: 'safe' | 'medium' | 'high';
}

export interface VerifyStepInput {
  image: ProviderImage;
  step: VerifyStepContext;
  scenarioId?: string;
}

/**
 * Raw, UNTRUSTED step verification output.
 * Must always be passed through the normalizer before use.
 */
export type RawStepVerification = unknown;

/**
 * Validated visual evidence about one predefined repair step.
 *
 * This is deliberately an OBSERVATION, not a decision. It reports what the
 * vision layer claims to see; whether the repair advances is decided
 * separately and deterministically by services/repairStepService.ts.
 *
 * It therefore contains no step title, no instruction, and no next step — a
 * provider must never be able to influence which instruction the user is shown.
 */
export interface StepObservation {
  /**
   * The provider's raw verdict. Never defaulted to true: an unreadable or
   * missing verdict becomes false, so a malformed response cannot advance a
   * repair.
   */
  stepCompleted: boolean;
  /**
   * 0..1, or null when the provider gave no trustworthy confidence value.
   * null is treated as "not confident enough to act on" by the evaluator.
   */
  confidence: number | null;
  /** Short factual notes about what is visible. Model-authored, validated text. */
  observations: string[];
  /** Visible components with normalized boxes, usable as on-screen evidence. */
  components: DetectedComponent[];
  /** Which provider produced this, e.g. 'gemini' | 'mock' | 'simulated'. */
  source: string;
  /** Non-fatal validation notes, plus any reason the evidence is weak. */
  warnings: string[];
}

/**
 * Legacy normalized step result from the Phase 1 interface sketch.
 *
 * Retained (nothing is removed) but superseded by StepObservation, which keeps
 * the "providers return raw output, the normalizer validates it" invariant that
 * the rest of the AI layer relies on.
 */
export interface StepVerificationResult {
  verified: boolean;
  /** null when the provider does not supply a trustworthy confidence value. */
  confidence: number | null;
  message: string;
  source: string;
}
