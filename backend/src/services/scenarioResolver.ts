/**
 * Scenario resolver — DetectionResult -> supported scenarioId, or null.
 *
 * This is the "discovery" half of the device-identification-first flow. The
 * vision layer says WHAT IT SEES; this module decides WHICH SUPPORTED REPAIR
 * PROCEDURE that observation corresponds to. Those are deliberately separate
 * jobs, for the same reason repairStepService is separate from the providers:
 * a model must never be able to choose or author a repair procedure.
 *
 * Hard boundaries (enforced by having no imports that would allow otherwise):
 *   - it does NOT call Gemini, or any model. It is pure and synchronous.
 *   - it does NOT generate, author, or edit repair instructions.
 *   - it does NOT duplicate demoScenarios; it only ever returns a key of it.
 *   - it never invents a device, a model name, or a confidence value.
 *
 * IMPORTANT — these mappings are NOT universal device knowledge. They are
 * narrow, hand-written rules covering exactly the five demo scenarios this
 * product supports. "A laptop with a visible RAM slot" is mapped to the HP
 * Pavilion RAM-upgrade walkthrough because that is the only RAM procedure that
 * exists here, not because the procedure is correct for every laptop. Anything
 * outside these rules must resolve to null so the UI can say "no supported
 * repair procedure is available" instead of starting the wrong repair.
 */

import { demoScenarios } from '../data/demoScenarios';
import { DetectionResult } from '../types/ai';

/**
 * The resolver's verdict.
 * `scenarioId` is null when nothing matched confidently; `reason` always
 * explains the decision so it can be logged and inspected.
 */
export interface ScenarioMatch {
  /** A key of demoScenarios, or null when no supported procedure applies. */
  scenarioId: string | null;
  /** 0..1. Derived from real evidence — never fabricated. */
  confidence: number;
  /** Human-readable, inspectable explanation of the decision. */
  reason: string;
}

/**
 * One explicit, inspectable mapping rule.
 *
 * `deviceTypeKeywords` is a HARD GATE: if the reported device type does not
 * match, the scenario is not even a candidate. This is the main defence against
 * false matches, because the device class is what makes two procedures
 * incompatible (you cannot run a desktop M.2 install on a phone).
 */
export interface ScenarioRule {
  scenarioId: string;
  /** Hard gate on device type. At least one must match. */
  deviceTypeKeywords: string[];
  /** Supporting evidence: manufacturer. */
  brandKeywords: string[];
  /** Supporting evidence: model / product line. */
  modelKeywords: string[];
  /** Components consistent with this procedure. */
  componentKeywords: string[];
  /**
   * Components that point at THIS scenario and no other supported one. These
   * break ties between scenarios that share a device type (the two laptop
   * procedures), which is the only genuinely ambiguous case in the current set.
   */
  decisiveComponentKeywords: string[];
}

/** Evidence weights. Tuned so the hard gate alone can never clear the bar. */
const WEIGHT_DEVICE_TYPE = 0.4;
const WEIGHT_BRAND = 0.15;
const WEIGHT_MODEL = 0.15;
const WEIGHT_COMPONENT = 0.15;
const MAX_COMPONENT_WEIGHT = 0.3;
const WEIGHT_DECISIVE_COMPONENT = 0.15;

/**
 * A device identified less confidently than this is not acted on at all. Poor
 * device identification is exactly when a wrong-procedure match is most likely.
 */
export const MIN_DEVICE_CONFIDENCE = 0.4;

/** Final confidence a match must reach to be returned. */
export const MIN_MATCH_CONFIDENCE = 0.5;

/**
 * How far ahead of the runner-up the winner must be (in raw evidence score).
 * Two near-equal candidates mean the evidence does not distinguish them, and
 * guessing between two different repair procedures is worse than declining.
 */
export const MIN_SCORE_MARGIN = 0.08;

/** Components below this confidence are ignored as evidence. */
const MIN_COMPONENT_CONFIDENCE = 0.35;

