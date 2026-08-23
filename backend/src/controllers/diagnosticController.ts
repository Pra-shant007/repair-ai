/**
 * Diagnostic controller — HTTP surface for the diagnostic copilot.
 *
 * Thin by design. It validates the request shape, delegates to
 * diagnosticService, and projects the structured session into a response. It
 * contains no diagnostic logic, no prompt, no provider import, and no decision
 * about what the user should physically do.
 *
 * Follows the conventions already used by aiController: `AuthenticatedRequest`,
 * `res.status(n).json(...)`, and a `message` field on errors.
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import {
  getSessionView,
  linkRepair,
  startDiagnosis,
  submitTestResult,
  toSessionView
} from '../services/diagnostic/diagnosticService';

/** Map a service error code onto an HTTP status. */
const STATUS_FOR: Record<string, number> = {
  NOT_FOUND: 404,
  NO_CURRENT_TEST: 409,
  WRONG_TEST: 409,
  NOT_GROUNDED: 409,
  BAD_ANSWER: 400
};

/**
 * POST /api/ai/diagnose
 *
 * Body: { image?, userDescription?, sessionId? }
 *
 * With no sessionId this starts a new diagnosis: at most one perception call
 * (only if an image was supplied) plus exactly one reasoning call.
 *
 * With a sessionId it simply RETURNS that session — no model call at all. That
 * makes the endpoint safe to re-issue (e.g. a retried request or a double tap)
 * without silently spending Gemini quota or starting a duplicate session.
 */
export const diagnose = async (req: AuthenticatedRequest, res: Response) => {
  const { image, frameImage, userDescription, description, symptom, sessionId } = req.body ?? {};

  // Re-issued request against an existing session: return current state.
  if (typeof sessionId === 'string' && sessionId.trim()) {
    const existing = getSessionView(sessionId.trim());
    if (!existing) {
      return res.status(404).json({ message: 'Unknown or expired diagnosis session.' });
    }
    return res.status(200).json({ session: existing, warnings: [] });
  }

  // Accept `userDescription`, or `description`/`symptom` as aliases.
  const symptomText =
    typeof userDescription === 'string'
      ? userDescription
      : typeof description === 'string'
        ? description
        : symptom;

  // Accept `image`, or `frameImage` for symmetry with /api/ai/verify.
  const imagePayload =
    typeof image === 'string' && image.trim() ? image : frameImage;

  const hasSymptom = typeof symptomText === 'string' && symptomText.trim().length > 0;
  const hasImage = typeof imagePayload === 'string' && imagePayload.trim().length > 0;

  if (!hasSymptom && !hasImage) {
    return res.status(400).json({
      message: 'Describe the problem, send a camera frame, or both.'
    });
  }

  try {
    const { session, warnings } = await startDiagnosis({
      image: imagePayload,
      userDescription: symptomText
    });

    return res.status(200).json({ session: toSessionView(session), warnings });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[diagnosticController] diagnose failed: ${detail}`);
    return res.status(500).json({ message: 'Diagnosis failed. Please try again.' });
  }
};

/**
 * POST /api/ai/diagnose/:sessionId/result
 *
 * Body: { answer: 'yes' | 'no' | 'unclear', testId?, note? }
 *
 * Records the outcome of the test the session is waiting on and re-decides.
 * Makes NO model call: hypothesis updates come from the test catalog's own
 * hand-written interpretation, so answering questions is deterministic and free.
 */
export const submitDiagnosisResult = async (req: AuthenticatedRequest, res: Response) => {
  const { sessionId } = req.params;
  if (!sessionId || !sessionId.trim()) {
    return res.status(400).json({ message: 'A session id is required.' });
  }

  const { answer, testId, note } = req.body ?? {};

  const outcome = submitTestResult(sessionId.trim(), { answer, testId, note });

  if (!outcome.ok) {
    return res.status(STATUS_FOR[outcome.code] ?? 400).json({ message: outcome.message });
  }

  return res.status(200).json({
    session: toSessionView(outcome.session),
    warnings: outcome.warnings
  });
};

/**
 * GET /api/ai/diagnose/:sessionId
 *
 * Read-only view of a diagnosis session. No model call.
 */
export const getDiagnosis = async (req: AuthenticatedRequest, res: Response) => {
  const { sessionId } = req.params;
  const view = sessionId ? getSessionView(sessionId.trim()) : null;
  if (!view) {
    return res.status(404).json({ message: 'Unknown or expired diagnosis session.' });
  }
  return res.status(200).json({ session: view, warnings: [] });
};

/**
 * POST /api/ai/diagnose/:sessionId/repair
 *
 * Record that a grounded repair session (created by the EXISTING repair engine)
 * was started from this diagnosis. This only stores the link; it does not create
 * a repair and does not duplicate any part of the repair flow.
 */
export const linkDiagnosisRepair = async (req: AuthenticatedRequest, res: Response) => {
  const { sessionId } = req.params;
  const { repairId } = req.body ?? {};

  if (typeof repairId !== 'string' || !repairId.trim()) {
    return res.status(400).json({ message: 'A repairId is required.' });
  }

  const outcome = sessionId
    ? linkRepair(sessionId.trim(), repairId.trim())
    : ({ ok: false, code: 'NOT_FOUND', message: 'Unknown or expired diagnosis session.' } as const);

  if (!outcome.ok) {
    return res.status(STATUS_FOR[outcome.code] ?? 400).json({ message: outcome.message });
  }

  return res.status(200).json({ session: toSessionView(outcome.session), warnings: [] });
};
