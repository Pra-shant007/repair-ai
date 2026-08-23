'use client';

import React, { Suspense, useState, useEffect, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { 
  Play, 
  Volume2, 
  VolumeX, 
  Mic, 
  MicOff, 
  Wrench, 
  ShieldAlert, 
  CheckCircle2, 
  ArrowRight, 
  ArrowLeft, 
  AlertTriangle, 
  Cpu, 
  FileText, 
  Activity, 
  Sparkles, 
  RefreshCw,
  Terminal,
  HelpCircle,
  Award,
  Stethoscope,
  Eye,
  Brain,
  ThumbsUp,
  ThumbsDown,
  Ban
} from 'lucide-react';
import { demoScenarios, IRepairStep } from '@/utils/repairGuides';
import { downloadReport } from '@/utils/pdfGenerator';
import CameraFeed, { CameraFeedHandle } from '@/components/CameraFeed';
import Chatbot from '@/components/Chatbot';
import {
  interpretVerification,
  errorView,
  canVerifyWithFrame,
  nextTransition,
  resolveCompletion,
  VerificationView,
  NormalizedComponent,
  PersistOutcome,
} from '@/utils/verifyClient';
import {
  interpretDiagnosis,
  errorDiagnosisView,
  errorKindForStatus,
  canStartDiagnosis,
  handoff,
  DiagnosisView,
  DiagnosticAnswer,
} from '@/utils/diagnoseClient';

// Single source for the backend origin. Override with NEXT_PUBLIC_API_BASE_URL
// (e.g. http://localhost:5000) to point the UI at a local mock/Gemini backend
// for testing; defaults to the deployed instance.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'https://repair-ai.onrender.com';

// How long to wait on a single verification round-trip before giving up. The
// Gemini provider itself times out at 20s, so this leaves margin for overhead.
const VERIFY_TIMEOUT_MS = 30000;

// The manual "Override" button lets a user bypass visual verification and mark a
// step complete by hand. It is OFF by default and only appears when explicitly
// enabled via NEXT_PUBLIC_ENABLE_REPAIR_OVERRIDE=true. The real demo must rely on
// AI verification, not a bypass, so this stays false unless deliberately set.
const REPAIR_OVERRIDE_ENABLED = process.env.NEXT_PUBLIC_ENABLE_REPAIR_OVERRIDE === 'true';

function DiagnoseContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // DEVICE-IDENTIFICATION-FIRST vs explicit selection.
  //
  // A valid `?scenario=<id>` means the caller already chose a repair (e.g. a
  // "Start this repair" link from the knowledge base, or the in-page "Active
  // Guide" selector). No param means DISCOVERY-FIRST: the scenario is unknown
  // until the camera identifies the device and the backend resolver maps it.
  const requestedScenario = searchParams.get('scenario');
  const explicitScenarioId =
    requestedScenario && demoScenarios[requestedScenario] ? requestedScenario : null;

  // While discovering, scenarioId holds a harmless placeholder so
  // demoScenarios[scenarioId] is always defined; the repair UI stays hidden
  // (phase !== 'repair') so the placeholder is never shown as a real match.
  const [scenarioId, setScenarioId] = useState(explicitScenarioId ?? 'laptop_ram_upgrade');

  // 'discovery' identifies the device first; 'repair' means a scenario is locked
  // in (either resolved from the image, or supplied explicitly via the URL).
  // 'diagnostic' is the symptom-driven copilot loop that can run BEFORE a repair
  // and, when it lands on a grounded procedure, hands off into 'repair'.
  const [phase, setPhase] = useState<'discovery' | 'diagnostic' | 'repair'>(
    explicitScenarioId ? 'repair' : 'discovery'
  );

  const activeScenario = demoScenarios[scenarioId];

  // Repair State Variables
  const [currentStepIdx, setCurrentStepIdx] = useState(1);
  const [completedSteps, setCompletedSteps] = useState<Record<number, boolean>>({});
  const [safetyChecked, setSafetyChecked] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationLogs, setVerificationLogs] = useState<string[]>([]);
  const [repairId, setRepairId] = useState<string | null>(null);
  const [diagnosticId, setDiagnosticId] = useState<string | null>(null);
  
  // Real-time confidence scores and statistics
  const [aiConfidence, setAiConfidence] = useState(0);
  const [isCompleted, setIsCompleted] = useState(false);

  // Imperative handle to the camera, used to grab ONE frame per verify action.
  const cameraRef = useRef<CameraFeedHandle | null>(null);
  // Latest interpreted /api/ai/verify result, rendered in the result panel.
  const [verification, setVerification] = useState<VerificationView | null>(null);
  // Real AI-detected components (normalized 0..1) for the live camera overlay.
  const [detectedComponents, setDetectedComponents] = useState<NormalizedComponent[]>([]);

  // ---- Device-discovery (image-first) readout ----
  // True while a single discovery frame is in flight.
  const [isDiscovering, setIsDiscovering] = useState(false);
  // What the vision layer actually identified in the last scan (independent of
  // whether it resolved to a supported scenario).
  const [discoveredDevice, setDiscoveredDevice] = useState<{
    name: string;
    type: string | null;
    confidencePercent: number | null;
  } | null>(null);
  // Set when a device was identified but maps to no supported scenario, when no
  // device could be identified, or when the scan itself failed. Shown in-panel.
  const [discoveryNotice, setDiscoveryNotice] = useState<string | null>(null);

  // ---- Diagnostic copilot (symptom-driven) ----
  // What the user typed into "What problem are you experiencing?".
  const [symptomText, setSymptomText] = useState('');
  // Latest interpreted diagnosis session, rendered as the four panels.
  const [diagnosis, setDiagnosis] = useState<DiagnosisView | null>(null);
  // Single busy flag for the whole diagnostic channel. Every diagnostic request
  // checks it first, so a double tap / impatient retry can never put two AI
  // requests in flight for the same session.
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  // Ref mirror of the busy flag: state updates are async, so two clicks in the
  // same tick would both see `isDiagnosing === false`. The ref closes that gap.
  const diagnoseBusyRef = useRef(false);

  // Hands-free voice assistant configurations
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isMicActive, setIsMicActive] = useState(false);
  const [speechTranscript, setSpeechTranscript] = useState('');
  const recognitionRef = useRef<any>(null);

  // Fluctuating confidence score simulation
  useEffect(() => {
    // Only meaningful once a scenario is locked in. During discovery the readout
    // shows the live device-identification confidence instead of a scenario's.
    if (phase !== 'repair') return;
    if (isCompleted) {
      setAiConfidence(100);
      return;
    }
    setAiConfidence(activeScenario.confidenceScore);
    const interval = setInterval(() => {
      const fluctuation = (Math.random() * 1.5 - 0.75).toFixed(2);
      setAiConfidence(() => {
        const base = activeScenario.confidenceScore;
        const val = parseFloat(base.toString()) + parseFloat(fluctuation);
        return parseFloat(Math.min(99.9, Math.max(85, val)).toFixed(2));
      });
    }, 1500);

    return () => clearInterval(interval);
  }, [scenarioId, isCompleted, phase]);

  // Track if user is authenticated
  const [authToken, setAuthToken] = useState<string | null>(null);
  // Guards the one-time auto-start for the explicit ?scenario= path so it never
  // re-fires and opens a second repair session.
  const explicitStartedRef = useRef(false);

  useEffect(() => {
    const token = localStorage.getItem('token');
    setAuthToken(token);

    // Explicit scenario supplied in the URL -> preserve the original behavior:
    // run the scenario-first detection and (if signed in) open a repair session
    // immediately. DISCOVERY-FIRST (no explicit scenario) instead waits for the
    // user to scan a device — nothing is started until a scenario is resolved.
    if (explicitScenarioId && !explicitStartedRef.current) {
      explicitStartedRef.current = true;
      startRepairForScenario(explicitScenarioId, token);
    }
    // Runs once on mount; explicitScenarioId is derived from the initial URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start (or restart) a repair for an EXPLICITLY chosen scenario: the URL
  // ?scenario= param or the in-page "Active Guide" selector. This is the
  // scenario-FIRST path and its behavior is unchanged from before — it runs the
  // canned scenario detection to obtain a diagnosticId and opens a server repair
  // session. (runDeviceDiscovery below is the image-first alternative.)
  //
  // Parameterized by an explicit id (rather than reading the scenarioId state)
  // so a caller that has just changed the selection is not affected by the
  // async state update.
  const startRepairForScenario = async (scId: string, token: string | null) => {
    const scenario = demoScenarios[scId];
    if (!scenario) return;

    setScenarioId(scId);
    setPhase('repair');
    setDiscoveredDevice(null);
    setDiscoveryNotice(null);
    setCurrentStepIdx(1);
    setCompletedSteps({});
    setSafetyChecked(false);
    setIsCompleted(false);
    setVerification(null);
    setDetectedComponents([]);
    setVerificationLogs([`⚡ [SYSTEM] Launching Vision AI for ${scenario.deviceName}...`]);

    try {
      const res = await fetch(`${API_BASE}/api/ai/detect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({ scenarioId: scId }),
      });

      if (res.ok) {
        const data = await res.json();
        setDiagnosticId(data.diagnosticId);
        setVerificationLogs((prev) => [
          ...prev,
          `✅ [VISION] Device Identified: ${data.deviceName} (${data.deviceType})`,
          `🔎 [VISION] Detected ${data.components.length} micro-components on layout canvas.`,
          `📢 [COPILOT] Step 1 Loaded: "${scenario.steps[0].stepTitle}"`,
        ]);

        // Start repair session on server if authenticated
        if (token) {
          startServerRepairSession(scId, token, data.diagnosticId);
        }
      } else {
        throw new Error('API server unavailable');
      }
    } catch (e) {
      console.warn('Backend is offline. Running client-side component detection.');
      // Offline fallback
      setDiagnosticId(`mock-diag-${Date.now()}`);
      setTimeout(() => {
        setVerificationLogs((prev) => [
          ...prev,
          `✅ [VISION] Device Identified: ${scenario.deviceName} (${scenario.deviceType})`,
          `🔎 [VISION] Components mapped: ${scenario.components.map((c) => c.name).join(', ')}`,
          `📢 [COPILOT] Step 1 Loaded: "${scenario.steps[0].stepTitle}"`,
        ]);
      }, 500);
    }
  };

  // DEVICE-IDENTIFICATION-FIRST discovery (image-first).
  //
  // Captures exactly ONE frame, asks the backend to identify the device, and
  // lets the server-side resolver map that observation onto a supported repair
  // scenario. The scenario is NOT assumed here and the repair session is NOT
  // started until resolution actually succeeds. Steps always come from the
  // backend (which copies them verbatim from demoScenarios); the frontend never
  // authors or picks a procedure.
  const runDeviceDiscovery = async () => {
    if (isDiscovering) return;

    // Exactly like verification: with no live frame we must NOT fall through to
    // the backend's no-image path. Tell the user and stop — no request is sent.
    const frame = cameraRef.current?.captureFrame() ?? null;
    if (!canVerifyWithFrame(frame)) {
      setDiscoveryNotice(
        'No live camera frame available. Allow camera access, point it at the device, then scan again.'
      );
      setVerificationLogs((prev) => [
        ...prev,
        '🚫 [VISION] No live camera frame. Point the camera at the device and scan again.',
      ]);
      return;
    }

    setIsDiscovering(true);
    setDiscoveryNotice(null);
    setDiscoveredDevice(null);
    setDetectedComponents([]);
    setVerificationLogs(['⚡ [SYSTEM] Scanning frame to identify device...']);

    try {
      const res = await fetch(`${API_BASE}/api/ai/detect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authToken ? `Bearer ${authToken}` : '',
        },
        // Image ONLY, no scenarioId: this is the discovery entry point.
        body: JSON.stringify({ image: frame }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();

      // Draw whatever the model actually saw, regardless of resolution outcome.
      setDetectedComponents(
        Array.isArray(data.detectedComponents) ? data.detectedComponents : []
      );

      const resolvedId: string | null =
        data.scenario && data.scenario.id && demoScenarios[data.scenario.id]
          ? (data.scenario.id as string)
          : null;

      if (resolvedId) {
        // A supported scenario was resolved from the image. Lock it in.
        const resolvedScenario = demoScenarios[resolvedId];

        setDiscoveredDevice({
          name: data.deviceName ?? resolvedScenario.deviceName,
          type: data.deviceType ?? resolvedScenario.deviceType,
          confidencePercent:
            typeof data.confidenceScore === 'number' ? Math.round(data.confidenceScore) : null,
        });

        setVerificationLogs((prev) => [
          ...prev,
          `✅ [VISION] Device Identified: ${data.deviceName ?? 'device'} (${
            data.deviceType ?? 'unknown type'
          })`,
          `🔎 [VISION] ${data.detectedComponents?.length ?? 0} component(s) detected.`,
          `🧭 [RESOLVER] Matched supported scenario: ${resolvedScenario.deviceName} — ${data.scenario.reason}`,
          `📢 [COPILOT] Step 1 Loaded: "${resolvedScenario.steps[0].stepTitle}"`,
        ]);

        // Reset repair state for the resolved scenario, then enter repair phase.
        setDiagnosticId(data.diagnosticId ?? null);
        setScenarioId(resolvedId);
        setCurrentStepIdx(1);
        setCompletedSteps({});
        setSafetyChecked(false);
        setIsCompleted(false);
        setVerification(null);
        setPhase('repair');

        // Open a server-side repair session using the RESOLVED id and the
        // diagnostic the discovery call already persisted. No second detect.
        if (authToken && data.diagnosticId) {
          startServerRepairSession(resolvedId, authToken, data.diagnosticId);
        }
      } else if (data.device) {
        // A device was identified, but it maps to no supported procedure.
        setDiscoveredDevice({
          name: data.deviceName ?? 'Unrecognized device',
          type: data.deviceType ?? null,
          confidencePercent:
            typeof data.confidenceScore === 'number' ? Math.round(data.confidenceScore) : null,
        });
        setDiscoveryNotice('Device detected, but no supported repair procedure is available.');
        setVerificationLogs((prev) => [
          ...prev,
          `✅ [VISION] Device Identified: ${data.deviceName ?? 'device'} (${
            data.deviceType ?? 'unknown type'
          })`,
          '⛔ [RESOLVER] No supported repair procedure matches this device.',
        ]);
      } else {
        // Nothing identifiable in the frame.
        setDiscoveredDevice(null);
        setDiscoveryNotice(
          'No device could be identified. Move closer, improve lighting, and scan again.'
        );
        setVerificationLogs((prev) => [
          ...prev,
          '⛔ [VISION] No device could be identified in the frame.',
        ]);
      }
    } catch (e) {
      setDiscoveryNotice(
        'Device identification is unavailable right now. Check your connection and scan again.'
      );
      setVerificationLogs((prev) => [
        ...prev,
        `⚠️ [ERROR] Device identification failed: ${
          e instanceof Error ? e.message : 'unknown error'
        }.`,
      ]);
    } finally {
      setIsDiscovering(false);
    }
  };

  // Start repair session on the backend. Parameterized by an explicit scenario
  // id so both entry paths (explicit selection and resolved discovery) share it.
  const startServerRepairSession = async (scId: string, token: string, diagId: string) => {
    const scenario = demoScenarios[scId];
    if (!scenario) return;
    try {
      const res = await fetch(`${API_BASE}/api/repairs/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          diagnosticId: diagId,
          scenarioId: scId,
          deviceName: scenario.deviceName,
          deviceType: scenario.deviceType,
          steps: scenario.steps,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setRepairId(data._id);
      }
    } catch (e) {
      console.error('Failed to start repair tracking:', e);
    }
  };

  // ------------------------------------------------------------------
  // DIAGNOSTIC COPILOT
  //
  // Symptom-driven loop that runs BEFORE any repair: the user describes what is
  // wrong, the backend perceives the device, proposes fault hypotheses, and picks
  // the single safest next check. The frontend NEVER decides what the user should
  // physically do — it renders `nextBestAction` verbatim and posts the answer
  // back. When the backend confirms a fault that has a grounded procedure, the
  // user is handed to the EXISTING repair flow; no second repair flow exists.
  //
  // Camera policy: the preview stays live continuously, but frames are only sent
  // on an explicit user action (starting a diagnosis). Answering a check costs no
  // AI call at all — the backend updates hypotheses deterministically.
  // ------------------------------------------------------------------

  /** POST JSON to the diagnostic API with a timeout. Returns the parsed body. */
  const postDiagnostic = async (
    path: string,
    body: Record<string, unknown>
  ): Promise<{ ok: boolean; status: number; data: any }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authToken ? `Bearer ${authToken}` : '',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  };

  /** Append the copilot's reasoning to the shared log console. */
  const logDiagnosis = (view: DiagnosisView) => {
    const lines: string[] = [];
    if (view.deviceLabel) lines.push(`✅ [VISION] Device: ${view.deviceLabel}`);
    if (view.think.length > 0) {
      lines.push(
        `🧠 [REASONING] ${view.think
          .slice(0, 3)
          .map((h) => `${h.label} ${h.confidencePercent}%`)
          .join(' · ')}`
      );
    }
    if (view.action) {
      lines.push(`🧭 [SELECTOR] Next check (${view.action.riskLevel}): ${view.action.title}`);
    }
    if (view.confirmed) lines.push(`🎯 [DIAGNOSIS] ${view.message}`);
    if (view.status === 'UNSAFE_TO_GUIDE') {
      lines.push('⛔ [SAFETY] Remaining checks are gated. Not auto-offering an unsafe action.');
    }
    if (view.status === 'ERROR') lines.push(`⚠️ [ERROR] ${view.message}`);
    for (const w of view.warnings) lines.push(`⚠️ [MODEL] ${w}`);
    if (lines.length > 0) setVerificationLogs((prev) => [...prev, ...lines]);
  };

  /**
   * Start a diagnosis: at most ONE perception call plus ONE reasoning call on the
   * server. Sends a live frame only when a real one exists — never a placeholder.
   */
  const runDiagnosis = async () => {
    if (diagnoseBusyRef.current) return;

    const frame = cameraRef.current?.captureFrame() ?? null;
    if (!canStartDiagnosis(symptomText, frame)) {
      setDiagnosis(errorDiagnosisView('camera_unavailable'));
      setVerificationLogs((prev) => [
        ...prev,
        '🚫 [COPILOT] Nothing to diagnose: no live frame and no description.',
      ]);
      return;
    }

    diagnoseBusyRef.current = true;
    setIsDiagnosing(true);
    setDiagnosis(null);
    setDiscoveryNotice(null);
    setPhase('diagnostic');
    setVerificationLogs(['⚡ [COPILOT] Starting diagnosis from your description…']);

    try {
      const { ok, status, data } = await postDiagnostic('/api/ai/diagnose', {
        // Image only when it is a genuine live capture.
        ...(canVerifyWithFrame(frame) ? { image: frame } : {}),
        userDescription: symptomText,
        sessionId: null,
      });

      const view = ok
        ? interpretDiagnosis(data ?? {})
        : errorDiagnosisView(errorKindForStatus(status), data?.message);
      setDiagnosis(view);
      logDiagnosis(view);
    } catch (e) {
      const view = errorDiagnosisView('network', e instanceof Error ? e.message : undefined);
      setDiagnosis(view);
      logDiagnosis(view);
    } finally {
      diagnoseBusyRef.current = false;
      setIsDiagnosing(false);
    }
  };

  /**
   * Report the outcome of the pending check. Costs ZERO AI calls: the backend
   * updates hypotheses from its own hand-written interpretation of the answer.
   */
  const answerDiagnosticCheck = async (answer: DiagnosticAnswer) => {
    if (diagnoseBusyRef.current) return;

    const sessionId = diagnosis?.sessionId;
    const action = diagnosis?.action;
    if (!sessionId || !action || !action.answerable || !action.testId) return;

    diagnoseBusyRef.current = true;
    setIsDiagnosing(true);
    setVerificationLogs((prev) => [
      ...prev,
      `🙋 [USER] ${action.title} → ${answer === 'unclear' ? 'not sure' : answer}`,
    ]);

    try {
      const { ok, status, data } = await postDiagnostic(
        `/api/ai/diagnose/${encodeURIComponent(sessionId)}/result`,
        { answer, testId: action.testId }
      );

      const view = ok
        ? interpretDiagnosis(data ?? {})
        : errorDiagnosisView(errorKindForStatus(status), data?.message);
      setDiagnosis(view);
      logDiagnosis(view);
    } catch (e) {
      const view = errorDiagnosisView('network', e instanceof Error ? e.message : undefined);
      setDiagnosis(view);
      logDiagnosis(view);
    } finally {
      diagnoseBusyRef.current = false;
      setIsDiagnosing(false);
    }
  };

  // The diagnosis session a grounded repair was started from, so the link can be
  // recorded once the repair session id comes back from the server.
  const linkedDiagnosisRef = useRef<string | null>(null);

  /**
   * Hand off to the EXISTING repair flow. Only reachable when the backend both
   * confirmed a fault and published a grounded procedure for it, so an arbitrary
   * unsupported device can never open a step-by-step repair.
   */
  const startGroundedRepair = () => {
    const decision = handoff(diagnosis);
    if (decision.kind !== 'repair') return;
    if (!demoScenarios[decision.scenarioId]) {
      // The server named a procedure this build does not ship. Stay advisory.
      setDiscoveryNotice(
        'The recommended procedure is not available in this build, so I can only advise.'
      );
      return;
    }
    linkedDiagnosisRef.current = diagnosis?.sessionId ?? null;
    // Existing entry point — same code path as the ?scenario= link and the
    // in-page guide selector. Nothing about the repair flow is duplicated here.
    startRepairForScenario(decision.scenarioId, authToken);
  };

  // Record diagnosis -> repair on the server once the repair session exists.
  // Best-effort and non-blocking: the repair works whether or not this lands.
  useEffect(() => {
    const diagSessionId = linkedDiagnosisRef.current;
    if (!repairId || !diagSessionId) return;
    linkedDiagnosisRef.current = null;
    postDiagnostic(`/api/ai/diagnose/${encodeURIComponent(diagSessionId)}/repair`, {
      repairId,
    }).catch(() => {
      /* the link is bookkeeping only */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repairId]);

  /** Abandon the current diagnosis and go back to the scan/describe screen. */
  const resetDiagnosis = () => {
    if (diagnoseBusyRef.current) return;
    setDiagnosis(null);
    setPhase('discovery');
    setVerificationLogs([]);
  };

  // 2. Text-to-Speech (TTS) Voice Synthesis
  const speakText = (text: string) => {
    if (!isVoiceActive || typeof window === 'undefined') return;
    window.speechSynthesis.cancel(); // cancel current spoken cues
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  };

  // Speak step whenever it changes
  useEffect(() => {
    if (activeScenario && isVoiceActive) {
      const step = activeScenario.steps.find((s) => s.stepIndex === currentStepIdx);
      if (step) {
        const riskWarning = step.safetyRisk !== 'safe' ? 'Caution, safety warning active. ' : '';
        speakText(`${riskWarning}Step ${currentStepIdx}: ${step.stepTitle}`);
      }
    }
  }, [currentStepIdx, isVoiceActive, scenarioId]);

  // 3. Speech Recognition (STT) hands-free control setup
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      console.warn('Speech Recognition not supported in this browser.');
      return;
    }

    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = 'en-US';

    rec.onresult = (event: any) => {
      const resultText = event.results[event.results.length - 1][0].transcript.toLowerCase().trim();
      setSpeechTranscript(resultText);
      setVerificationLogs((prev) => [...prev, `🎙️ [VOICE COMMAND] Heard: "${resultText}"`]);

      if (resultText.includes('next') || resultText.includes('proceed') || resultText.includes('forward')) {
        handleNextStep();
      } else if (resultText.includes('back') || resultText.includes('previous') || resultText.includes('go back')) {
        handlePrevStep();
      } else if (resultText.includes('verify') || resultText.includes('check') || resultText.includes('scan')) {
        handleVerifyStep();
      } else if (resultText.includes('repeat') || resultText.includes('say again')) {
        const step = activeScenario.steps.find((s) => s.stepIndex === currentStepIdx);
        if (step) speakText(step.stepTitle);
      }
    };

    rec.onend = () => {
      if (isMicActive) {
        // Automatically restart if it stops but mic toggle is still true
        try {
          rec.start();
        } catch (e) {}
      }
    };

    recognitionRef.current = rec;

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, [isMicActive, currentStepIdx]);

  const toggleMic = () => {
    if (!recognitionRef.current) {
      alert('Speech Recognition is not supported or initialized in this browser.');
      return;
    }

    if (isMicActive) {
      recognitionRef.current.stop();
      setIsMicActive(false);
      setVerificationLogs((prev) => [...prev, '🎙️ [VOICE] Microphone disabled. Hands-free commands off.']);
    } else {
      try {
        recognitionRef.current.start();
        setIsMicActive(true);
        setVerificationLogs((prev) => [...prev, '🎙️ [VOICE] Microphone listening. Command list: "Next", "Back", "Verify", "Repeat".']);
        speakText('Voice commands activated. Speak clearly.');
      } catch (e) {
        console.error('Mic start error:', e);
      }
    }
  };

  const toggleVoice = () => {
    if (!isVoiceActive) {
      setIsVoiceActive(true);
      setVerificationLogs((prev) => [...prev, '🔊 [AUDIO] Voice synthesizer enabled. Guide will speak instructions.']);
      const step = activeScenario.steps.find((s) => s.stepIndex === currentStepIdx);
      if (step) speakText(`Voice instructions enabled. Step ${currentStepIdx}: ${step.stepTitle}`);
    } else {
      setIsVoiceActive(false);
      window.speechSynthesis.cancel();
      setVerificationLogs((prev) => [...prev, '🔇 [AUDIO] Voice synthesizer muted.']);
    }
  };

  // Get active step details
  const activeStep = activeScenario.steps.find((s) => s.stepIndex === currentStepIdx) as IRepairStep;
  const isHighRisk = activeStep?.safetyRisk === 'high';
  const isMediumRisk = activeStep?.safetyRisk === 'medium';
  const riskLocked = (isHighRisk || isMediumRisk) && !safetyChecked;

  // Determine active component names to highlight on camera feed
  const getActiveComponents = (): string[] => {
    if (!activeStep) return [];
    const lowerTitle = activeStep.stepTitle.toLowerCase();
    
    // Simple regex mapping to identify which components relate to this step
    const matches: string[] = [];
    activeScenario.components.forEach(c => {
      const compWords = c.name.toLowerCase().split(' ');
      const hasWord = compWords.some(w => w.length > 2 && lowerTitle.includes(w));
      if (hasWord || lowerTitle.includes(c.name.toLowerCase())) {
        matches.push(c.name);
      }
    });

    // Fallback default components if no match to make boxes shine
    if (matches.length === 0) {
      if (lowerTitle.includes('battery') || lowerTitle.includes('connector')) {
        return ['Battery Connection', 'Main Battery Pack', 'Battery Pack'];
      }
      if (lowerTitle.includes('ram') || lowerTitle.includes('memory') || lowerTitle.includes('clip')) {
        return ['RAM Slot A', 'RAM Slot B'];
      }
      if (lowerTitle.includes('ssd') || lowerTitle.includes('m.2') || lowerTitle.includes('drive')) {
        return ['M.2 NVMe Slot', 'SSD'];
      }
      if (lowerTitle.includes('screw') || lowerTitle.includes('cover') || lowerTitle.includes('case')) {
        return activeScenario.components.map(c => c.name); // show all
      }
    }
    return matches;
  };

  const activeComponentNames = getActiveComponents();

  // Apply a verification verdict to the UI. This is the ONLY place a step is
  // marked complete, and it is gated strictly on an explicit COMPLETED verdict —
  // a successful request with any other status never advances the repair.
  //
  // For a COMPLETED verdict the current step is persisted to the server BEFORE
  // it is presented as done. Persistence is awaited; if it fails we swap in a
  // persist_failed error, keep the step active, and never mark it complete — a
  // save failure can never masquerade as progress.
  const applyVerification = async (view: VerificationView) => {
    let resolved = view;
    let markComplete = false;

    if (view.status === 'COMPLETED') {
      let persist: PersistOutcome = 'skipped';
      if (authToken && repairId) {
        const saved = await updateServerRepairStep(currentStepIdx, true);
        persist = saved ? 'ok' : 'failed';
      }
      const outcome = resolveCompletion(view, persist);
      resolved = outcome.view;
      markComplete = outcome.markStepComplete;
    }

    setVerification(resolved);
    // Reflect the latest detections on the overlay (empty array clears stale boxes).
    setDetectedComponents(resolved.components);

    const scoreLabel =
      resolved.confidencePercent != null ? `${resolved.confidencePercent}%` : 'n/a';

    if (markComplete) {
      // COMPLETED and persisted to the server (or persistence skipped for a
      // guest session with no repairId).
      setVerificationLogs((prev) => [
        ...prev,
        `🤖 [AI AGENT] Confidence: ${scoreLabel}`,
        `✅ [VERIFIED] ${resolved.message}`,
        ...(resolved.nextStep ? [`📢 [COPILOT] Next step ready: "${resolved.nextStep.title}"`] : []),
        ...(resolved.repairComplete ? ['🏆 [SYSTEM] Final step verified — repair complete.'] : []),
      ]);
      // Mark ONLY the current step complete. The actual advance to nextStep is
      // driven by the backend's nextStep in handleNextStep, never by a blind +1.
      setCompletedSteps((prev) => ({ ...prev, [currentStepIdx]: true }));
      speakText(
        resolved.repairComplete
          ? 'Final step verified. Repair complete.'
          : 'Step verified. You may proceed to the next step.',
      );
    } else if (resolved.status === 'NOT_COMPLETED') {
      setVerificationLogs((prev) => [
        ...prev,
        `🤖 [AI AGENT] Confidence: ${scoreLabel}`,
        `❌ [PENDING] ${resolved.message}`,
      ]);
      speakText('This step does not look complete yet. Keep going, then verify again.');
    } else if (resolved.status === 'UNCERTAIN') {
      setVerificationLogs((prev) => [
        ...prev,
        `🤖 [AI AGENT] Confidence: ${scoreLabel}`,
        `❓ [UNCERTAIN] ${resolved.message}`,
        ...(resolved.guidance ? [`🎥 [GUIDANCE] ${resolved.guidance}`] : []),
      ]);
      speakText('Not enough visual evidence. Reposition the camera and verify again.');
    } else {
      // ERROR — hold position and surface the problem. This includes the
      // persist_failed error swapped in above when saving progress failed.
      setVerificationLogs((prev) => [...prev, `⚠️ [ERROR] ${resolved.message}`]);
      speakText('Verification could not be completed. Please try again.');
    }
  };

  // 4. Live Verification Step Handler — captures ONE frame on demand and asks the
  //    backend whether the CURRENT step is complete. No streaming, no per-frame
  //    polling: one user action → one capture → one request → one verdict.
  const handleVerifyStep = async () => {
    if (riskLocked) {
      speakText('Please acknowledge safety precautions before verifying.');
      return;
    }
    if (isVerifying) return;

    // Capture exactly one frame from the live camera. If there is NO live frame
    // we must not fall back to the backend's no-image (simulated) path: stop
    // here, surface a hard "camera frame unavailable" error, and leave the step
    // unchanged and incomplete. The backend's no-image behavior is preserved
    // server-side for older callers, but this UI never reaches it.
    const frame = cameraRef.current?.captureFrame() ?? null;
    if (!canVerifyWithFrame(frame)) {
      setVerificationLogs((prev) => [
        ...prev,
        `🚫 [VISION] No live camera frame for Step ${currentStepIdx}. Verification aborted — camera frame unavailable.`,
      ]);
      await applyVerification(errorView('camera_unavailable'));
      return;
    }

    setIsVerifying(true);
    setVerificationLogs((prev) => [
      ...prev,
      `🔍 [VISION] Captured live frame for Step ${currentStepIdx}. Sending to verifier...`,
    ]);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

    let view: VerificationView;
    try {
      const res = await fetch(`${API_BASE}/api/ai/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authToken ? `Bearer ${authToken}` : '',
        },
        body: JSON.stringify({
          scenarioId,
          stepIndex: currentStepIdx,
          frameImage: frame,
        }),
        signal: controller.signal,
      });

      if (res.ok) {
        const data = await res.json();
        view = interpretVerification(data);
      } else if (res.status === 400) {
        view = errorView('invalid_image');
      } else if (res.status === 404) {
        view = errorView('not_found');
      } else {
        // 5xx, auth, or anything else unexpected: hold position and report it.
        view = errorView('unavailable', `HTTP ${res.status}`);
      }
    } catch (err) {
      // Aborted timeout or a genuine network failure. Never fabricate success.
      const detail =
        err instanceof DOMException && err.name === 'AbortError' ? 'timed out' : undefined;
      view = errorView('network', detail);
    } finally {
      clearTimeout(timeout);
      setIsVerifying(false);
    }

    await applyVerification(view);
  };

  // Persist step progress on the Express server. Returns true only when the
  // server acknowledged the write (res.ok); false on any HTTP error or network
  // failure, so callers can react to a failed save instead of assuming success.
  const updateServerRepairStep = async (stepIdx: number, completed: boolean): Promise<boolean> => {
    try {
      const res = await fetch(`${API_BASE}/api/repairs/${repairId}/step`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          stepIndex: stepIdx,
          isCompleted: completed,
        }),
      });
      return res.ok;
    } catch (e) {
      console.error('Failed to sync step completion:', e);
      return false;
    }
  };

  // 5. Navigation controls
  const handleNextStep = () => {
    if (riskLocked) {
      speakText('Please acknowledge safety warnings before advancing.');
      return;
    }

    // The BACKEND is the single source of truth for progression. nextTransition
    // only ever tells us to finish, advance to a backend-supplied nextStep, or
    // hold. There is NO local "currentStepIdx + 1" guess — the frontend never
    // invents where the repair goes next.
    const transition = nextTransition(verification);

    if (transition.kind === 'finish') {
      setIsCompleted(true);
      setVerification(null);
      setDetectedComponents([]);
      setVerificationLogs((prev) => [
        ...prev,
        '🏆 [SYSTEM] All steps processed. Device repair checklist completed!',
      ]);
      speakText('Congratulations! Repair guide completed. Preparing final report.');
      return;
    }

    if (transition.kind === 'advance') {
      const next = verification?.nextStep;
      setCurrentStepIdx(transition.toIndex);
      setSafetyChecked(false);
      setVerification(null);
      setDetectedComponents([]);
      setVerificationLogs((prev) => [
        ...prev,
        next
          ? `📢 [COPILOT] Loaded Step ${next.index}: "${next.title}"`
          : `📢 [COPILOT] Loaded Step ${transition.toIndex}.`,
      ]);
      return;
    }

    // hold — the step is not verified, or the backend returned COMPLETED with no
    // next step. Do nothing to the repair position; tell the user why.
    setVerificationLogs((prev) => [...prev, `⛔ [BLOCKED] ${transition.reason}`]);
    speakText(transition.reason);
  };

  const handlePrevStep = () => {
    if (currentStepIdx > 1) {
      setCurrentStepIdx((prev) => prev - 1);
      setSafetyChecked(false);
      setIsCompleted(false);
      setVerification(null);
      setDetectedComponents([]);
      setVerificationLogs((prev) => [
        ...prev,
        `📢 [COPILOT] Returned to Step ${currentStepIdx - 1}: "${activeScenario.steps[currentStepIdx - 2].stepTitle}"`,
      ]);
    }
  };

  const handleManualComplete = () => {
    setCompletedSteps((prev) => ({ ...prev, [currentStepIdx]: true }));
    setVerificationLogs((prev) => [
      ...prev,
      `⚠️ [MANUAL] Step ${currentStepIdx} marked complete by user override.`,
    ]);
    speakText('Step override registered.');
    if (authToken && repairId) {
      updateServerRepairStep(currentStepIdx, true);
    }
  };

  // 6. Complete repair and export PDF Report
  const handleFinishAndReport = async () => {
    // Generate data representation
    const formattedSteps = activeScenario.steps.map((s) => ({
      stepTitle: s.stepTitle,
      safetyRisk: s.safetyRisk,
      isCompleted: !!completedSteps[s.stepIndex],
    }));

    const reportData = {
      reportId: `REP-${(diagnosticId || 'MOCK').substring(0, 8).toUpperCase()}`,
      date: new Date().toLocaleDateString(),
      deviceName: activeScenario.deviceName,
      deviceType: activeScenario.deviceType,
      confidenceScore: activeScenario.confidenceScore,
      difficultyScore: activeScenario.difficultyScore,
      estimatedCost: activeScenario.estimatedCost,
      successProbability: activeScenario.successProbability,
      components: activeScenario.components,
      steps: formattedSteps,
    };

    // Save report link on server if authenticated
    if (authToken && diagnosticId) {
      try {
        await fetch(`${API_BASE}/api/repairs/report`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            diagnosisId: diagnosticId,
            pdfUrl: 'local_print_window',
          }),
        });
      } catch (e) {
        console.error('Failed to save report metadata to database:', e);
      }
    }

    // Trigger printable report window
    downloadReport(reportData);

    setVerificationLogs((prev) => [...prev, `💾 [REPORT] Exported Diagnostic PDF Report. PDF window active.`]);
    speakText('PDF report generated.');
  };

  const handleScenarioChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value;
    // Picking from the guide selector is an EXPLICIT choice, so it jumps
    // straight into that repair (scenario-first), bypassing discovery.
    router.push(`/diagnose?scenario=${newId}`);
    startRepairForScenario(newId, authToken);
  };

  // Where the current diagnosis is allowed to go next. Computed once per render:
  // `repair` appears ONLY when the server confirmed a fault and published a
  // grounded procedure for it.
  const diagnosisHandoff = handoff(diagnosis);

  return (
    <div className="flex flex-col gap-6 md:gap-8 animate-in fade-in duration-200">
      {/* Title Header with Scenario Selector */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h1 className="font-outfit text-3xl md:text-4xl font-extrabold text-white flex items-center gap-3">
            <Wrench className="w-8 h-8 text-primary" />
            Live AI Assistant
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Webcam component recognition, AR bounding box guidance, and voice-assisted instructions.
          </p>
        </div>

        {/* Demo Path Selector Dropdown */}
        <div className="flex items-center gap-2.5 w-full md:w-auto">
          <label className="text-xs font-semibold text-gray-400 font-mono whitespace-nowrap uppercase">
            Active Guide:
          </label>
          <select
            value={scenarioId}
            onChange={handleScenarioChange}
            className="w-full md:w-64 px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 hover:border-primary/50 text-white text-sm outline-none transition-colors cursor-pointer"
          >
            {Object.keys(demoScenarios).map((scId) => (
              <option key={scId} value={scId} className="bg-[#0b0b0f] text-white">
                {demoScenarios[scId].deviceName} ({demoScenarios[scId].deviceType})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* DEVICE-IDENTIFICATION-FIRST discovery view. Rendered until a supported
          scenario is resolved from the camera (or one was supplied explicitly
          via ?scenario=). The repair UI below only mounts once phase==='repair'. */}
      {phase === 'discovery' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* LEFT: live camera to aim at the device being identified */}
          <div className="lg:col-span-7 flex flex-col gap-4">
            <CameraFeed
              ref={cameraRef}
              scenarioId={scenarioId}
              components={[]}
              activeComponentNames={[]}
              detectedComponents={detectedComponents}
            />

            {/* Discovery logs console — shares styling with the repair view */}
            <div className="glass-panel rounded-xl border border-white/5 overflow-hidden">
              <div className="px-4 py-2 border-b border-white/5 bg-white/5 flex items-center justify-between">
                <span className="text-[10px] text-gray-400 font-mono font-bold flex items-center gap-1">
                  <Terminal className="w-3.5 h-3.5 text-primary" /> DEVICE DISCOVERY LOGS
                </span>
                <span className="text-[9px] text-gray-500 font-mono">Single-frame scan</span>
              </div>
              <div className="p-4 bg-black/60 font-mono text-[11px] text-gray-300 h-36 overflow-y-auto flex flex-col gap-1 select-text scrollbar-thin scrollbar-thumb-white/10">
                {verificationLogs.length === 0 ? (
                  <div className="text-gray-600">Awaiting first scan…</div>
                ) : (
                  verificationLogs.map((log, index) => (
                    <div key={index} className="leading-relaxed whitespace-pre-wrap">{log}</div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* RIGHT: identify-device call to action + readout */}
          <div className="lg:col-span-5 flex flex-col gap-6">
            <div className="glass-panel rounded-2xl border border-white/10 overflow-hidden shadow-xl">
              <div className="p-4 border-b border-white/5 bg-white/5 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-primary" />
                <span className="text-xs font-bold text-gray-300 uppercase tracking-wider font-mono">
                  Step 1 — Identify Device
                </span>
              </div>

              <div className="p-6 flex flex-col gap-5">
                <p className="text-sm text-gray-400 leading-relaxed">
                  Point the camera at the device you want to repair, then scan. The AI identifies the
                  device and its visible components, and we match it to a supported repair procedure
                  before any steps begin.
                </p>

                <button
                  onClick={runDeviceDiscovery}
                  disabled={isDiscovering}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold text-black bg-primary hover:bg-primary/95 disabled:opacity-40 transition-all cursor-pointer shadow-lg shadow-primary/10"
                >
                  {isDiscovering ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" /> Identifying device…
                    </>
                  ) : (
                    <>
                      <Cpu className="w-4 h-4" /> Scan &amp; Identify Device
                    </>
                  )}
                </button>

                {/* What the vision layer identified in the last scan */}
                {discoveredDevice && (
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 flex flex-col gap-3">
                    <div className="flex items-center gap-2 text-xs font-bold text-primary">
                      <Sparkles className="w-4 h-4" /> Device Identified
                    </div>
                    <div className="grid grid-cols-2 gap-3 font-mono text-[11px]">
                      <div className="flex flex-col">
                        <span className="text-gray-500 uppercase tracking-wider">Device</span>
                        <span className="text-white font-semibold mt-0.5">{discoveredDevice.name}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-gray-500 uppercase tracking-wider">Type</span>
                        <span className="text-white font-semibold mt-0.5">{discoveredDevice.type ?? '—'}</span>
                      </div>
                      {discoveredDevice.confidencePercent != null && (
                        <div className="flex flex-col">
                          <span className="text-gray-500 uppercase tracking-wider">Confidence</span>
                          <span className="text-primary font-bold mt-0.5">{discoveredDevice.confidencePercent}%</span>
                        </div>
                      )}
                      <div className="flex flex-col">
                        <span className="text-gray-500 uppercase tracking-wider">Components</span>
                        <span className="text-white font-semibold mt-0.5">{detectedComponents.length} detected</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* No supported match, no device, or scan error */}
                {discoveryNotice && (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-gray-300 leading-relaxed">{discoveryNotice}</p>
                  </div>
                )}
              </div>
            </div>

            {/* SYMPTOM-DRIVEN ENTRY. The alternative to picking a procedure: say
                what is wrong and let the copilot work out the cause. Works for
                devices that have no repair guide — diagnosis is generic, while
                step-by-step repair stays gated behind a grounded procedure. */}
            <div className="glass-panel rounded-2xl border border-white/10 overflow-hidden shadow-xl">
              <div className="p-4 border-b border-white/5 bg-white/5 flex items-center gap-2">
                <Stethoscope className="w-4 h-4 text-primary" />
                <span className="text-xs font-bold text-gray-300 uppercase tracking-wider font-mono">
                  Or — Diagnose a Problem
                </span>
              </div>

              <div className="p-6 flex flex-col gap-4">
                <label
                  htmlFor="symptom"
                  className="text-sm font-semibold text-gray-200 leading-relaxed"
                >
                  What problem are you experiencing?
                </label>
                <textarea
                  id="symptom"
                  value={symptomText}
                  onChange={(e) => setSymptomText(e.target.value)}
                  rows={3}
                  maxLength={600}
                  placeholder="e.g. My laptop turns on but the screen stays black."
                  className="w-full rounded-xl bg-black/40 border border-white/10 focus:border-primary/50 focus:outline-none p-3 text-sm text-gray-200 placeholder:text-gray-600 resize-none"
                />
                <p className="text-[11px] text-gray-500 leading-relaxed">
                  I&apos;ll look at the device through the camera, work out the likely causes, and ask
                  you to run the safest check first. I only start a guided repair if a verified
                  procedure exists for your device.
                </p>

                <button
                  onClick={runDiagnosis}
                  disabled={isDiagnosing || symptomText.trim().length === 0}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold text-black bg-primary hover:bg-primary/95 disabled:opacity-40 transition-all cursor-pointer shadow-lg shadow-primary/10"
                >
                  {isDiagnosing ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" /> Diagnosing…
                    </>
                  ) : (
                    <>
                      <Stethoscope className="w-4 h-4" /> Diagnose the Problem
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DIAGNOSTIC COPILOT view. The camera preview stays live on the left; the
          right column is the copilot's reasoning, rendered verbatim from the
          server: what I see / what I think / what I need you to do / why. */}
      {phase === 'diagnostic' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* LEFT: live camera (preview only — frames are sent on demand) */}
          <div className="lg:col-span-7 flex flex-col gap-4">
            <CameraFeed
              ref={cameraRef}
              scenarioId={scenarioId}
              components={[]}
              activeComponentNames={[]}
              detectedComponents={detectedComponents}
            />

            <div className="glass-panel rounded-xl border border-white/5 overflow-hidden">
              <div className="px-4 py-2 border-b border-white/5 bg-white/5 flex items-center justify-between">
                <span className="text-[10px] text-gray-400 font-mono font-bold flex items-center gap-1">
                  <Terminal className="w-3.5 h-3.5 text-primary" /> DIAGNOSTIC REASONING LOGS
                </span>
                <span className="text-[9px] text-gray-500 font-mono">Event-driven inference</span>
              </div>
              <div className="p-4 bg-black/60 font-mono text-[11px] text-gray-300 h-36 overflow-y-auto flex flex-col gap-1 select-text scrollbar-thin scrollbar-thumb-white/10">
                {verificationLogs.length === 0 ? (
                  <div className="text-gray-600">Awaiting diagnosis…</div>
                ) : (
                  verificationLogs.map((log, index) => (
                    <div key={index} className="leading-relaxed whitespace-pre-wrap">{log}</div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* RIGHT: the copilot panel */}
          <div className="lg:col-span-5 flex flex-col gap-6">
            <div className="glass-panel rounded-2xl border border-white/10 overflow-hidden shadow-xl">
              <div className="p-4 border-b border-white/5 bg-white/5 flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-gray-300 uppercase tracking-wider font-mono flex items-center gap-2">
                  <Stethoscope className="w-4 h-4 text-primary" /> Diagnostic Copilot
                </span>
                <button
                  onClick={resetDiagnosis}
                  disabled={isDiagnosing}
                  className="text-[10px] font-mono text-gray-400 hover:text-white disabled:opacity-40 flex items-center gap-1 cursor-pointer"
                >
                  <ArrowLeft className="w-3 h-3" /> START OVER
                </button>
              </div>

              {isDiagnosing && !diagnosis && (
                <div className="p-6 flex items-center gap-3 text-sm text-gray-400">
                  <RefreshCw className="w-4 h-4 animate-spin text-primary" />
                  Looking at the device and working out the likely causes…
                </div>
              )}

              {diagnosis && (
                <div className="p-6 flex flex-col gap-5">
                  {/* Headline */}
                  <div
                    className={`rounded-xl border p-4 ${
                      diagnosis.status === 'ERROR' || diagnosis.status === 'UNSAFE_TO_GUIDE'
                        ? 'border-amber-500/30 bg-amber-500/5'
                        : diagnosis.confirmed
                          ? 'border-primary/30 bg-primary/5'
                          : 'border-white/10 bg-white/5'
                    }`}
                  >
                    <p className="text-sm text-gray-200 leading-relaxed">{diagnosis.message}</p>
                    {diagnosis.deviceLabel && (
                      <p className="text-[11px] font-mono text-gray-500 mt-2">
                        DEVICE: <span className="text-gray-300">{diagnosis.deviceLabel}</span>
                      </p>
                    )}
                  </div>

                  {/* 1. WHAT I SEE */}
                  {diagnosis.see.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <span className="text-[10px] font-mono font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                        <Eye className="w-3.5 h-3.5 text-primary" /> What I see
                      </span>
                      <ul className="flex flex-col gap-1.5">
                        {diagnosis.see.map((line, i) => (
                          <li key={i} className="text-xs text-gray-300 leading-relaxed flex gap-2">
                            <span className="text-primary/60 shrink-0">•</span>
                            <span>{line}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* 2. WHAT I THINK */}
                  {diagnosis.think.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <span className="text-[10px] font-mono font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                        <Brain className="w-3.5 h-3.5 text-primary" /> What I think
                      </span>
                      <div className="flex flex-col gap-2">
                        {diagnosis.think.map((h) => (
                          <div key={h.code} className="flex flex-col gap-1">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-xs text-gray-200 font-semibold">{h.label}</span>
                              <span className="text-[11px] font-mono text-primary font-bold shrink-0">
                                {h.confidencePercent}%
                              </span>
                            </div>
                            <div className="h-1 w-full rounded-full bg-white/5 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-primary/70"
                                style={{ width: `${h.confidencePercent}%` }}
                              />
                            </div>
                            {h.rationale && (
                              <p className="text-[11px] text-gray-500 leading-relaxed">{h.rationale}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 3. WHAT I NEED YOU TO DO */}
                  {diagnosis.action && (
                    <div className="flex flex-col gap-2.5 rounded-xl border border-primary/20 bg-primary/5 p-4">
                      <span className="text-[10px] font-mono font-bold text-primary uppercase tracking-wider flex items-center gap-1.5">
                        <Wrench className="w-3.5 h-3.5" /> What I need you to do
                      </span>
                      <p className="text-sm font-semibold text-white leading-snug">
                        {diagnosis.action.title}
                      </p>
                      {diagnosis.action.instruction && (
                        <p className="text-xs text-gray-300 leading-relaxed">
                          {diagnosis.action.instruction}
                        </p>
                      )}
                      <div className="flex items-center gap-3 text-[10px] font-mono text-gray-500">
                        <span
                          className={
                            diagnosis.action.riskLevel === 'safe'
                              ? 'text-emerald-400'
                              : diagnosis.action.riskLevel === 'medium'
                                ? 'text-amber-400'
                                : 'text-red-400'
                          }
                        >
                          RISK: {diagnosis.action.riskLevel.toUpperCase()}
                        </span>
                        <span>
                          OBSERVE: {diagnosis.action.observe === 'camera' ? 'CAMERA' : 'YOU REPORT'}
                        </span>
                      </div>

                      {diagnosis.action.answerable && (
                        <>
                          {diagnosis.action.question && (
                            <p className="text-xs font-semibold text-gray-200 leading-relaxed mt-1">
                              {diagnosis.action.question}
                            </p>
                          )}
                          <div className="grid grid-cols-3 gap-2 mt-1">
                            <button
                              onClick={() => answerDiagnosticCheck('yes')}
                              disabled={isDiagnosing}
                              className="flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-lg text-xs font-bold text-black bg-primary hover:bg-primary/95 disabled:opacity-40 transition-all cursor-pointer"
                            >
                              <ThumbsUp className="w-3.5 h-3.5" /> Yes
                            </button>
                            <button
                              onClick={() => answerDiagnosticCheck('no')}
                              disabled={isDiagnosing}
                              className="flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-lg text-xs font-bold text-gray-200 bg-white/10 hover:bg-white/15 disabled:opacity-40 transition-all cursor-pointer"
                            >
                              <ThumbsDown className="w-3.5 h-3.5" /> No
                            </button>
                            <button
                              onClick={() => answerDiagnosticCheck('unclear')}
                              disabled={isDiagnosing}
                              className="flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-lg text-xs font-bold text-gray-300 bg-white/5 hover:bg-white/10 disabled:opacity-40 transition-all cursor-pointer"
                            >
                              <HelpCircle className="w-3.5 h-3.5" /> Not sure
                            </button>
                          </div>
                        </>
                      )}

                      {/* Non-answerable actions: re-scan or add detail, then retry. */}
                      {!diagnosis.action.answerable && (
                        <button
                          onClick={runDiagnosis}
                          disabled={isDiagnosing}
                          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold text-black bg-primary hover:bg-primary/95 disabled:opacity-40 transition-all cursor-pointer mt-1"
                        >
                          {isDiagnosing ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Working…
                            </>
                          ) : (
                            <>
                              <RefreshCw className="w-3.5 h-3.5" /> Scan again
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  )}

                  {/* 4. WHY */}
                  {diagnosis.why && (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[10px] font-mono font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                        <HelpCircle className="w-3.5 h-3.5 text-primary" /> Why
                      </span>
                      <p className="text-xs text-gray-400 leading-relaxed">{diagnosis.why}</p>
                    </div>
                  )}

                  {/* Advice — generic and non-procedural, safe for any device. */}
                  {diagnosis.advice.length > 0 && (
                    <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/5 p-4">
                      <span className="text-[10px] font-mono font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-primary" /> Recommendation
                      </span>
                      <ul className="flex flex-col gap-1.5">
                        {diagnosis.advice.map((line, i) => (
                          <li key={i} className="text-xs text-gray-300 leading-relaxed flex gap-2">
                            <span className="text-primary/60 shrink-0">•</span>
                            <span>{line}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* HAND-OFF. Only rendered when the server confirmed a fault AND
                      published a grounded procedure. Starts the EXISTING repair
                      flow with its existing camera step verification. */}
                  {diagnosisHandoff.kind === 'repair' && (
                    <button
                      onClick={startGroundedRepair}
                      disabled={isDiagnosing}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold text-black bg-primary hover:bg-primary/95 disabled:opacity-40 transition-all cursor-pointer shadow-lg shadow-primary/10"
                    >
                      <Wrench className="w-4 h-4" /> Start the Guided Repair
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  )}

                  {/* No grounded procedure: say so plainly instead of improvising
                      physical steps for a device we have not verified. */}
                  {diagnosisHandoff.kind === 'advice' && (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-2.5">
                      <Ban className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <p className="text-xs text-gray-300 leading-relaxed">
                        {diagnosisHandoff.reason}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Grid: Left HUD & Camera, Right steps panel, Rightmost chat sidebar */}
      {phase === 'repair' && (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

        {/* LEFT COLUMN: Camera & HUD (Col span 7) */}
        <div className="lg:col-span-7 flex flex-col gap-4">
          <CameraFeed
            ref={cameraRef}
            scenarioId={scenarioId}
            components={activeScenario.components}
            activeComponentNames={activeComponentNames}
            detectedComponents={detectedComponents}
          />

          {/* Machine Vision Status Panel */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="glass-panel p-3 border border-white/5 rounded-xl flex flex-col justify-between">
              <span className="text-[10px] text-gray-500 font-mono font-bold uppercase tracking-wider">Device Match</span>
              <span className="text-sm font-semibold text-white truncate mt-1">{activeScenario.deviceName}</span>
            </div>
            
            <div className="glass-panel p-3 border border-white/5 rounded-xl flex flex-col justify-between">
              <span className="text-[10px] text-gray-500 font-mono font-bold uppercase tracking-wider">Components Match</span>
              <span className="text-sm font-semibold text-white mt-1">{activeScenario.components.length} detected</span>
            </div>

            <div className="glass-panel p-3 border border-white/5 rounded-xl flex flex-col justify-between">
              <span className="text-[10px] text-gray-500 font-mono font-bold uppercase tracking-wider">AI Confidence</span>
              <span className="text-sm font-bold text-primary flex items-center gap-1 mt-1 font-mono">
                <Activity className="w-3.5 h-3.5 text-primary animate-pulse" />
                {aiConfidence}%
              </span>
            </div>

            <div className="glass-panel p-3 border border-white/5 rounded-xl flex flex-col justify-between bg-primary/5 border-primary/10">
              <span className="text-[10px] text-primary font-mono font-bold uppercase tracking-wider">Success Probability</span>
              <span className="text-sm font-extrabold text-white mt-1 font-mono">{activeScenario.successProbability}%</span>
            </div>
          </div>

          {/* Interactive Vision AI Output Logs Console */}
          <div className="glass-panel rounded-xl border border-white/5 overflow-hidden">
            <div className="px-4 py-2 border-b border-white/5 bg-white/5 flex items-center justify-between">
              <span className="text-[10px] text-gray-400 font-mono font-bold flex items-center gap-1">
                <Terminal className="w-3.5 h-3.5 text-primary" /> VISION COGNITIVE ENGINE LOGS
              </span>
              <span className="text-[9px] text-gray-500 font-mono">Real-time telemetry</span>
            </div>
            <div className="p-4 bg-black/60 font-mono text-[11px] text-gray-300 h-36 overflow-y-auto flex flex-col gap-1 select-text scrollbar-thin scrollbar-thumb-white/10">
              {verificationLogs.map((log, index) => (
                <div key={index} className="leading-relaxed whitespace-pre-wrap">{log}</div>
              ))}
            </div>
          </div>
        </div>

        {/* MIDDLE COLUMN: Guided Steps & Safety Warning (Col span 5) */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          
          {/* Voice Assistant Floating Control Panel */}
          <div className="glass-panel rounded-xl p-4 border border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-primary" />
              <div className="flex flex-col">
                <span className="text-xs font-bold text-white font-outfit">Hands-Free Copilot</span>
                <span className="text-[9px] text-gray-400">Controls Web Speech settings</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Speak instruction trigger toggle */}
              <button
                onClick={toggleVoice}
                className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-all cursor-pointer ${
                  isVoiceActive 
                    ? 'bg-primary/20 text-primary border-primary/40' 
                    : 'bg-white/5 text-gray-400 border-white/10 hover:text-white'
                }`}
                title={isVoiceActive ? 'Mute Voice synthesis' : 'Unmute Voice synthesis'}
              >
                {isVoiceActive ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </button>

              {/* Speech Recognition trigger toggle */}
              <button
                onClick={toggleMic}
                className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-all cursor-pointer ${
                  isMicActive 
                    ? 'bg-red-500/20 text-red-400 border-red-500/40 animate-pulse' 
                    : 'bg-white/5 text-gray-400 border-white/10 hover:text-white'
                }`}
                title={isMicActive ? 'Turn off Voice Commands' : 'Turn on Voice Commands'}
              >
                {isMicActive ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Current Step panel */}
          {!isCompleted ? (
            <div className="glass-panel rounded-2xl border border-white/10 overflow-hidden shadow-xl relative">
              
              {/* Header */}
              <div className="p-4 border-b border-white/5 bg-white/5 flex items-center justify-between">
                <span className="text-xs font-bold text-gray-400 uppercase tracking-wider font-mono">
                  Instruction Checklist
                </span>
                <span className="px-2 py-0.5 rounded bg-white/5 text-[10px] text-gray-400 font-mono font-bold">
                  Step {currentStepIdx} of {activeScenario.steps.length}
                </span>
              </div>

              {/* Step Detail */}
              <div className="p-6 flex flex-col gap-6">
                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary/20 to-accent/20 border border-primary/30 flex items-center justify-center font-bold text-white text-lg font-outfit shrink-0">
                    {currentStepIdx}
                  </div>
                  <div className="flex flex-col gap-2">
                    <h3 className="font-outfit text-lg font-extrabold text-white leading-snug">
                      {activeStep?.stepTitle}
                    </h3>
                    <p className="text-xs text-gray-400 font-mono">
                      Target element: <span className="text-primary font-bold">{activeComponentNames.join(' & ') || 'Structure Grid'}</span>
                    </p>
                  </div>
                </div>

                {/* Safety Mode warning box if applicable */}
                {(isHighRisk || isMediumRisk) && (
                  <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/5 flex flex-col gap-3">
                    <div className="flex items-center gap-2 text-xs font-bold text-red-400">
                      <AlertTriangle className="w-4 h-4" />
                      <span>{isHighRisk ? 'HIGH RISK STEP WARNING' : 'MEDIUM RISK STEP WARNING'}</span>
                    </div>
                    <p className="text-xs text-gray-300 leading-relaxed font-sans">
                      {activeStep.warningText}
                    </p>
                    <label className="flex items-start gap-2.5 mt-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={safetyChecked}
                        onChange={(e) => setSafetyChecked(e.target.checked)}
                        className="mt-0.5 rounded border-red-500/30 text-red-500 focus:ring-red-500/30 bg-black/40 outline-none w-4 h-4 cursor-pointer"
                      />
                      <span className="text-[11px] text-gray-400 font-medium leading-tight hover:text-white">
                        I confirm that the power supply is disconnected and safety measures are locked in.
                      </span>
                    </label>
                  </div>
                )}

                {/* Live verification result — the backend is the source of truth.
                    Rendered only after a verify attempt; never advances on its own. */}
                {verification && (
                  <div
                    className={`rounded-xl border p-4 flex flex-col gap-3 ${
                      verification.status === 'COMPLETED'
                        ? 'border-primary/30 bg-primary/5'
                        : verification.status === 'NOT_COMPLETED'
                        ? 'border-amber-500/30 bg-amber-500/5'
                        : verification.status === 'UNCERTAIN'
                        ? 'border-yellow-500/30 bg-yellow-500/5'
                        : 'border-red-500/30 bg-red-500/5'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-bold font-mono uppercase tracking-wider">
                        {verification.status === 'COMPLETED' ? (
                          <span className="flex items-center gap-1.5 text-primary">
                            <CheckCircle2 className="w-4 h-4" /> Verified
                          </span>
                        ) : verification.status === 'NOT_COMPLETED' ? (
                          <span className="flex items-center gap-1.5 text-amber-400">
                            <AlertTriangle className="w-4 h-4" /> Not Complete
                          </span>
                        ) : verification.status === 'UNCERTAIN' ? (
                          <span className="flex items-center gap-1.5 text-yellow-400">
                            <HelpCircle className="w-4 h-4" /> Uncertain
                          </span>
                        ) : (
                          <span className="flex items-center gap-1.5 text-red-400">
                            <AlertTriangle className="w-4 h-4" /> Error
                          </span>
                        )}
                      </div>
                      {verification.confidencePercent != null && (
                        <span className="text-[10px] font-mono font-bold text-gray-300">
                          Confidence: {verification.confidencePercent}%
                        </span>
                      )}
                    </div>

                    <p className="text-xs text-gray-300 leading-relaxed">{verification.message}</p>

                    {/* Camera guidance for uncertain / error states */}
                    {verification.guidance && (
                      <p className="text-[11px] text-yellow-300/90 leading-relaxed flex items-start gap-1.5">
                        <span>🎥</span>
                        <span>{verification.guidance}</span>
                      </p>
                    )}

                    {/* Backend-authored next step (shown only on COMPLETED) */}
                    {verification.status === 'COMPLETED' && verification.nextStep && (
                      <div className="rounded-lg border border-white/10 bg-black/30 p-3 flex flex-col gap-1">
                        <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-primary">
                          Next Step (Step {verification.nextStep.index})
                        </span>
                        <span className="text-xs font-bold text-white">{verification.nextStep.title}</span>
                        {verification.nextStep.instruction && (
                          <span className="text-[11px] text-gray-400 leading-relaxed">
                            {verification.nextStep.instruction}
                          </span>
                        )}
                        <span className="text-[10px] text-gray-500 mt-1">Press “Next” to continue.</span>
                      </div>
                    )}

                    {verification.status === 'COMPLETED' && verification.repairComplete && (
                      <div className="text-[11px] font-bold text-primary flex items-center gap-1.5">
                        <Award className="w-3.5 h-3.5" /> Final step verified — press “Next” to finish.
                      </div>
                    )}

                    {/* What the AI actually observed in the frame */}
                    {verification.observations.length > 0 && (
                      <div className="flex flex-col gap-1">
                        <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-gray-500">
                          What the AI saw
                        </span>
                        <ul className="list-disc list-inside text-[11px] text-gray-400 leading-relaxed">
                          {verification.observations.map((obs, i) => (
                            <li key={i}>{obs}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Weak-evidence reasons for non-completed verdicts */}
                    {verification.status !== 'COMPLETED' && verification.warnings.length > 0 && (
                      <div className="flex flex-col gap-1">
                        <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-gray-500">
                          Notes
                        </span>
                        <ul className="list-disc list-inside text-[11px] text-gray-500 leading-relaxed">
                          {verification.warnings.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {/* Step controls */}
                <div className="flex flex-col sm:flex-row gap-3 mt-4 border-t border-white/5 pt-6">
                  {/* Left verify actions */}
                  <div className="flex gap-2 flex-1">
                    <button
                      onClick={handleVerifyStep}
                      disabled={isVerifying || riskLocked}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold text-black bg-primary hover:bg-primary/95 disabled:opacity-40 transition-all cursor-pointer shadow-lg shadow-primary/10"
                    >
                      {isVerifying ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          Verifying...
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Verify Step
                        </>
                      )}
                    </button>

                    {/* Manual override: bypasses visual verification. Hidden by
                        default; only rendered when NEXT_PUBLIC_ENABLE_REPAIR_OVERRIDE
                        === 'true'. The real demo relies on AI verification. */}
                    {REPAIR_OVERRIDE_ENABLED && (
                      <button
                        onClick={handleManualComplete}
                        disabled={isVerifying || riskLocked}
                        className="px-3 py-2.5 rounded-xl text-xs font-semibold text-white bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 transition-all cursor-pointer"
                        title="Skip verification and mark completed"
                      >
                        Override
                      </button>
                    )}
                  </div>

                  {/* Navigation steps */}
                  <div className="flex gap-2">
                    <button
                      onClick={handlePrevStep}
                      disabled={currentStepIdx === 1}
                      className="w-10 h-10 rounded-xl border border-white/10 bg-white/5 text-gray-400 hover:text-white disabled:opacity-40 hover:bg-white/10 flex items-center justify-center cursor-pointer transition-colors"
                      title="Previous Step"
                    >
                      <ArrowLeft className="w-4 h-4" />
                    </button>

                    <button
                      onClick={handleNextStep}
                      disabled={riskLocked || !completedSteps[currentStepIdx]}
                      className="px-4 py-2.5 rounded-xl text-xs font-semibold text-white bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                      title="Next Step"
                    >
                      Next <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Repair completion screen */
            <div className="glass-panel rounded-2xl p-8 border border-primary/20 bg-primary/5 text-center flex flex-col items-center gap-6 shadow-2xl animate-in zoom-in-95 duration-200">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/20">
                <Award className="w-8 h-8 text-black" />
              </div>

              <div>
                <h3 className="font-outfit text-2xl font-extrabold text-white">Repair Checklist Completed</h3>
                <p className="text-sm text-gray-400 mt-2 max-w-sm mx-auto leading-relaxed">
                  All steps for the {activeScenario.deviceName} have been executed. Vision AI reports 100% completion metrics.
                </p>
              </div>

              <div className="w-full border-t border-white/10 pt-6 flex flex-col gap-3">
                <button
                  onClick={handleFinishAndReport}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold text-black bg-primary hover:bg-primary/95 transition-all cursor-pointer shadow-lg shadow-primary/20"
                >
                  <FileText className="w-5 h-5" /> Generate & Save Report
                </button>
                
                <button
                  onClick={() => router.push('/dashboard')}
                  className="w-full px-6 py-3 rounded-xl font-semibold text-white bg-white/5 border border-white/10 hover:bg-white/10 cursor-pointer"
                >
                  Go to Dashboard
                </button>
              </div>
            </div>
          )}

          {/* Quick Scenario Info summary */}
          <div className="glass-panel rounded-xl p-4 border border-white/5 flex flex-col gap-2">
            <span className="text-[10px] text-gray-500 font-mono font-bold uppercase tracking-wider">Repair Profile Details</span>
            <div className="grid grid-cols-3 gap-2 mt-1 font-mono text-[10px] text-gray-400">
              <div>Diff: <span className="text-white font-bold">{activeScenario.difficultyScore}/100</span></div>
              <div>Est. Cost: <span className="text-white font-bold">${activeScenario.estimatedCost}</span></div>
              <div>Type: <span className="text-white font-bold">{activeScenario.deviceType}</span></div>
            </div>
          </div>
        </div>
      </div>
      )}

      {/* Persistent Floating Chat Drawer on bottom/side (Expandable or layout inline) */}
      <div className="mt-8">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3 px-1">
          Side Channel Copilot Chat
        </h3>
        <div className="h-96">
          <Chatbot scenarioId={scenarioId} />
        </div>
      </div>
    </div>
  );
}

export default function DiagnosePage() {
  return (
    <Suspense fallback={
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3 text-center">
        <Cpu className="w-10 h-10 text-primary animate-spin" />
        <div className="text-sm text-gray-400 font-mono">LOADING COGNITIVE SCANNER...</div>
      </div>
    }>
      <DiagnoseContent />
    </Suspense>
  );
}
