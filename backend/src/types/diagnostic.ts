/**
 * Provider-independent types for the diagnostic copilot.
 *
 * This layer sits BESIDE the existing perception + repair layers, never inside
 * them. It reuses `DetectedDevice` from types/ai.ts (perception output) and
 * hands off to the existing repair engine once a grounded procedure is found.
 *
 * Two hard rules are encoded structurally here:
 *
 *   1. The model may only ever classify a fault into the FIXED vocabulary in
 *      `FaultCode`. It cannot invent a fault category, which keeps hypotheses
 *      testable and lets the deterministic test catalog reference faults by a
 *      stable id (see diagnosticTests.ts).
 *
 *   2. `ProcedureAvailability` separates "we have a diagnosis" from "we have a
 *      grounded, step-by-step physical procedure". Step-by-step repair only
 *      exists when a demoScenario matches; otherwise the status is UNAVAILABLE
 *      and the copilot stays advisory. The model never authors a procedure.
 */

import { DetectedDevice } from './ai';

/**
 * The FIXED fault vocabulary the copilot reasons over.
 *
 * The reasoning provider is asked to classify a symptom into these codes and
 * nothing else; the normalizer discards anything outside this set. The
 * diagnostic test catalog references the same codes, which is what lets a test
 * result deterministically raise or lower a specific hypothesis.
 */
export type FaultCode =
  | 'battery_fault'
  | 'charging_port_fault'
  | 'power_adapter_fault'
  | 'display_backlight_fault'
  | 'gpu_video_fault'
  | 'mainboard_no_post'
  | 'loose_connection'
  | 'storage_fault'
  | 'thermal_fault'
  | 'wireless_fault'
  | 'unknown';

/** Every fault code, for validation and for prompting the reasoning provider. */
export const FAULT_CODES: readonly FaultCode[] = [
  'battery_fault',
  'charging_port_fault',
  'power_adapter_fault',
  'display_backlight_fault',
  'gpu_video_fault',
  'mainboard_no_post',
  'loose_connection',
  'storage_fault',
  'thermal_fault',
  'wireless_fault',
  'unknown'
];

/** Human-readable labels for each fault code, used when the model omits one. */
export const FAULT_LABELS: Record<FaultCode, string> = {
  battery_fault: 'Battery is dead, degraded, or not holding charge',
  charging_port_fault: 'Charging port / connector is damaged or not making contact',
  power_adapter_fault: 'Power adapter, cable, or external power delivery is faulty',
  display_backlight_fault: 'Display panel or backlight is faulty (device is otherwise running)',
  gpu_video_fault: 'Graphics / video output path is faulty',
  mainboard_no_post: 'Mainboard does not power on / complete power-on self test',
  loose_connection: 'A cable or module is loose or disconnected internally',
  storage_fault: 'Storage drive or operating system is failing to boot',
  thermal_fault: 'Overheating or thermal shutdown',
  wireless_fault: 'Wireless radio / antenna fault',
  unknown: 'Cause not yet determined'
};

/** Physical-risk band, aligned with demoScenarios `safetyRisk`. */
export type DiagnosticRiskLevel = 'safe' | 'medium' | 'high';

/** Diagnosis lifecycle. Every value is a deterministic function of the state. */
export type DiagnosisStatus =
  /** Waiting to identify the device (no usable perception yet). */
  | 'IDENTIFYING'
  /** Actively narrowing hypotheses with tests. */
  | 'DIAGNOSING'
  /** Blocked on a user answer to proceed. */
  | 'NEEDS_USER_INPUT'
  /** Blocked on a camera frame / visual inspection to proceed. */
  | 'NEEDS_VISUAL_EVIDENCE'
  /** A single fault is confident enough to act on. */
  | 'CONFIRMED'
  /** Evidence is too weak/contradictory to name a fault. */
  | 'INSUFFICIENT_EVIDENCE'
  /** No fault in the supported vocabulary applies to this device/symptom. */
  | 'UNSUPPORTED'
  /** The only remaining discriminating action is unsafe to guide. */
  | 'UNSAFE_TO_GUIDE';

/** Where a single observation came from. */
export type ObservationSource = 'camera' | 'user' | 'system';

/** One atomic, human-readable fact gathered during the session. */
export interface Observation {
  id: string;
  source: ObservationSource;
  text: string;
  at: number;
}

/**
 * A candidate fault with an estimated confidence.
 *
 * `confidence` is a heuristic 0..1 belief, NOT a calibrated probability. The
 * test selector treats it accordingly (safety-first, not confidence-maximizing).
 */
export interface FaultHypothesis {
  code: FaultCode;
  label: string;
  /** 0..1 heuristic belief. */
  confidence: number;
  rationale: string;
  /** Observation ids / notes that support this hypothesis. */
  supportedBy: string[];
}

/**
 * Raw, UNTRUSTED reasoning output from a provider.
 * Must always pass through the normalizer before use.
 */
export type RawDiagnosticReasoning = unknown;

/** Input handed to `AiProvider.proposeHypotheses` (no SDK types leak here). */
export interface ProposeHypothesesInput {
  /** The user's free-text symptom description. */
  symptom: string;
  /** What perception saw, or null when there was no usable image. */
  device: DetectedDevice | null;
  /** Short factual notes (component names, prior observations). */
  observations: string[];
  /** The ONLY fault codes the provider may classify into. */
  candidateFaults: readonly FaultCode[];
}

/** Validated reasoning result the rest of the backend consumes. */
export interface DiagnosticReasoning {
  hypotheses: FaultHypothesis[];
  /** Model-authored factual notes about the symptom/device. */
  observations: string[];
  source: string;
  warnings: string[];
}