/**
 * The five supported mappings, written out explicitly.
 *
 * Keyword lists are intentionally verbose rather than clever: they are meant to
 * be read and audited by a human, and extended by hand when a new scenario is
 * added to demoScenarios.
 */
export const SCENARIO_RULES: ScenarioRule[] = [
  {
    // HP Pavilion 15 / laptop / RAM slot -> RAM upgrade
    scenarioId: 'laptop_ram_upgrade',
    deviceTypeKeywords: ['laptop', 'notebook', 'ultrabook', 'netbook'],
    brandKeywords: ['hp', 'hewlett packard', 'hewlett-packard'],
    modelKeywords: ['pavilion', 'pavilion 15'],
    componentKeywords: [
      'ram',
      'ram slot',
      'memory',
      'memory slot',
      'memory module',
      'dimm',
      'so dimm',
      'sodimm',
      'ddr',
      'ddr3',
      'ddr4',
      'ddr5',
      'bottom cover',
      'battery connector',
      'battery connection',
      'cooling fan'
    ],
    decisiveComponentKeywords: [
      'ram',
      'ram slot',
      'memory slot',
      'memory module',
      'dimm',
      'so dimm',
      'sodimm',
      'ddr',
      'ddr3',
      'ddr4',
      'ddr5'
    ]
  },
  {
    // Dell Inspiron desktop / M.2 / NVMe -> SSD installation
    scenarioId: 'ssd_installation',
    deviceTypeKeywords: [
      'desktop',
      'desktop pc',
      'pc',
      'tower',
      'desktop computer',
      'motherboard',
      'mainboard'
    ],
    brandKeywords: ['dell'],
    modelKeywords: ['inspiron'],
    componentKeywords: [
      'm 2',
      'm2',
      'nvme',
      'ssd',
      'solid state',
      'pcie',
      'pci e',
      'pcie 16x',
      'sata',
      'sata connector',
      'cpu cooler',
      'side cover',
      'standoff'
    ],
    decisiveComponentKeywords: ['m 2', 'm2', 'nvme', 'ssd', 'solid state', 'sata']
  },
  {
    // MacBook Air (Intel) / battery or logic board -> laptop not booting
    scenarioId: 'laptop_not_booting',
    deviceTypeKeywords: ['laptop', 'notebook', 'ultrabook', 'macbook'],
    brandKeywords: ['apple', 'macbook'],
    modelKeywords: ['macbook', 'macbook air', 'air', 'a1466', 'a1932'],
    componentKeywords: [
      'logic board',
      'mainboard',
      'motherboard',
      'io board',
      'i o board',
      'io power board',
      'power board',
      'battery',
      'battery pack',
      'magsafe',
      'charger',
      'charging port',
      'dc in'
    ],
    decisiveComponentKeywords: [
      'logic board',
      'io power board',
      'io board',
      'i o board',
      'magsafe',
      'dc in'
    ]
  },
  {
    // Samsung Galaxy S21 / USB-C charging board -> broken charging port
    scenarioId: 'broken_charging_port',
    deviceTypeKeywords: [
      'smartphone',
      'phone',
      'mobile phone',
      'cell phone',
      'cellphone',
      'mobile',
      'handset'
    ],
    brandKeywords: ['samsung'],
    modelKeywords: ['galaxy', 'galaxy s21', 's21'],
    componentKeywords: [
      'usb c',
      'usbc',
      'usb type c',
      'charging board',
      'charging port',
      'charging flex',
      'dock',
      'dock board',
      'sub board',
      'daughter board',
      'flex cable',
      'flex ribbon',
      'ribbon cable',
      'battery',
      'battery pack',
      'wireless charging coil',
      'charging coil'
    ],
    decisiveComponentKeywords: [
      'usb c',
      'usbc',
      'usb type c',
      'charging board',
      'charging port',
      'dock board',
      'charging flex',
      'charging coil'
    ]
  },
  {
    // Linksys AC1900 / antenna leads / WiFi chipset -> WiFi adapter issue
    scenarioId: 'wifi_adapter_issue',
    deviceTypeKeywords: [
      'router',
      'wifi router',
      'wireless router',
      'access point',
      'modem',
      'gateway'
    ],
    brandKeywords: ['linksys', 'cisco'],
    modelKeywords: ['ac1900', 'wrt', 'ea6900'],
    componentKeywords: [
      'antenna',
      'antenna lead',
      'antenna feeder',
      'feeder lead',
      'coax',
      'coaxial',
      'u fl',
      'ufl',
      'wifi',
      'wi fi',
      'wireless',
      'transceiver',
      'chipset',
      'wifi chipset',
      'power regulator',
      'voltage regulator'
    ],
    decisiveComponentKeywords: [
      'antenna',
      'antenna lead',
      'antenna feeder',
      'feeder lead',
      'u fl',
      'ufl',
      'coax',
      'coaxial',
      'transceiver',
      'wifi chipset'
    ]
  }
];

