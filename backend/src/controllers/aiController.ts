import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { isUsingMockDB, mockDB } from '../config/db';
import Diagnostic from '../models/Diagnostic';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const genAI = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY || ""
);
// Core Demo scenarios data used in both frontend and backend
export const demoScenarios: Record<string, {
  deviceName: string;
  deviceType: string;
  confidenceScore: number;
  difficultyScore: number;
  estimatedCost: number;
  successProbability: number;
  components: Array<{ name: string; bbox: [number, number, number, number]; confidence: number }>;
  steps: Array<{ stepIndex: number; stepTitle: string; safetyRisk: 'safe' | 'medium' | 'high'; verificationTrigger: string }>;
  chatContext: string;
}> = {
  laptop_ram_upgrade: {
    deviceName: 'HP Pavilion 15',
    deviceType: 'Laptop',
    confidenceScore: 98.20,
    difficultyScore: 25,
    estimatedCost: 85.00,
    successProbability: 98.00,
    components: [
      { name: 'RAM Slot A', bbox: [250, 160, 180, 50], confidence: 0.99 },
      { name: 'RAM Slot B', bbox: [250, 220, 180, 50], confidence: 0.98 },
      { name: 'Battery Connection', bbox: [100, 320, 140, 60], confidence: 0.97 },
      { name: 'Cooling Fan', bbox: [450, 80, 120, 120], confidence: 0.96 }
    ],
    steps: [
      { stepIndex: 1, stepTitle: 'Remove the 6 bottom cover Phillips screws.', safetyRisk: 'safe', verificationTrigger: 'screws_removed' },
      { stepIndex: 2, stepTitle: 'Disconnect the battery safety connector to prevent short circuits.', safetyRisk: 'high', verificationTrigger: 'battery_disconnected' },
      { stepIndex: 3, stepTitle: 'Open the metal retaining clips on the sides of the active RAM module.', safetyRisk: 'safe', verificationTrigger: 'clips_opened' },
      { stepIndex: 4, stepTitle: 'Insert the new DDR4 RAM module firmly at a 30-degree angle, then press down to click.', safetyRisk: 'medium', verificationTrigger: 'ram_inserted' }
    ],
    chatContext: 'For upgrading RAM: Make sure to work on an anti-static mat. Always unplug the battery first (Step 2) because a dropped screw on the motherboard can short it out! Align the notch on the memory stick with the key in the socket.'
  },
  ssd_installation: {
    deviceName: 'Dell Inspiron Desktop',
    deviceType: 'PC',
    confidenceScore: 95.80,
    difficultyScore: 35,
    estimatedCost: 110.00,
    successProbability: 95.00,
    components: [
      { name: 'M.2 NVMe Slot', bbox: [320, 240, 160, 40], confidence: 0.96 },
      { name: 'PCIe 16x Slot', bbox: [120, 150, 350, 60], confidence: 0.98 },
      { name: 'CPU Cooler', bbox: [280, 50, 140, 140], confidence: 0.99 },
      { name: 'SATA Connectors', bbox: [490, 300, 80, 100], confidence: 0.94 }
    ],
    steps: [
      { stepIndex: 1, stepTitle: 'Unscrew the thumb screws and slide off the left side metal cover.', safetyRisk: 'safe', verificationTrigger: 'cover_removed' },
      { stepIndex: 2, stepTitle: 'Locate the PCIe M.2 NVMe storage slot near the CPU fan.', safetyRisk: 'safe', verificationTrigger: 'm2_located' },
      { stepIndex: 3, stepTitle: 'Remove the M.2 retaining screw from the motherboard standoff.', safetyRisk: 'safe', verificationTrigger: 'screw_removed' },
      { stepIndex: 4, stepTitle: 'Slide the M.2 SSD into the socket and secure it with the standoff screw.', safetyRisk: 'medium', verificationTrigger: 'ssd_secured' }
    ],
    chatContext: 'For M.2 SSD installation: Ensure you insert the drive at a slight angle before pressing down. Secure it with the tiny screw, but do not overtighten it. If it is not recognized in BIOS, verify that it is fully seated.'
  },
  laptop_not_booting: {
    deviceName: 'MacBook Air 13" (Intel)',
    deviceType: 'Laptop',
    confidenceScore: 94.50,
    difficultyScore: 60,
    estimatedCost: 220.00,
    successProbability: 75.00,
    components: [
      { name: 'Logic Board', bbox: [80, 60, 480, 240], confidence: 0.95 },
      { name: 'IO Power Board', bbox: [30, 40, 70, 90], confidence: 0.97 },
      { name: 'Battery Pack', bbox: [50, 310, 540, 120], confidence: 0.99 }
    ],
    steps: [
      { stepIndex: 1, stepTitle: 'Connect the MagSafe charger and check the light color (amber = charging, green = charged, none = issue).', safetyRisk: 'safe', verificationTrigger: 'charger_connected' },
      { stepIndex: 2, stepTitle: 'Disconnect the battery connector to isolate power issues and run on charger direct.', safetyRisk: 'high', verificationTrigger: 'battery_isolated' },
      { stepIndex: 3, stepTitle: 'Perform an SMC reset (Shift + Control + Option + Power button) to reset hardware controllers.', safetyRisk: 'medium', verificationTrigger: 'smc_reset' },
      { stepIndex: 4, stepTitle: 'Reconnect the battery and test booting. If screen remains black, hook up an external HDMI monitor to check graphics.', safetyRisk: 'medium', verificationTrigger: 'boot_tested' }
    ],
    chatContext: 'Laptop not booting: If the fan spins but the screen is blank, the screen backlight or display cable may be faulty. An SMC reset is effective when charging controllers fail.'
  },
  broken_charging_port: {
    deviceName: 'Samsung Galaxy S21',
    deviceType: 'Smartphone',
    confidenceScore: 96.10,
    difficultyScore: 80,
    estimatedCost: 75.00,
    successProbability: 80.00,
    components: [
      { name: 'USB-C Charging Board', bbox: [260, 380, 120, 60], confidence: 0.98 },
      { name: 'Main Battery Pack', bbox: [180, 100, 280, 260], confidence: 0.99 },
      { name: 'Main Flex Cable Ribbon', bbox: [220, 290, 200, 80], confidence: 0.96 }
    ],
    steps: [
      { stepIndex: 1, stepTitle: 'Apply heat gun along the glass edges to soften back cover glue.', safetyRisk: 'high', verificationTrigger: 'back_heated' },
      { stepIndex: 2, stepTitle: 'Apply a suction tool and gently slide opening picks to separate the back cover.', safetyRisk: 'medium', verificationTrigger: 'back_separated' },
      { stepIndex: 3, stepTitle: 'Unscrew the wireless charging coil screws and disconnect its connector.', safetyRisk: 'medium', verificationTrigger: 'coil_removed' },
      { stepIndex: 4, stepTitle: 'Remove the sub-board shielding cover to reveal the USB-C dock board.', safetyRisk: 'safe', verificationTrigger: 'shield_removed' },
      { stepIndex: 5, stepTitle: 'Disconnect the main flex ribbon, unscrew and replace the USB-C charging board.', safetyRisk: 'high', verificationTrigger: 'board_replaced' }
    ],
    chatContext: 'USB-C port replacement: A heat gun should not be held in one place for more than 5 seconds or it will melt the battery or display components. Watch the battery! Keep sharp picks away from the battery cells.'
  },
  wifi_adapter_issue: {
    deviceName: 'Linksys AC1900 Router',
    deviceType: 'Router',
    confidenceScore: 92.40,
    difficultyScore: 50,
    estimatedCost: 35.00,
    successProbability: 90.00,
    components: [
      { name: 'WiFi Transceiver Chipset', bbox: [200, 150, 140, 140], confidence: 0.91 },
      { name: 'Antenna Feeder Leads', bbox: [80, 50, 480, 80], confidence: 0.95 },
      { name: 'Power Input Regulators', bbox: [450, 250, 100, 120], confidence: 0.96 }
    ],
    steps: [
      { stepIndex: 1, stepTitle: 'Remove the rubber feet pads and locate the structural screw slots.', safetyRisk: 'safe', verificationTrigger: 'feet_removed' },
      { stepIndex: 2, stepTitle: 'Unscrew and pry open the plastic outer housing clips.', safetyRisk: 'safe', verificationTrigger: 'housing_opened' },
      { stepIndex: 3, stepTitle: 'Examine antenna wire micro-coaxial (U.FL) connections. Check if they have popped off.', safetyRisk: 'safe', verificationTrigger: 'antennas_checked' },
      { stepIndex: 4, stepTitle: 'Press down on coaxial connectors to snap them back onto the gold pads, or solder broken leads.', safetyRisk: 'medium', verificationTrigger: 'leads_secured' }
    ],
    chatContext: 'Router repair: Micro-coaxial cables snap on with a tiny click. Do not press too hard or you will damage the gold receiver socket on the logic board. No static should touch the chipsets.'
  }
};