/** How a test's result is observed. */
export type TestObservationMode = 'camera' | 'user';

/**
 * The context a test's `appliesTo` predicate is allowed to see. Deliberately
 * data-only so applicability is a pure function of the session snapshot.
 */
export interface TestApplicabilityContext {
  deviceType: string | null;
  hypothesisCodes: FaultCode[];
  testsPerformed: string[];
}

/** A user's answer to a test, normalized to a tiny closed vocabulary. */
export type TestAnswer = 'yes' | 'no' | 'unclear';

/** A recorded result for a test the user carried out. */
export interface DiagnosticTestResult {
  testId: string;
  observedAt: number;
  answer: TestAnswer;
  /** Optional freeform note captured alongside the answer. */
  note?: string;
}

/**
 * A deterministic effect a test result has on a hypothesis.
 * Applied by the diagnostic service; clamped to 0..1 there.
 */
export interface HypothesisEffect {
  code: FaultCode;
  /** Signed confidence delta, e.g. +0.3 supports, -0.4 contradicts. */
  delta: number;
  note: string;
}

/**
 * A static diagnostic test. Authored by hand in diagnosticTests.ts and NEVER
 * generated by a model. The physical-safety metadata is what the deterministic
 * selector ranks and gates on.
 */
export interface DiagnosticTest {
  id: string;
  title: string;
  /** What the user is instructed to do. */
  instruction: string;
  /** For observe:'user', the yes/no question the user answers afterward. */
  question: string;
  riskLevel: DiagnosticRiskLevel;
  /** 0..1, higher = harder / more skill required. */
  difficulty: number;
  reversibility: 'reversible' | 'irreversible';
  requiresDisassembly: boolean;
  requiresPowerManipulation: boolean;
  /** 0..1 expected discriminating power between competing hypotheses. */
  informationValue: number;
  observe: TestObservationMode;
  /** Pure predicate: may this test be offered for the current session? */
  appliesTo: (ctx: TestApplicabilityContext) => boolean;
  /** Deterministic mapping from an answer to hypothesis confidence effects. */
  interpret: (answer: TestAnswer) => HypothesisEffect[];
}

/**
 * Whether a grounded, step-by-step physical procedure exists for the diagnosis.
 *
 * AVAILABLE only when a demoScenario matches. Otherwise UNAVAILABLE — the
 * copilot must not synthesize physical steps for an arbitrary device.
 */
export type ProcedureAvailability =
  | { status: 'AVAILABLE'; scenarioId: string }
  | { status: 'UNAVAILABLE'; reason: string };

/** The final advisory output once a diagnosis is reached (or ruled out). */
export interface RepairRecommendation {
  summary: string;
  likelyFault: FaultCode | null;
  /** 0..1 confidence in the named fault. */
  confidence: number;
  procedure: ProcedureAvailability;
  /** Generic, non-procedural advice (safe for arbitrary devices). */
  advice: string[];
}

/**
 * The one thing the user should do next. This is authored EXCLUSIVELY by the
 * deterministic selector; the reasoning provider can never emit one directly.
 */
export type NextBestAction =
  | { kind: 'ASK_USER'; prompt: string }
  | {
      kind: 'DIAGNOSTIC_TEST';
      testId: string;
      title: string;
      instruction: string;
      question: string;
      riskLevel: DiagnosticRiskLevel;
      observe: TestObservationMode;
    }
  | { kind: 'VISUAL_INSPECTION'; prompt: string }
  | { kind: 'REPAIR_STEP'; scenarioId: string; reason: string }
  | { kind: 'RETRY_CAMERA'; reason: string }
  | { kind: 'STOP_UNSAFE'; reason: string }
  | { kind: 'COMPLETE'; recommendation: RepairRecommendation };

/**
 * The structured diagnostic session. This is the state the backend OWNS (Rule
 * 5). It is never a blob of model-generated prose: every field is typed, and
 * the model only ever contributes to `hypotheses` and `observations`, both
 * validated first.
 *
 * `currentTestId` (not the full test object) is stored so the session stays a
 * plain data record — the DiagnosticTest carries functions and must not be
 * serialized to the client.
 */
export interface DiagnosisSession {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  device: DetectedDevice | null;
  /** Resolved device type (from the image, or inferred from the symptom text). */
  deviceType: string | null;
  symptomText: string | null;
  observations: Observation[];
  hypotheses: FaultHypothesis[];
  /** Ids of tests already resolved with a result. */
  testsPerformed: string[];
  /** The test the user is currently being asked to run, if any. */
  currentTestId: string | null;
  testResults: DiagnosticTestResult[];
  status: DiagnosisStatus;
  likelyFault: FaultCode | null;
  repairRecommendation: RepairRecommendation | null;
  procedure: ProcedureAvailability;
  nextBestAction: NextBestAction;
  /** Set once a grounded repair session is started via the existing engine. */
  linkedRepairId: string | null;
}

/**
 * The client-facing projection of a session. Excludes nothing sensitive today,
 * but is a distinct type so we never accidentally leak internal-only fields
 * (or a DiagnosticTest's functions) by returning the raw session.
 */
export interface DiagnosisSessionView {
  sessionId: string;
  status: DiagnosisStatus;
  device: DetectedDevice | null;
  deviceType: string | null;
  symptom: string | null;
  observations: Observation[];
  hypotheses: FaultHypothesis[];
  testsPerformed: string[];
  currentTestId: string | null;
  likelyFault: FaultCode | null;
  procedure: ProcedureAvailability;
  recommendation: RepairRecommendation | null;
  nextBestAction: NextBestAction;
  linkedRepairId: string | null;
  updatedAt: number;
}
