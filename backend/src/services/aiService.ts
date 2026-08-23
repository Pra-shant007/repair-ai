/**
 * AI service — the single entry point controllers use for perception work.
 *
 * Controllers depend on this module and on types/ai.ts only. They never import
 * a provider, never see a model name, and never see an API key. Provider
 * selection, image validation, failure handling, and normalization all happen
 * here.
 */

import dotenv from 'dotenv';
import {
  AnalyzeFrameInput,
  DetectionResult,
  ProviderImage,
  StepObservation,
  VerifyStepInput
} from '../types/ai';
import { AiProvider } from './ai/aiProvider';
import { GeminiProvider } from './ai/geminiProvider';
import { mockProvider, scenarioDetection } from './ai/mockProvider';
import {
  emptyDetection,
  emptyStepObservation,
  normalizeDetection,
  normalizeStepObservation
} from './ai/normalizer';

dotenv.config();

/** Decoded-byte ceiling for an inbound frame. express.json already caps at 10mb. */
const DEFAULT_MAX_IMAGE_BYTES = 6_000_000;
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DEFAULT_MIME_TYPE = 'image/jpeg';
/** Below this a payload is a truncated or placeholder string, not a real frame. */
const MIN_IMAGE_BYTES = 512;

export type ImageParseResult =
  | { ok: true; image: ProviderImage }
  | { ok: false; error: string };

/** True when the request actually carried an image payload. */
export const isImagePayloadPresent = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

const maxImageBytes = (): number => {
  const configured = Number(process.env.AI_MAX_IMAGE_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_IMAGE_BYTES;
};

/**
 * Accepts either a bare base64 string or a `data:image/...;base64,...` URL and
 * produces a ProviderImage with raw base64 (no prefix).
 */
export const parseImagePayload = (value: unknown): ImageParseResult => {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: 'Image payload must be a non-empty base64 string.' };
  }

  let mimeType = DEFAULT_MIME_TYPE;
  let data = value.trim();

  const dataUrl = data.match(/^data:([a-z0-9.+/-]+);base64,(.*)$/is);
  if (dataUrl && dataUrl[1] && dataUrl[2] !== undefined) {
    mimeType = dataUrl[1].toLowerCase();
    data = dataUrl[2];
  }

  data = data.replace(/\s+/g, '');

  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    return { ok: false, error: `Unsupported image type "${mimeType}". Use JPEG, PNG, or WebP.` };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) {
    return { ok: false, error: 'Image payload is not valid base64.' };
  }

  // 4 base64 chars encode 3 bytes; subtract padding.
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const byteLength = (data.length / 4) * 3 - padding;

  if (byteLength < MIN_IMAGE_BYTES) {
    return { ok: false, error: 'Image payload is too small to be a usable frame.' };
  }
  if (byteLength > maxImageBytes()) {
    return { ok: false, error: 'Image payload is too large. Send a smaller or more compressed frame.' };
  }

  return { ok: true, image: { data, mimeType } };
};

/**
 * Shortest base64 string that could encode MIN_IMAGE_BYTES: 4 characters per
 * 3 bytes. Anything shorter is not a camera frame no matter what it contains.
 */
const MIN_BASE64_LENGTH = Math.ceil(MIN_IMAGE_BYTES / 3) * 4;

export type FrameClassification =
  /** No frame field, or an empty one. */
  | { kind: 'absent' }
  /**
   * Something was sent, but it is far too short to be an image — a truncated
   * literal, a 1x1 pixel, an empty-string sentinel.
   */
  | { kind: 'placeholder'; reason: string }
  /** A serious attempt at a frame that failed validation. */
  | { kind: 'invalid'; error: string }
  /** A usable frame. */
  | { kind: 'image'; image: ProviderImage };

/**
 * Decide what a caller actually sent in a frame field.
 *
 * The `placeholder` case exists for a concrete reason. The repository's
 * frontend already posts a `frameImage` to /api/ai/verify, but its value is the
 * literal `'data:image/png;base64,iVBORw0KGgo...'`, and CameraFeed's simulation
 * branch posts a 1x1 PNG. Rejecting those with a 400 would break a client that
 * works today, so they are classified as "no usable frame supplied" and fall
 * through to the existing simulated behaviour, with a warning explaining why.
 *
 * A genuinely attempted frame that is corrupt, oversized, or the wrong MIME
 * type is still an `invalid` 400 — that is a real client bug worth surfacing,
 * and a 640x360 JPEG is two orders of magnitude above the placeholder cutoff,
 * so the two cases cannot be confused.
 */
export const classifyFramePayload = (value: unknown): FrameClassification => {
  if (!isImagePayloadPresent(value)) return { kind: 'absent' };

  const raw = (value as string).trim();
  const body = raw.replace(/^data:[a-z0-9.+/-]+;base64,/i, '').replace(/\s+/g, '');

  if (body.length < MIN_BASE64_LENGTH) {
    return {
      kind: 'placeholder',
      reason: 'The supplied frame was too small to be a camera image and was ignored.'
    };
  }

  const parsed = parseImagePayload(raw);
  return parsed.ok ? { kind: 'image', image: parsed.image } : { kind: 'invalid', error: parsed.error };
};

let cachedProvider: AiProvider | null = null;