/**
 * Normalize free text to a space-padded, punctuation-collapsed form.
 *
 * Padding both haystack and needle with spaces gives word-boundary matching for
 * free: ' ram ' does not match ' dram ', but ' m 2 nvme slot ' does contain
 * ' m 2 ' (because 'M.2' collapses to 'm 2').
 */
const spaced = (value: string): string =>
  ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')} `;

/** Punctuation removed entirely, e.g. 'USB-C' -> 'usbc'. */
const squashed = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Minimum squashed length for the no-punctuation fallback match. Short tokens
 * are excluded so 'ram' can never match inside 'dram' or 'program'.
 */
const MIN_SQUASH_LENGTH = 4;

/** True when `keyword` occurs in `text` as a whole token sequence. */
const textMatches = (text: string, keyword: string): boolean => {
  if (spaced(text).includes(spaced(keyword))) return true;
  // Fallback for models that drop the separator entirely ('USBC', 'MFL').
  const needle = squashed(keyword);
  return needle.length >= MIN_SQUASH_LENGTH && squashed(text).includes(needle);
};

/** True when any keyword occurs in any of the supplied texts. */
const anyMatch = (texts: string[], keywords: string[]): boolean =>
  keywords.some((keyword) => texts.some((text) => textMatches(text, keyword)));

/** Which of `keywords` matched at least one text. Used to count evidence. */
const matchedKeywords = (texts: string[], keywords: string[]): string[] =>
  keywords.filter((keyword) => texts.some((text) => textMatches(text, keyword)));

