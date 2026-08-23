/**
 * Client-side interpreter for the POST /api/ai/diagnose family of responses.
 *
 * Deliberately PURE — no React, no DOM, no `fetch` — so the logic that decides
 * what the copilot is allowed to TELL THE USER TO DO can be unit-tested without
 * a browser. Mirrors the same discipline as verifyClient.ts.
 *
 * Design rules that mirror the backend contract:
 *   - The BACKEND is the source of truth. The next action is copied from
 *     `session.nextBestAction`; it is never derived, guessed, or invented here.
 *   - The UI must NEVER offer a physical repair procedure that the backend did
 *     not mark AVAILABLE. `handoff()` returns a scenario id only when the
 *     backend both confirmed the fault and reported a grounded procedure.
 *   - Anything unknown, missing, or malformed fails safe: no action, no
 *     hand-off, and a request for more detail.
 *
 * This file does NOT contain a fault list, a test catalog, or repair steps. Those
 * live on the server; the client only renders what it is handed.
 */

/** Diagnosis lifecycle, mirrored from the backend, plus a client-only ERROR. */
export type DiagnosisStatusView =
  | 'IDENTIFYING'
  | 'DIAGNOSING'
  | 'NEEDS_USER_INPUT'
  | 'NEEDS_VISUAL_EVIDENCE'
  | 'CONFIRMED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'UNSUPPORTED'
  | 'UNSAFE_TO_GUIDE'
  | 'ERROR';

const KNOWN_STATUSES: readonly string[] = [
  'IDENTIFYING',
  'DIAGNOSING',
  'NEEDS_USER_INPUT',
  'NEEDS_VISUAL_EVIDENCE',
  'CONFIRMED',
  'INSUFFICIENT_EVIDENCE',
  'UNSUPPORTED',
  'UNSAFE_TO_GUIDE'
];

export type RiskLevelView = 'safe' | 'medium' | 'high';
export type ObserveModeView = 'camera' | 'user';

/** A fault hypothesis exactly as the backend ranked it. */
export interface HypothesisView {
  code: string;
  label: string;
  /** 0..1 as sent by the backend. */
  confidence: number;
  /** Percent string for display, e.g. "62". */
  confidencePercent: string;
  rationale: string;
}

/** The single action the user is being asked to perform, if any. */
export interface ActionView {
  kind: 'DIAGNOSTIC_TEST' | 'ASK_USER' | 'VISUAL_INSPECTION' | 'RETRY_CAMERA' | 'STOP_UNSAFE' | 'REPAIR_STEP' | 'COMPLETE';
  /** Short heading, e.g. the test title. */
  title: string;
  /** What to physically do / what to type. Empty when there is nothing to do. */
  instruction: string;
  /** The yes/no question to answer, when the action is a test. */
  question: string | null;
  /** Present only for DIAGNOSTIC_TEST; the id echoed back with the answer. */
  testId: string | null;
  riskLevel: RiskLevelView;
  /** Whether the result is observed by camera or reported by the user. */
  observe: ObserveModeView;
  /** True when the UI should render yes / no / not sure buttons. */
  answerable: boolean;
}

/** The four-panel view-model the page renders. */
export interface DiagnosisView {
  status: DiagnosisStatusView;
  sessionId: string | null;
  /** Human-readable device line, or null when nothing was identified. */
  deviceLabel: string | null;
  symptom: string | null;
  /** "What I see" — perception + recorded test outcomes. */
  see: string[];
  /** "What I think" — ranked hypotheses. */
  think: HypothesisView[];
  /** "What I need you to do" — exactly one action, or null. */
  action: ActionView | null;
  /** "Why" — the reason this action/verdict follows from the evidence. */
  why: string | null;
  /** Non-procedural advice, only when the backend produced a recommendation. */
  advice: string[];
  /** Backend-authored headline for the current state. */
  message: string;
  /** True only when the backend named a fault it is confident about. */
  confirmed: boolean;
  /** Scenario id ONLY when the backend reported a grounded, available procedure. */
  procedureScenarioId: string | null;
  /** Why no grounded procedure exists, when that is the case. */
  procedureUnavailableReason: string | null;
  /** True when diagnosis has stopped and there is nothing further to ask. */
  finished: boolean;
  warnings: string[];
}