// Simulated YOLO detection API
export const detectComponents = async (req: AuthenticatedRequest, res: Response) => {
  const { scenarioId } = req.body; // or read parsed webcam frame

  if (!scenarioId || !demoScenarios[scenarioId]) {
    return res.status(400).json({ message: 'Invalid or missing scenario ID for detection' });
  }

  const scenario = demoScenarios[scenarioId];

  // Store this scan in the diagnostics database
  try {
    let newDiag: any;

    if (isUsingMockDB) {
      newDiag = {
        _id: `d-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        userId: req.user?.id || null,
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
    } else {
      newDiag = new Diagnostic({
        userId: req.user?.id || undefined,
        deviceName: scenario.deviceName,
        deviceType: scenario.deviceType,
        confidenceScore: scenario.confidenceScore,
        componentsDetected: scenario.components,
        difficultyScore: scenario.difficultyScore,
        estimatedCost: scenario.estimatedCost,
        successProbability: scenario.successProbability
      });
      await newDiag.save();
    }

    return res.status(200).json({
      diagnosticId: newDiag._id.toString(),
      deviceName: scenario.deviceName,
      deviceType: scenario.deviceType,
      confidenceScore: scenario.confidenceScore,
      components: scenario.components,
      difficultyScore: scenario.difficultyScore,
      estimatedCost: scenario.estimatedCost,
      successProbability: scenario.successProbability,
      steps: scenario.steps
    });
  } catch (error) {
    return res.status(500).json({ message: 'Component detection failed', error: (error as Error).message });
  }
};

// Simulated Continuous Step Verification API
export const verifyStep = async (req: AuthenticatedRequest, res: Response) => {
  const { scenarioId, stepIndex, frameImage } = req.body; // frameImage is base64 snapshot

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

  return res.status(200).json({
    verified: isVerified,
    message: verificationLog,
    confidence: (85 + Math.random() * 14).toFixed(2),
    timestamp: new Date()
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