interface Candidate {
  rule: ScenarioRule;
  /** Raw evidence score, 0..~1.15 before clamping. */
  score: number;
  /** Short evidence labels, used to build the reason string. */
  evidence: string[];
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Round to 2dp so the API returns a stable, readable number. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Score one rule against one observation.
 * Returns null when the device-type gate fails — not a candidate at all.
 */
const scoreRule = (
  rule: ScenarioRule,
  deviceTexts: string[],
  componentNames: string[]
): Candidate | null => {
  if (!anyMatch(deviceTexts, rule.deviceTypeKeywords)) return null;

  const evidence: string[] = ['device type'];
  let score = WEIGHT_DEVICE_TYPE;

  if (anyMatch(deviceTexts, rule.brandKeywords)) {
    score += WEIGHT_BRAND;
    evidence.push('brand');
  }
  if (anyMatch(deviceTexts, rule.modelKeywords)) {
    score += WEIGHT_MODEL;
    evidence.push('model');
  }

  const componentHits = matchedKeywords(componentNames, rule.componentKeywords);
  if (componentHits.length > 0) {
    score += Math.min(MAX_COMPONENT_WEIGHT, componentHits.length * WEIGHT_COMPONENT);
    evidence.push(`components (${componentHits.slice(0, 3).join(', ')})`);
  }

  if (anyMatch(componentNames, rule.decisiveComponentKeywords)) {
    score += WEIGHT_DECISIVE_COMPONENT;
    evidence.push('scenario-specific component');
  }

  return { rule, score, evidence };
};

/**
 * Resolve a validated detection to one supported scenario.
 *
 * Deterministic: the same DetectionResult always produces the same verdict.
 * There is no model call, no randomness, and no I/O.
 */
export const resolveScenario = (detection: DetectionResult): ScenarioMatch => {
  const device = detection.device;

  // 1. A device is required. Components alone cannot select a procedure: the
  //    device class is what separates, say, a laptop RAM upgrade from a desktop
  //    M.2 install, and guessing it wrong starts the wrong repair.
  if (!device) {
    return {
      scenarioId: null,
      confidence: 0,
      reason: 'No device was identified in the frame, so no repair scenario could be matched.'
    };
  }

  // 2. Weak identification is not acted on.
  if (device.confidence < MIN_DEVICE_CONFIDENCE) {
    return {
      scenarioId: null,
      confidence: round2(clamp01(device.confidence)),
      reason:
        `Device identification confidence ${round2(device.confidence)} is below the ` +
        `${MIN_DEVICE_CONFIDENCE} minimum required to select a repair scenario.`
    };
  }

  const deviceTexts = [device.type, device.brand ?? '', device.model ?? ''].filter(
    (text) => text.trim().length > 0
  );

  // Only components the vision layer was reasonably sure about count as evidence.
  const componentNames = detection.components
    .filter((component) => component.confidence >= MIN_COMPONENT_CONFIDENCE)
    .map((component) => component.name);

  // 3. Score every rule whose scenario actually exists in demoScenarios, so a
  //    stale rule can never return an id with no real steps behind it.
  const candidates = SCENARIO_RULES.filter((rule) => Boolean(demoScenarios[rule.scenarioId]))
    .map((rule) => scoreRule(rule, deviceTexts, componentNames))
    .filter((candidate): candidate is Candidate => candidate !== null)
    .sort((a, b) => b.score - a.score);

  const describeDevice = [device.brand, device.model, device.type]
    .filter((part) => Boolean(part && part.trim()))
    .join(' ');

  if (candidates.length === 0) {
    return {
      scenarioId: null,
      confidence: 0,
      reason: `Identified "${describeDevice}", which does not match any supported repair scenario.`
    };
  }

  const winner = candidates[0];
  const runnerUp = candidates[1];

  // 4. Ambiguity check. Two comparable candidates mean the evidence does not
  //    actually distinguish the procedures, so decline rather than guess.
  if (runnerUp && winner.score - runnerUp.score < MIN_SCORE_MARGIN) {
    return {
      scenarioId: null,
      confidence: round2(clamp01(winner.score * device.confidence)),
      reason:
        `Identified "${describeDevice}", but the evidence matches ${winner.rule.scenarioId} and ` +
        `${runnerUp.rule.scenarioId} about equally. More of the device needs to be visible to ` +
        'choose a repair scenario.'
    };
  }

  // 5. Final confidence combines evidence strength with how sure the vision
  //    layer was about the device. Both are real measurements.
  const confidence = round2(clamp01(winner.score) * device.confidence);

  if (confidence < MIN_MATCH_CONFIDENCE) {
    return {
      scenarioId: null,
      confidence: round2(confidence),
      reason:
        `Identified "${describeDevice}", but the combined match confidence ${round2(confidence)} ` +
        `is below the ${MIN_MATCH_CONFIDENCE} minimum. Matched on ${winner.evidence.join(', ')}.`
    };
  }

  return {
    scenarioId: winner.rule.scenarioId,
    confidence: round2(confidence),
    reason:
      `Identified "${describeDevice}" and matched supported scenario ` +
      `${winner.rule.scenarioId} on ${winner.evidence.join(', ')}.`
  };
};
