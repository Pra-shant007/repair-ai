/**
 * Client-side interpreter for the POST /api/ai/verify response.
 *
 * This module is deliberately PURE and free of React, the DOM, and `fetch`, so
 * the one piece of logic that must never go wrong — "when is the repair allowed
 * to advance?" — can be unit-tested in isolation without a browser.
 *
 * Design rules that mirror the backend contract:
 *   - The BACKEND is the source of truth. `nextStep` is copied from the
 *     response; it is never derived, guessed, or generated on the client.
 *   - The UI must NEVER advance merely because the HTTP request succeeded.
 *     Advancement requires an explicit COMPLETED verdict.
 *   - Anything unknown, missing, or malformed fails safe to UNCERTAIN — the
 *     repair holds position and the technician is asked for a better frame.
 *
 * This file does NOT import or re-declare the repair scenarios. It only types
 * the API response and turns it into a small view-model for the page.
 */

/** Tri-state verdict from the backend, plus a client-only ERROR state. */
export type VerificationStatus = 'COMPLETED' | 'NOT_COMPLETED' | 'UNCERTAIN' | 'ERROR';

/** A repair step exactly as the backend returns it (backend is source of truth). */
export interface RepairStepView {
  index: number;
  title: string;
  instruction: string;
  safetyRisk?: 'safe' | 'medium' | 'high';
  warningText?: string | null;
  verificationTrigger?: string;
}

/** A normalized bounding box: every value is a 0..1 fraction of the frame. */
export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An AI-detected component with a normalized box, as returned by the backend. */
export interface NormalizedComponent {
  name: string;
  confidence: number | null;
  boundingBox: NormalizedBox;
}

/** The (relevant subset of the) /api/ai/verify JSON body. */
export interface VerifyResponse {
  verified?: boolean;
  status?: string;
  message?: string;
  confidence?: string | number | null;
  confidenceRatio?: number | null;
  currentStep?: RepairStepView | null;
  nextStep?: RepairStepView | null;
  repairComplete?: boolean;
  observations?: unknown;
  components?: unknown;
  warnings?: unknown;
  source?: string;
  aiPowered?: boolean;
}

/** The view-model the page renders and acts on. */
export interface VerificationView {
  status: VerificationStatus;
  /** True ONLY for a COMPLETED verdict. Mirrors "may the current step be marked done?". */
  verified: boolean;
  /** True ONLY when the repair may move on (COMPLETED and a real destination exists). */
  shouldAdvance: boolean;
  /** True when the final step was just completed. */
  repairComplete: boolean;
  /** "93.00"-style string for display, or null when no trustworthy value exists. */
  confidencePercent: string | null;
  /** Backend-authored status line, or a client fallback for error/malformed cases. */
  message: string;
  /** Camera/repositioning guidance for UNCERTAIN and error states; null otherwise. */
  guidance: string | null;
  /** The next step, copied verbatim from the backend. null when holding or finished. */
  nextStep: RepairStepView | null;
  currentStep: RepairStepView | null;
  /** Model-authored observations, validated to strings. */
  observations: string[];
  /** Normalized AI boxes for the camera overlay. */
  components: NormalizedComponent[];
  /** Reasons the evidence was weak, validated to strings. */
  warnings: string[];
}

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Keep only well-formed normalized components; drop anything unusable. */
const readComponents = (value: unknown): NormalizedComponent[] => {
  if (!Array.isArray(value)) return [];
  const out: NormalizedComponent[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const box = e.boundingBox as Record<string, unknown> | undefined;
    if (
      !box ||
      !isFiniteNumber(box.x) ||
      !isFiniteNumber(box.y) ||
      !isFiniteNumber(box.width) ||
      !isFiniteNumber(box.height)
    ) {
      continue;
    }
    out.push({
      name: typeof e.name === 'string' ? e.name : 'component',
      confidence: isFiniteNumber(e.confidence) ? e.confidence : null,
      boundingBox: { x: box.x, y: box.y, width: box.width, height: box.height }
    });
  }
  return out;
};

/**
 * Normalize the backend confidence into a "93.00"-style string.
 * Accepts the string the backend already sends ("93.00"), or a 0..1 ratio, or a
 * 0..100 number. Returns null when there is no trustworthy value.
 */