/** The raw JSON body of a diagnose response (only the parts we read). */
export interface DiagnoseResponse {
  session?: unknown;
  warnings?: unknown;
  message?: unknown;
}

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const readRisk = (value: unknown): RiskLevelView =>
  value === 'safe' || value === 'medium' || value === 'high' ? value : 'high';

const readObserve = (value: unknown): ObserveModeView => (value === 'camera' ? 'camera' : 'user');

/** "Samsung Galaxy S21 (Smartphone)" / "Smartphone" / null. */
const readDeviceLabel = (device: unknown): string | null => {
  const d = asRecord(device);
  if (!d) return null;
  const type = readString(d.type);
  const brand = readString(d.brand);
  const model = readString(d.model);
  const named = [brand, model].filter(Boolean).join(' ');
  if (named && type) return `${named} (${type})`;
  return named || type;
};

/** Observations, validated to display strings. */
const readObservations = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const o = asRecord(entry);
    const text = o ? readString(o.text) : readString(entry);
    if (text) out.push(text);
  }
  return out;
};

/** Hypotheses, validated and left in the backend's ranking order. */
const readHypotheses = (value: unknown): HypothesisView[] => {
  if (!Array.isArray(value)) return [];
  const out: HypothesisView[] = [];
  for (const entry of value) {
    const h = asRecord(entry);
    if (!h) continue;
    const code = readString(h.code);
    if (!code || !isFiniteNumber(h.confidence)) continue;
    const confidence = Math.min(1, Math.max(0, h.confidence));
    out.push({
      code,
      label: readString(h.label) ?? code,
      confidence,
      confidencePercent: (confidence * 100).toFixed(0),
      rationale: readString(h.rationale) ?? ''
    });
  }
  return out;
};

/**
 * Turn `session.nextBestAction` into the single action the UI may present.
 *
 * REPAIR_STEP and COMPLETE are terminal: they are not things the user "does" in
 * the diagnostic loop, so they produce no answerable action here — the page
 * either hands off to the existing repair flow or shows the recommendation.
 */
const readAction = (raw: unknown): ActionView | null => {
  const a = asRecord(raw);
  if (!a) return null;
  const kind = readString(a.kind);

  switch (kind) {
    case 'DIAGNOSTIC_TEST': {
      const testId = readString(a.testId);
      if (!testId) return null;
      return {
        kind: 'DIAGNOSTIC_TEST',
        title: readString(a.title) ?? 'Diagnostic check',
        instruction: readString(a.instruction) ?? '',
        question: readString(a.question),
        testId,
        riskLevel: readRisk(a.riskLevel),
        observe: readObserve(a.observe),
        answerable: true
      };
    }
    case 'ASK_USER':
      return {
        kind: 'ASK_USER',
        title: 'Tell me more',
        instruction: readString(a.prompt) ?? 'Describe the problem in a little more detail.',
        question: null,
        testId: null,
        riskLevel: 'safe',
        observe: 'user',
        answerable: false
      };
    case 'VISUAL_INSPECTION':
      return {
        kind: 'VISUAL_INSPECTION',
        title: 'Show me',
        instruction: readString(a.prompt) ?? 'Point the camera at the device.',
        question: null,
        testId: null,
        riskLevel: 'safe',
        observe: 'camera',
        answerable: false
      };
    case 'RETRY_CAMERA':
      return {
        kind: 'RETRY_CAMERA',
        title: 'Recapture the device',
        instruction:
          readString(a.reason) ??
          'I could not see the device clearly. Move closer, improve the lighting, and scan again.',
        question: null,
        testId: null,
        riskLevel: 'safe',
        observe: 'camera',
        answerable: false
      };
    case 'STOP_UNSAFE':
      return {
        kind: 'STOP_UNSAFE',
        title: 'Stopping here for safety',
        instruction:
          readString(a.reason) ??
          'The only remaining checks are unsafe to guide you through remotely. A qualified technician should take it from here.',
        question: null,
        testId: null,
        riskLevel: 'high',
        observe: 'user',
        answerable: false
      };
    case 'REPAIR_STEP':
    case 'COMPLETE':
      return null;
    default:
      return null;
  }
};

