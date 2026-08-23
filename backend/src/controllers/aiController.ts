import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { isUsingMockDB, mockDB } from '../config/db';
import Diagnostic from '../models/Diagnostic';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { DemoScenario, demoScenarios } from '../data/demoScenarios';
import {
  analyzeFrame,
  classifyFramePayload,
  describeScenario,
  isImagePayloadPresent,
  parseImagePayload,
  verifyStepWithVision
} from '../services/aiService';
import { describeDecision, evaluateStepProgress } from '../services/repairStepService';
import { resolveScenario } from '../services/scenarioResolver';
import { DetectionResult, StepObservation } from '../types/ai';

dotenv.config();

const genAI = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY || ""
);
// The demo scenario data now lives in ../data/demoScenarios so that the AI
// service layer can reuse it without importing this controller (a circular
// import). Re-exported here so every existing importer keeps working unchanged.
export { demoScenarios };

/** Convert a 0..1 confidence to the 0..100 scale this API already uses. */
const toPercent = (value: number): number => Math.round(value * 10000) / 100;

/**
 * Persist a scenario-backed scan. Logic is unchanged from before; it is
 * extracted so the image and no-image paths share one implementation.
 */
const persistScenarioDiagnostic = async (
  userId: string | undefined,
  scenario: DemoScenario
): Promise<any> => {
  if (isUsingMockDB) {
    const newDiag = {
      _id: `d-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      userId: userId || null,
      deviceName: scenario.deviceName,
      deviceType: scenario.deviceType,
      confidenceScore: scenario.confidenceScore,
      componentsDetected: scenario.components,
      difficultyScore: scenario.difficultyScore,
      estimatedCost: scenario.estimatedCost,
      successProbability: scenario.successProbability,
      createdAt: new Date()
    };
    mockDB.diagnostics.push(newDiag);
    return newDiag;
  }

  const newDiag = new Diagnostic({
    userId: userId || undefined,
    deviceName: scenario.deviceName,
    deviceType: scenario.deviceType,
    confidenceScore: scenario.confidenceScore,
    componentsDetected: scenario.components,
    difficultyScore: scenario.difficultyScore,
    estimatedCost: scenario.estimatedCost,
    successProbability: scenario.successProbability
  });
  await newDiag.save();
  return newDiag;
};

// Component detection / device discovery.
//
// Three code paths, chosen by what the request actually carried:
//   - no image + scenarioId -> the original scenario-based detection, unchanged
//   - image  + scenarioId   -> scenario steps plus real AI detections
//   - image  only           -> DEVICE DISCOVERY: identify the device, then let
//                              scenarioResolver map that observation onto one of
//                              the supported scenarios (or onto nothing)
//
// `scenarioId` is optional. The image-only path is the device-identification-
// first entry point; the two scenarioId paths are untouched so existing callers
// keep working.
//
// In every path the repair steps are copied verbatim out of demoScenarios. The
// model identifies hardware; it never selects or authors a repair procedure.
//
// Every field the previous response returned is still returned with the same
// meaning. The AI output arrives in additive fields (`device`,
// `detectedComponents`, `source`, `warnings`, `aiPowered`, `scenario`).
export const detectComponents = async (req: AuthenticatedRequest, res: Response) => {
  const { scenarioId, image, frameImage } = req.body;

  // Accept `image`, or `frameImage` for symmetry with /api/ai/verify.
  const imagePayload = isImagePayloadPresent(image) ? image : frameImage;

  // ---------- Path 1: no image supplied -> existing behavior ----------
  if (!isImagePayloadPresent(imagePayload)) {
    if (!scenarioId || !demoScenarios[scenarioId]) {
      return res.status(400).json({ message: 'Invalid or missing scenario ID for detection' });
    }

    const scenario = demoScenarios[scenarioId];

    // Store this scan in the diagnostics database
    try {
      const newDiag = await persistScenarioDiagnostic(req.user?.id, scenario);
      // Canned scenario data, labelled source: 'scenario'. No model is called.
      const detection = describeScenario(scenarioId);

      return res.status(200).json({
        diagnosticId: newDiag._id.toString(),
        deviceName: scenario.deviceName,
        deviceType: scenario.deviceType,
        confidenceScore: scenario.confidenceScore,
        components: scenario.components,
        difficultyScore: scenario.difficultyScore,
        estimatedCost: scenario.estimatedCost,
        successProbability: scenario.successProbability,
        steps: scenario.steps,
        // Additive fields — existing clients can ignore these safely.
        aiPowered: false,
        device: detection.device,
        detectedComponents: detection.components,
        source: detection.source,
        warnings: detection.warnings,
        // The scenario was chosen explicitly by the caller, not resolved from an
        // image. Echoed here so every /detect response has the same shape.
        scenario: {
          id: scenarioId,
          confidence: scenario.confidenceScore / 100,
          reason: 'Scenario supplied explicitly by the client.'
        }
      });
    } catch (error) {
      return res.status(500).json({ message: 'Component detection failed', error: (error as Error).message });
    }
  }

  // ---------- Path 2: image supplied -> real AI analysis ----------
  const parsedImage = parseImagePayload(imagePayload);
  if (!parsedImage.ok) {
    return res.status(400).json({ message: parsedImage.error });
  }

  const warnings: string[] = [];
  const knownScenario: DemoScenario | undefined =
    typeof scenarioId === 'string' ? demoScenarios[scenarioId] : undefined;

  // An unrecognised id is dropped rather than forwarded, so untrusted input
  // never reaches the model prompt and no scenario is ever invented.
  if (typeof scenarioId === 'string' && scenarioId.trim() && !knownScenario) {
    warnings.push('Unrecognised scenario id was ignored.');
  }

  let detection: DetectionResult;
  try {
    detection = await analyzeFrame({
      image: parsedImage.image,
      scenarioId: knownScenario ? scenarioId : undefined
    });
  } catch (error) {
    // aiService is designed not to throw; this is a backstop.
    return res.status(502).json({ message: 'AI analysis failed', error: (error as Error).message });
  }

  const allWarnings = [...warnings, ...detection.warnings];

  // 2a. A supported scenario was supplied: the repair flow is unaffected, so
  // return exactly the same payload as before plus the AI detections.
  if (knownScenario) {
    try {
      const newDiag = await persistScenarioDiagnostic(req.user?.id, knownScenario);

      return res.status(200).json({
        diagnosticId: newDiag._id.toString(),
        deviceName: knownScenario.deviceName,
        deviceType: knownScenario.deviceType,
        confidenceScore: knownScenario.confidenceScore,
        components: knownScenario.components,
        difficultyScore: knownScenario.difficultyScore,
        estimatedCost: knownScenario.estimatedCost,
        successProbability: knownScenario.successProbability,
        steps: knownScenario.steps,
        aiPowered: true,
        device: detection.device,
        detectedComponents: detection.components,
        source: detection.source,
        warnings: allWarnings,
        // Scenario was supplied by the caller; echoed for a uniform shape.
        scenario: {
          id: scenarioId,
          confidence: knownScenario.confidenceScore / 100,
          reason: 'Scenario supplied explicitly by the client.'
        }
      });
    } catch (error) {
      return res.status(500).json({ message: 'Component detection failed', error: (error as Error).message });
    }
  }

  // 2b. Image only, no supported scenario supplied: DEVICE DISCOVERY.
  //
  // The device has already been identified by the vision layer above. Now the
  // deterministic resolver maps that observation onto one of the supported
  // repair scenarios. The resolver never calls a model and never authors steps;
  // it only ever returns a demoScenarios key or null.
  const match = resolveScenario(detection);

  // 2b-i. A supported scenario matched. Return its steps verbatim from
  // demoScenarios (never model-authored) and persist the scan, exactly like the
  // explicit-scenario path — the only difference is that the id was resolved
  // from the image instead of supplied by the caller.
  if (match.scenarioId && demoScenarios[match.scenarioId]) {
    const resolved = demoScenarios[match.scenarioId];
    try {
      const newDiag = await persistScenarioDiagnostic(req.user?.id, resolved);

      return res.status(200).json({
        diagnosticId: newDiag._id.toString(),
        // Device fields reflect what the MODEL saw, not the canned scenario, so
        // the UI can show the real identification. Steps/scoring come from the
        // resolved scenario.
        deviceName: detection.device?.model ?? detection.device?.type ?? resolved.deviceName,
        deviceType: detection.device?.type ?? resolved.deviceType,
        confidenceScore: detection.device ? toPercent(detection.device.confidence) : null,
        components: resolved.components,
        difficultyScore: resolved.difficultyScore,
        estimatedCost: resolved.estimatedCost,
        successProbability: resolved.successProbability,
        steps: resolved.steps,
        aiPowered: true,
        device: detection.device,
        detectedComponents: detection.components,
        source: detection.source,
        warnings: allWarnings,
        scenario: {
          id: match.scenarioId,
          confidence: match.confidence,
          reason: match.reason
        }
      });
    } catch (error) {
      return res.status(500).json({ message: 'Component detection failed', error: (error as Error).message });
    }
  }

  // 2b-ii. A device may have been identified, but it maps to no supported
  // scenario. Report what the model saw. No repair procedure is generated, no
  // scenario is invented, and nothing is persisted — Diagnostic requires
  // scenario-derived scoring fields and those are never fabricated.
  return res.status(200).json({
    diagnosticId: null,
    deviceName: detection.device?.model ?? detection.device?.type ?? null,
    deviceType: detection.device?.type ?? null,
    confidenceScore: detection.device ? toPercent(detection.device.confidence) : null,
    components: [],
    difficultyScore: null,
    estimatedCost: null,
    successProbability: null,
    steps: [],
    aiPowered: true,
    device: detection.device,
    detectedComponents: detection.components,
    source: detection.source,
    warnings: allWarnings,
    // Always null here, but the field is present so the client can rely on it.
    scenario: null,
    message: detection.device
      ? 'Device identified from image. No supported repair scenario matches this detection yet.'
      : 'No device could be identified in the supplied image.'
  });
};

// Repair step verification.
//
// Two code paths, chosen by whether the request carried a usable camera frame:
//   - no usable frame -> the existing simulated verification, values unchanged
//   - usable frame    -> real vision evaluation of the CURRENT step only
//
// The split of responsibilities is the important part:
//
//   the vision layer (aiService -> provider -> normalizer) reports what it SEES
//   repairStepService decides, deterministically, what the user is TOLD
//
// Every instruction in the response is copied verbatim out of demoScenarios. No
// model output can select or author a repair step.
export const verifyStep = async (req: AuthenticatedRequest, res: Response) => {
  const { scenarioId, stepIndex, frameImage, image } = req.body; // frameImage is base64 snapshot

  // ---------- Guards, unchanged from before ----------
  if (!scenarioId || stepIndex === undefined) {
    return res.status(400).json({ message: 'Missing scenarioId or stepIndex for verification' });
  }

  const scenario = demoScenarios[scenarioId];
  if (!scenario) {
    return res.status(404).json({ message: 'Scenario not found' });
  }

  const currentStepData = scenario.steps.find(s => s.stepIndex === stepIndex);
  if (!currentStepData) {
    return res.status(404).json({ message: 'Step index out of range' });
  }

  // Accept `frameImage`, or `image` for symmetry with /api/ai/detect.
  const framePayload = isImagePayloadPresent(frameImage) ? frameImage : image;
  const frame = classifyFramePayload(framePayload);

  // A corrupt or oversized frame is a client bug: report it and do NOT spend a
  // model call on it.
  if (frame.kind === 'invalid') {
    return res.status(400).json({ message: frame.error });
  }

  // ---------- Path 1: a real frame -> real visual evaluation ----------
  if (frame.kind === 'image') {
    const { observation, timings } = await verifyStepWithVision({
      image: frame.image,
      // Only the current step is handed to the provider. The other steps, the
      // device profile and the chat context are all withheld.
      step: {
        stepIndex,
        stepTitle: currentStepData.stepTitle,
        verificationTrigger: currentStepData.verificationTrigger,
        safetyRisk: currentStepData.safetyRisk
      },
      scenarioId
    });

    const decision = evaluateStepProgress({ scenario, stepIndex, observation });

    return res.status(200).json({
      // Existing fields, same names and same meaning. `verified` is true only
      // for a COMPLETED decision, so it stays fail-closed.
      verified: decision.status === 'COMPLETED',
      message: describeDecision(decision),
      // Kept as a 0-100 string to match the existing format. null when the
      // provider gave no trustworthy value — a confidence is never invented.
      confidence: decision.confidence === null ? null : (decision.confidence * 100).toFixed(2),
      timestamp: new Date(),

      // Additive fields.
      status: decision.status,
      confidenceRatio: decision.confidence,
      confidenceThreshold: decision.threshold,
      aiPowered: true,
      source: observation.source,
      currentStep: decision.currentStep,
      nextStep: decision.nextStep,
      repairComplete: decision.repairComplete,
      totalSteps: decision.totalSteps,
      reason: decision.reason,
      // Model-authored evidence, validated. Kept out of `message` so provider
      // text can never be mistaken for repair guidance.
      observations: observation.observations,
      components: observation.components,
      warnings: observation.warnings,
      persistenceHint: decision.persistenceHint,
      timings
    });
  }

  // ---------- Path 2: no usable frame -> existing simulated behavior ----------
  // Simulate CV frame evaluation. In a real system, we'd pass the frame to a model.
  // To make it look extremely premium, we simulate a 90% chance of verification success,
  // or a slight processing log.
  const isVerified = Math.random() > 0.15; // 85% success rate for simulation response

  const logMessages: Record<string, string> = {
    screws_removed: 'AI verified all casing screws have been unfastened. No tension lines detected on case.',
    battery_disconnected: 'AI detected visual gap in the battery connector terminal. Volts set to 0.0V.',
    clips_opened: 'AI detected metal retention levers pushed aside. RAM modules rotated to 30-degree tilt.',
    ram_inserted: 'AI verified RAM gold contacts fully seated and retention bracket clips locked.',
    cover_removed: 'AI observed case slide movement. PC interior component block is fully visible.',
    m2_located: 'AI matches coordinates for PCIe M.2 NVMe slot configuration.',
    screw_removed: 'AI detected screw removed from motherboard standoff index.',
    ssd_secured: 'AI detected M.2 NVMe board mounted flat in slot with terminal screw tightened.',
    back_heated: 'Thermal analysis verifies cover perimeter glue softened (>65°C).',
    back_separated: 'AI observed case back cover removal. Motherboard ribbon connectors exposed.',
    coil_removed: 'AI detected charging wire induction plate assembly decoupled.',
    shield_removed: 'AI observed metallic board plate removal. USB sub-board now visible.',
    board_replaced: 'AI verified sub-board swap. Multi-pins connected to main terminal.',
    feet_removed: 'AI verified rubber pads removed from bottom plastic socket holes.',
    housing_opened: 'AI observed router top shell removed. Wireless boards accessible.',
    antennas_checked: 'AI detected micro-coaxial (U.FL) connections visualised.',
    leads_secured: 'AI verified coaxial feed snapped down. Resistance match detected.'
  };

  const trigger = currentStepData.verificationTrigger;
  const verificationLog = isVerified
    ? (logMessages[trigger] || 'AI visual analysis confirms step completion.')
    : 'Waiting for camera alignment. Make sure the component is fully visible in the frame.';

  const simulatedConfidence = (85 + Math.random() * 14).toFixed(2);

  // Run the simulated outcome through the same deterministic evaluator so the
  // additive fields mean exactly the same thing on both paths.
  const simulatedObservation: StepObservation = {
    stepCompleted: isVerified,
    confidence: Number(simulatedConfidence) / 100,
    observations: [],
    components: [],
    source: 'simulated',
    warnings:
      frame.kind === 'placeholder'
        ? [frame.reason, 'No frame was analysed; this result is simulated.']
        : ['No frame was supplied; this result is simulated.']
  };

  const decision = evaluateStepProgress({ scenario, stepIndex, observation: simulatedObservation });

  return res.status(200).json({
    // Existing fields, identical values and identical formats.
    verified: isVerified,
    message: verificationLog,
    confidence: simulatedConfidence,
    timestamp: new Date(),

    // Additive fields, so a client can use one code path for both modes.
    status: decision.status,
    confidenceRatio: simulatedObservation.confidence,
    confidenceThreshold: decision.threshold,
    aiPowered: false,
    source: simulatedObservation.source,
    currentStep: decision.currentStep,
    nextStep: decision.nextStep,
    repairComplete: decision.repairComplete,
    totalSteps: decision.totalSteps,
    reason: decision.reason,
    observations: simulatedObservation.observations,
    components: simulatedObservation.components,
    warnings: simulatedObservation.warnings,
    persistenceHint: decision.persistenceHint
  });
};

// AI Persistent Chat Assistant
export const queryAssistant = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { message, scenarioId } = req.body;

    if (!message) {
      return res.status(400).json({
        message: "Empty query message"
      });
    }

    const scenario = scenarioId
      ? demoScenarios[scenarioId]
      : null;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash"
    });

    const prompt = `
You are RepairAI Copilot, an expert electronics repair assistant.

Device:
${scenario?.deviceName || "Unknown Device"}

Device Type:
${scenario?.deviceType || "Unknown"}

Repair Context:
${scenario?.chatContext || "General electronics repair"}

User Question:
${message}

Instructions:
- Give clear repair guidance.
- Mention safety precautions when needed.
- Mention tools required if relevant.
- Be concise but helpful.
- Use professional technician-style language.
`;

    const result = await model.generateContent(prompt);

    const reply = result.response.text();

    return res.status(200).json({
      reply,
      timestamp: new Date()
    });

  } catch (error: any) {
    console.error("Gemini Error:", error);

    return res.status(500).json({
      reply: "Sorry, Gemini AI is currently unavailable.",
      error: error.message,
      timestamp: new Date()
    });
  }
};