const readConfidencePercent = (data: VerifyResponse): string | null => {
  if (typeof data.confidence === 'string' && data.confidence.trim() !== '') {
    const n = Number(data.confidence);
    return Number.isFinite(n) ? n.toFixed(2) : null;
  }
  if (isFiniteNumber(data.confidenceRatio)) return (data.confidenceRatio * 100).toFixed(2);
  if (isFiniteNumber(data.confidence)) {
    const n = data.confidence as number;
    return (n <= 1 ? n * 100 : n).toFixed(2);
  }
  return null;
};

/** Default camera guidance, kept identical to the backend's UNCERTAIN intent. */
export const UNCERTAIN_GUIDANCE =
  'Not enough visual evidence to confirm this step. Move the camera closer or improve the lighting so the relevant component is clearly visible, then verify again.';

/**
 * Turn a successful /api/ai/verify body into the page's view-model.
 *
 * The decision table (fail-safe by construction):
 *   status === 'COMPLETED'      -> verified, and advance IF (nextStep || repairComplete)
 *   status === 'NOT_COMPLETED'  -> hold, no advance
 *   status === 'UNCERTAIN'      -> hold, no advance, show guidance
 *   anything else / missing     -> treated as UNCERTAIN (never COMPLETED)
 */
export const interpretVerification = (data: VerifyResponse): VerificationView => {
  const rawStatus = typeof data.status === 'string' ? data.status.toUpperCase() : '';
  const status: VerificationStatus =
    rawStatus === 'COMPLETED' || rawStatus === 'NOT_COMPLETED' || rawStatus === 'UNCERTAIN'
      ? (rawStatus as VerificationStatus)
      : 'UNCERTAIN';

  const repairComplete = data.repairComplete === true;
  const nextStep = data.nextStep ?? null;
  const currentStep = data.currentStep ?? null;
  const confidencePercent = readConfidencePercent(data);
  const observations = asStringArray(data.observations);
  const components = readComponents(data.components);
  const warnings = asStringArray(data.warnings);

  const verified = status === 'COMPLETED';
  // Advance only on a real COMPLETED with somewhere to go. A COMPLETED with no
  // next step and no completion flag is contradictory, so we refuse to advance.
  const shouldAdvance = verified && (nextStep !== null || repairComplete);

  let message: string;
  let guidance: string | null = null;

  if (typeof data.message === 'string' && data.message.trim() !== '') {
    message = data.message.trim();
  } else if (status === 'COMPLETED') {
    message = repairComplete ? 'Final step verified. Repair complete.' : 'Step verified.';
  } else if (status === 'NOT_COMPLETED') {
    message = 'This step does not look complete yet.';
  } else {
    message = 'Not enough visual evidence to confirm this step.';
  }

  if (status === 'UNCERTAIN') {
    // Prefer a model-supplied reason if present; otherwise the standard guidance.
    guidance = warnings.length > 0 ? warnings.join(' ') : UNCERTAIN_GUIDANCE;
  }

  return {
    status,
    verified,
    shouldAdvance,
    repairComplete,
    confidencePercent,
    message,
    guidance,
    nextStep,
    currentStep,
    observations,
    components,
    warnings
  };
};

/** The kinds of failure the page must handle without advancing the repair. */
export type VerificationErrorKind =
  | 'invalid_image' // HTTP 400
  | 'not_found' // HTTP 404
  | 'unavailable' // HTTP 5xx / Gemini down
  | 'network'; // fetch threw / aborted / timed out

/**
 * Build a fail-safe view-model for an error. Every error holds the current step:
 * `verified` and `shouldAdvance` are always false.
 */
export const errorView = (kind: VerificationErrorKind, detail?: string): VerificationView => {
  const messages: Record<VerificationErrorKind, string> = {
    invalid_image: 'The captured frame was rejected as invalid. Recapture and try again.',
    not_found: 'This scenario or step was not found on the server.',
    unavailable: 'The verification service is temporarily unavailable (the vision model may be down). Please try again.',
    network: 'Could not reach the verification service. Check your connection and try again.'
  };
  const guidance: Record<VerificationErrorKind, string | null> = {
    invalid_image: 'Make sure the component is well lit and centred, then capture again.',
    not_found: null,
    unavailable: null,
    network: null
  };
  return {
    status: 'ERROR',
    verified: false,
    shouldAdvance: false,
    repairComplete: false,
    confidencePercent: null,
    message: detail && detail.trim() ? `${messages[kind]} (${detail.trim()})` : messages[kind],
    guidance: guidance[kind],
    nextStep: null,
    currentStep: null,
    observations: [],
    components: [],
    warnings: []
  };
};