/**
 * Choose a provider from the environment. Secrets are read here and nowhere
 * else; the key is never logged.
 *
 * AI_PROVIDER=mock forces the offline provider. Otherwise Gemini is used when
 * GEMINI_API_KEY is present, and the mock provider is used when it is not.
 */
export const getProvider = (): AiProvider => {
  if (cachedProvider) return cachedProvider;

  const requested = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();

  if (requested === 'mock' || !apiKey) {
    if (requested !== 'mock' && !apiKey) {
      console.warn('[aiService] GEMINI_API_KEY is not set; falling back to the mock AI provider.');
    }
    cachedProvider = mockProvider;
    return cachedProvider;
  }

  try {
    cachedProvider = new GeminiProvider({
      apiKey,
      model: process.env.GEMINI_VISION_MODEL || undefined,
      timeoutMs: Number(process.env.AI_REQUEST_TIMEOUT_MS) || undefined
    });
  } catch (error) {
    console.warn(
      '[aiService] Could not initialise the Gemini provider; using the mock provider instead.',
      error instanceof Error ? error.message : error
    );
    cachedProvider = mockProvider;
  }

  return cachedProvider;
};

/** Test hook: drop the memoised provider so environment changes take effect. */
export const resetProvider = (): void => {
  cachedProvider = null;
};

/**
 * Normalized view of an existing demo scenario. Synchronous, no network, no
 * provider call, no quota use.
 *
 * This lets the legacy (no-image) code path return the same
 * `detectedComponents` shape as the AI path while being clearly labelled
 * `source: 'scenario'` so nobody mistakes canned data for a model result.
 */
export const describeScenario = (scenarioId?: string): DetectionResult =>
  normalizeDetection(scenarioDetection(scenarioId), 'scenario');

/**
 * Analyze one frame and return a validated, provider-independent result.
 *
 * Never throws and never retries — one provider call per request, so a client
 * loop cannot silently multiply Gemini quota usage. If the provider fails and a
 * supported scenario was supplied, the offline provider answers instead (real
 * scenario data, not invented data) and the reason is recorded in `warnings`.
 */
export const analyzeFrame = async (input: AnalyzeFrameInput): Promise<DetectionResult> => {
  const provider = getProvider();

  try {
    const raw = await provider.analyzeFrame(input);
    return normalizeDetection(raw, provider.name);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[aiService] ${provider.name} analyzeFrame failed: ${detail}`);

    if (provider.name === mockProvider.name) {
      return emptyDetection(mockProvider.name, ['AI analysis failed; no detections available.']);
    }

    try {
      const raw = await mockProvider.analyzeFrame(input);
      const fallback = normalizeDetection(raw, mockProvider.name);
      const reason =
        fallback.device || fallback.components.length > 0
          ? `${provider.name} analysis failed; returned offline scenario data instead.`
          : `${provider.name} analysis failed and no offline scenario data was available.`;
      return { ...fallback, warnings: [reason, ...fallback.warnings] };
    } catch {
      return emptyDetection(provider.name, ['AI analysis failed; no detections available.']);
    }
  }
};

/**
 * Backend-measured timings for one verification request.
 *
 * Measured here rather than reported by the provider, so the numbers cannot be
 * influenced by model output. `providerMs` is the full provider call including
 * the network round trip; geminiProvider additionally logs the model round trip
 * on its own.
 */
export interface StepVerificationTimings {
  /** Time spent in the provider call, including network. */
  providerMs: number;
  /** Time spent validating and normalizing the response. */
  normalizeMs: number;
  /** Total time inside this function. */
  totalMs: number;
}

export interface StepVerificationOutcome {
  observation: StepObservation;
  timings: StepVerificationTimings;
}

/**
 * Gather visual evidence about one predefined repair step.
 *
 * Never throws, and never retries — one provider call per request, so a client
 * polling loop cannot silently multiply quota usage.
 *
 * IMPORTANT asymmetry with analyzeFrame: there is deliberately NO fallback to
 * the mock provider here. Falling back on detection is harmless (it returns
 * real scenario data instead of a guess), but falling back on verification
 * could report a step as complete when nothing was ever looked at. A provider
 * failure therefore produces a fail-closed observation, which the deterministic
 * evaluator reads as UNCERTAIN and refuses to advance.
 */
export const verifyStepWithVision = async (
  input: VerifyStepInput
): Promise<StepVerificationOutcome> => {
  const provider = getProvider();
  const startedAt = Date.now();

  let raw: unknown;
  let providerMs: number;
  try {
    raw = await provider.verifyStep(input);
    providerMs = Date.now() - startedAt;
  } catch (error) {
    providerMs = Date.now() - startedAt;
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[aiService] ${provider.name} verifyStep failed after ${providerMs}ms: ${detail}`);

    return {
      observation: emptyStepObservation(provider.name, [
        `${provider.name} step verification failed, so the step was not advanced.`
      ]),
      timings: { providerMs, normalizeMs: 0, totalMs: Date.now() - startedAt }
    };
  }

  const normalizeStartedAt = Date.now();
  const observation = normalizeStepObservation(raw, provider.name);
  const normalizeMs = Date.now() - normalizeStartedAt;
  const totalMs = Date.now() - startedAt;

  console.info(
    `[aiService] verifyStep provider=${provider.name} providerMs=${providerMs} normalizeMs=${normalizeMs} totalMs=${totalMs}`
  );

  return { observation, timings: { providerMs, normalizeMs, totalMs } };
};
