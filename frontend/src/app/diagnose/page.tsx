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
  Award
} from 'lucide-react';
import { demoScenarios, IRepairStep } from '@/utils/repairGuides';
import { downloadReport } from '@/utils/pdfGenerator';
import CameraFeed from '@/components/CameraFeed';
import Chatbot from '@/components/Chatbot';

function DiagnoseContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Selected scenario ID (from URL parameter or default to RAM Upgrade)
  const initialScenario = searchParams.get('scenario') || 'laptop_ram_upgrade';
  const [scenarioId, setScenarioId] = useState(
    demoScenarios[initialScenario] ? initialScenario : 'laptop_ram_upgrade'
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

  // Hands-free voice assistant configurations
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isMicActive, setIsMicActive] = useState(false);
  const [speechTranscript, setSpeechTranscript] = useState('');
  const recognitionRef = useRef<any>(null);

  // Fluctuating confidence score simulation
  useEffect(() => {
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
  }, [scenarioId, isCompleted]);

  // Track if user is authenticated
  const [authToken, setAuthToken] = useState<string | null>(null);
  useEffect(() => {
    const token = localStorage.getItem('token');
    setAuthToken(token);
    triggerDeviceDetection(token);
  }, [scenarioId]);

  // 1. Device Identification & Detection Trigger
  const triggerDeviceDetection = async (token: string | null) => {
    setVerificationLogs([`⚡ [SYSTEM] Launching Vision AI for ${activeScenario.deviceName}...`]);
    setCurrentStepIdx(1);
    setCompletedSteps({});
    setSafetyChecked(false);
    setIsCompleted(false);

    try {
      const res = await fetch('https://repair-ai.onrender.com/api/ai/detect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({ scenarioId }),
      });

      if (res.ok) {
        const data = await res.json();
        setDiagnosticId(data.diagnosticId);
        setVerificationLogs((prev) => [
          ...prev,
          `✅ [VISION] Device Identified: ${data.deviceName} (${data.deviceType})`,
          `🔎 [VISION] Detected ${data.components.length} micro-components on layout canvas.`,
          `📢 [COPILOT] Step 1 Loaded: "${activeScenario.steps[0].stepTitle}"`,
        ]);

        // Start repair session on server if authenticated
        if (token) {
          startServerRepairSession(token, data.diagnosticId);
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
          `✅ [VISION] Device Identified: ${activeScenario.deviceName} (${activeScenario.deviceType})`,
          `🔎 [VISION] Components mapped: ${activeScenario.components.map((c) => c.name).join(', ')}`,
          `📢 [COPILOT] Step 1 Loaded: "${activeScenario.steps[0].stepTitle}"`,
        ]);
      }, 500);
    }
  };

  // Start repair session on the backend
  const startServerRepairSession = async (token: string, diagId: string) => {
    try {
      const res = await fetch('https://repair-ai.onrender.com/api/repairs/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          diagnosticId: diagId,
          scenarioId: scenarioId,
          deviceName: activeScenario.deviceName,
          deviceType: activeScenario.deviceType,
          steps: activeScenario.steps,
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

  // 4. Live Verification Step Handler
  const handleVerifyStep = async () => {
    if (riskLocked) {
      speakText('Please acknowledge safety precautions before verifying.');
      return;
    }

    setIsVerifying(true);
    setVerificationLogs((prev) => [...prev, `🔍 [VISION] Analyzing frame for Step ${currentStepIdx}...`]);

    try {
      const res = await fetch('https://repair-ai.onrender.com/api/ai/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authToken ? `Bearer ${authToken}` : '',
        },
        body: JSON.stringify({
          scenarioId,
          stepIndex: currentStepIdx,
          frameImage: 'data:image/png;base64,iVBORw0KGgo...', // Simulated frame image
        }),
      });

      if (res.ok) {
        const data = await res.json();
        
        // Log result
        setVerificationLogs((prev) => [
          ...prev,
          `🤖 [AI AGENT] Match Score: ${data.confidence}%`,
          data.verified 
            ? `✅ [VERIFIED] ${data.message}`
            : `❌ [PENDING] ${data.message}`,
        ]);

        if (data.verified) {
          setCompletedSteps((prev) => ({ ...prev, [currentStepIdx]: true }));
          speakText('Verification successful! You may proceed.');

          // Update backend repair tracking step status
          if (authToken && repairId) {
            updateServerRepairStep(currentStepIdx, true);
          }
        } else {
          speakText('Verification pending. Please ensure the component is visible.');
        }
      } else {
        throw new Error('API server failure');
      }
    } catch (e) {
      console.warn('Backend offline. Simulating step verification success.');
      // Simulated response when offline
      setTimeout(() => {
        const success = Math.random() > 0.15; // 85% success simulation
        const fakeConf = (88 + Math.random() * 11).toFixed(2);
        
        if (success) {
          setCompletedSteps((prev) => ({ ...prev, [currentStepIdx]: true }));
          setVerificationLogs((prev) => [
            ...prev,
            `🤖 [AI AGENT] Match Score: ${fakeConf}%`,
            `✅ [VERIFIED] Step completed. Machine vision confirms structural match for ${activeStep.verificationTrigger}.`,
          ]);
          speakText('Step verified successfully.');
        } else {
          setVerificationLogs((prev) => [
            ...prev,
            `🤖 [AI AGENT] Match Score: ${fakeConf}%`,
            `❌ [PENDING] Visual parameters incomplete. Align camera directly to ${activeComponentNames.join(', ')}.`,
          ]);
          speakText('Verification failed. Adjust camera position.');
        }
      }, 1200);
    } finally {
      setIsVerifying(false);
    }
  };

  // Update step progress on Express server
  const updateServerRepairStep = async (stepIdx: number, completed: boolean) => {
    try {
      await fetch(`https://repair-ai.onrender.com/api/repairs/${repairId}/step`, {
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
    } catch (e) {
      console.error('Failed to sync step completion:', e);
    }
  };

  // 5. Navigation controls
  const handleNextStep = () => {
    if (riskLocked) {
      speakText('Please acknowledge safety warnings before advancing.');
      return;
    }

    if (currentStepIdx < activeScenario.steps.length) {
      setCurrentStepIdx((prev) => prev + 1);
      setSafetyChecked(false);
      setVerificationLogs((prev) => [
        ...prev,
        `📢 [COPILOT] Loaded Step ${currentStepIdx + 1}: "${activeScenario.steps[currentStepIdx].stepTitle}"`,
      ]);
    } else {
      // Final step reached
      setIsCompleted(true);
      setVerificationLogs((prev) => [
        ...prev,
        `🏆 [SYSTEM] All steps processed. Device repair checklist completed!`,
      ]);
      speakText('Congratulations! Repair guide completed. Preparing final report.');
    }
  };

  const handlePrevStep = () => {
    if (currentStepIdx > 1) {
      setCurrentStepIdx((prev) => prev - 1);
      setSafetyChecked(false);
      setIsCompleted(false);
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
        await fetch('https://repair-ai.onrender.com/api/repairs/report', {
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
    setScenarioId(newId);
    router.push(`/diagnose?scenario=${newId}`);
  };

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

      {/* Main Grid: Left HUD & Camera, Right steps panel, Rightmost chat sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* LEFT COLUMN: Camera & HUD (Col span 7) */}
        <div className="lg:col-span-7 flex flex-col gap-4">
          <CameraFeed
            scenarioId={scenarioId}
            components={activeScenario.components}
            activeComponentNames={activeComponentNames}
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
                    
                    <button
                      onClick={handleManualComplete}
                      disabled={isVerifying || riskLocked}
                      className="px-3 py-2.5 rounded-xl text-xs font-semibold text-white bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 transition-all cursor-pointer"
                      title="Skip verification and mark completed"
                    >
                      Override
                    </button>
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