/** The "Why" line: the rationale behind the current action or verdict. */
const readWhy = (
  action: ActionView | null,
  hypotheses: HypothesisView[],
  rawAction: Record<string, unknown> | null,
  recommendationSummary: string | null
): string | null => {
  if (rawAction) {
    // STOP_UNSAFE / RETRY_CAMERA / REPAIR_STEP carry their own explicit reason.
    const reason = readString(rawAction.reason);
    if (reason) return reason;
  }
  if (action && action.kind === 'DIAGNOSTIC_TEST' && hypotheses.length > 0) {
    const top = hypotheses.slice(0, 2).map((h) => `${h.label} (${h.confidencePercent}%)`);
    return `This is the safest check that separates ${top.join(' from ')}.`;
  }
  if (recommendationSummary) return recommendationSummary;
  if (hypotheses.length > 0) {
    const top = hypotheses[0];
    return `${top.label} is currently the strongest explanation at ${top.confidencePercent}% — ${top.rationale}`.trim();
  }
  return null;
};

/** Backend-authored-ish headline per status. Never claims more than the state. */
const messageFor = (
  status: DiagnosisStatusView,
  action: ActionView | null,
  hypotheses: HypothesisView[],
  recommendationSummary: string | null
): string => {
  switch (status) {
    case 'CONFIRMED':
      return recommendationSummary ?? 'I have a confident diagnosis.';
    case 'NEEDS_USER_INPUT':
      return action ? 'I need one answer from you to narrow this down.' : 'I need more information.';
    case 'NEEDS_VISUAL_EVIDENCE':
      return 'I need a clearer look at the device.';
    case 'INSUFFICIENT_EVIDENCE':
      return 'I do not have enough to name a fault yet.';
    case 'UNSUPPORTED':
      return 'I could not work out what this device is.';
    case 'UNSAFE_TO_GUIDE':
      return 'I am stopping here rather than walking you through an unsafe check.';
    case 'IDENTIFYING':
      return 'Identifying the device...';
    case 'ERROR':
      return 'The diagnostic service is unavailable.';
    default:
      return hypotheses.length > 0 ? 'Narrowing down the cause.' : 'Diagnosing.';
  }
};

/**
 * Turn a successful diagnose response into the page's view-model.
 *
 * Fail-safe by construction: an unrecognized status becomes DIAGNOSING (never
 * CONFIRMED), and `procedureScenarioId` stays null unless the backend explicitly
 * marked a procedure AVAILABLE.
 */
export const interpretDiagnosis = (data: DiagnoseResponse): DiagnosisView => {
  const session = asRecord(data.session);
  const warnings = asStringArray(data.warnings);

  if (!session) {
    return { ...errorDiagnosisView('malformed'), warnings };
  }

  const rawStatus = typeof session.status === 'string' ? session.status.toUpperCase() : '';
  const status: DiagnosisStatusView = KNOWN_STATUSES.includes(rawStatus)
    ? (rawStatus as DiagnosisStatusView)
    : 'DIAGNOSING';

  const hypotheses = readHypotheses(session.hypotheses);
  const rawAction = asRecord(session.nextBestAction);
  const action = readAction(session.nextBestAction);

  const recommendation = asRecord(session.recommendation);
  const recommendationSummary = recommendation ? readString(recommendation.summary) : null;
  const advice = recommendation ? asStringArray(recommendation.advice) : [];

  // A grounded procedure exists ONLY when the backend says AVAILABLE. Anything
  // else — including a missing or malformed procedure block — means advisory only.
  const procedure = asRecord(session.procedure);
  const procedureScenarioId =
    procedure && procedure.status === 'AVAILABLE' ? readString(procedure.scenarioId) : null;
  const procedureUnavailableReason =
    procedure && procedure.status !== 'AVAILABLE' ? readString(procedure.reason) : null;

  const actionKind = rawAction ? readString(rawAction.kind) : null;
  const finished =
    actionKind === 'COMPLETE' || actionKind === 'STOP_UNSAFE' || actionKind === 'REPAIR_STEP';

  return {
    status,
    sessionId: readString(session.sessionId),
    deviceLabel: readDeviceLabel(session.device) ?? readString(session.deviceType),
    symptom: readString(session.symptom),
    see: readObservations(session.observations),
    think: hypotheses,
    action,
    why: readWhy(action, hypotheses, rawAction, recommendationSummary),
    advice,
    message: messageFor(status, action, hypotheses, recommendationSummary),
    confirmed: status === 'CONFIRMED' && readString(session.likelyFault) !== null,
    procedureScenarioId,
    procedureUnavailableReason,
    finished,
    warnings
  };
};

/** Failure kinds the page must handle without ever inventing a diagnosis. */
export type DiagnosisErrorKind =
  | 'bad_request' // HTTP 400 — nothing to go on
  | 'not_found' // HTTP 404 — session expired or unknown
  | 'conflict' // HTTP 409 — answer did not match the pending test
  | 'unavailable' // HTTP 5xx
  | 'network' // fetch threw / timed out
  | 'camera_unavailable' // no live frame and no symptom
  | 'malformed'; // 200 with an unusable body

/** A fail-safe view for an error: no hypotheses, no action, no hand-off. */
export const errorDiagnosisView = (kind: DiagnosisErrorKind, detail?: string): DiagnosisView => {
  const messages: Record<DiagnosisErrorKind, string> = {
    bad_request: 'Describe the problem, point the camera at the device, or both.',
    not_found: 'This diagnosis session expired. Start a new one.',
    conflict: 'That answer no longer matches the current check. Reload the current question.',
    unavailable: 'The diagnostic service is temporarily unavailable. Please try again.',
    network: 'Could not reach the diagnostic service. Check your connection and try again.',
    camera_unavailable:
      'No live camera frame and no description. Allow camera access or describe the problem, then try again.',
    malformed: 'The diagnostic service returned an unusable response. Please try again.'
  };
  return {
    status: 'ERROR',
    sessionId: null,
    deviceLabel: null,
    symptom: null,
    see: [],
    think: [],
    action: null,
    why: null,
    advice: [],
    message: detail && detail.trim() ? `${messages[kind]} (${detail.trim()})` : messages[kind],
    confirmed: false,
    procedureScenarioId: null,
    procedureUnavailableReason: null,
    finished: false,
    warnings: []
  };
};

/** Map an HTTP status onto an error kind. */
export const errorKindForStatus = (httpStatus: number): DiagnosisErrorKind => {
  if (httpStatus === 400) return 'bad_request';
  if (httpStatus === 404) return 'not_found';
  if (httpStatus === 409) return 'conflict';
  return 'unavailable';
};

/** The closed vocabulary of answers a user may give to a diagnostic test. */
export type DiagnosticAnswer = 'yes' | 'no' | 'unclear';

/**
 * May we start a diagnosis at all? A symptom OR a real live frame is enough —
 * both is better. Without either we refuse locally instead of sending a request
 * the backend will only reject.
 */
export const canStartDiagnosis = (symptom: string, frame: string | null): boolean =>
  symptom.trim().length > 0 || (typeof frame === 'string' && frame.startsWith('data:image'));

/**
 * The ONLY transition into the existing repair flow.
 *
 * `repair` is returned exclusively when the backend confirmed a fault AND
 * published a grounded procedure for it — so a diagnosis on an arbitrary device
 * can never open a step-by-step repair. Everything else stays advisory.
 */
export type DiagnosisHandoff =
  | { kind: 'repair'; scenarioId: string }
  | { kind: 'advice'; reason: string }
  | { kind: 'continue' };

export const handoff = (view: DiagnosisView | null): DiagnosisHandoff => {
  if (!view) return { kind: 'continue' };
  if (view.status === 'ERROR') return { kind: 'continue' };
  if (view.confirmed && view.procedureScenarioId) {
    return { kind: 'repair', scenarioId: view.procedureScenarioId };
  }
  if (view.finished || view.confirmed) {
    // Distinguish the two reasons a repair is not being offered. Claiming "no
    // procedure exists" when one does — and the diagnosis simply was not
    // conclusive — would be a false statement about the device.
    const fallback = view.procedureScenarioId
      ? 'I could not narrow this down confidently enough to start the guided repair for you.'
      : 'No verified step-by-step procedure is available for this device, so I can only advise.';
    return { kind: 'advice', reason: view.procedureUnavailableReason ?? fallback };
  }
  return { kind: 'continue' };
};
