/**
 * Gemini implementation of AiProvider.
 *
 * This is the ONLY file in the backend that knows about the Gemini SDK, the
 * Gemini prompt, or Gemini's `box_2d` coordinate convention. Swapping in a
 * YOLO/OpenCV/TensorFlow provider later means adding a sibling file that
 * implements AiProvider — no controller, model, or type changes.
 *
 * Security notes:
 *   - the API key is only ever read from the environment by the caller and held
 *     in memory here; it is never logged and never returned to a client
 *   - error text is scrubbed of anything key-shaped before it leaves this module
 *   - exactly one request per call: no retries, no background polling
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  AnalyzeFrameInput,
  RawProviderDetection,
  RawStepVerification,
  VerifyStepInput
} from '../../types/ai';
import {
  FAULT_LABELS,
  ProposeHypothesesInput,
  RawDiagnosticReasoning
} from '../../types/diagnostic';
import { AiProvider } from './aiProvider';

/** Gemini returns box_2d as [ymin, xmin, ymax, xmax] scaled to this range. */
const BOX_2D_SCALE = 1000;

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export class GeminiProviderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GeminiProviderError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Strip anything credential-shaped out of text that might get logged.
 * Belt-and-braces: the SDK sends the key as a header, but a future SDK version
 * or a proxy could surface it in an error string.
 */
const redact = (text: string, apiKey: string): string => {
  let safe = text;
  if (apiKey) safe = safe.split(apiKey).join('[REDACTED]');
  return safe
    .replace(/([?&](?:key|api_?key)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED]');
};

/**
 * Remove markdown fences and stray prose so JSON.parse has a chance.
 * Exported for unit tests.
 */
export const extractJsonText = (text: string): string => {
  let candidate = text.trim();

  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidate = fenced[1].trim();

  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace > 0 || (lastBrace !== -1 && lastBrace < candidate.length - 1)) {
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidate = candidate.slice(firstBrace, lastBrace + 1);
    }
  }

  return candidate;
};

const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Mechanically map Gemini's box conventions onto the neutral
 * `{ x, y, width, height }` 0..1 form the normalizer expects.
 *
 * This is a shape translation only. No validation or clamping happens here —
 * that is the normalizer's job, which is why the return type stays loose.
 *
 * Exported for unit tests: box_2d ordering is the single easiest thing to get
 * wrong in this file, so it is worth asserting directly.
 */
export const mapBox = (component: Record<string, unknown>): unknown => {
  const box2d = component.box_2d ?? component.box2d;
  if (Array.isArray(box2d) && box2d.length === 4) {
    const yMin = readNumber(box2d[0]);
    const xMin = readNumber(box2d[1]);
    const yMax = readNumber(box2d[2]);
    const xMax = readNumber(box2d[3]);
    if (yMin === null || xMin === null || yMax === null || xMax === null) return null;
    return {
      x: xMin / BOX_2D_SCALE,
      y: yMin / BOX_2D_SCALE,
      width: (xMax - xMin) / BOX_2D_SCALE,
      height: (yMax - yMin) / BOX_2D_SCALE
    };
  }

  // If the model answered with an already-normalized object instead, pass it
  // straight through for the normalizer to judge.
  const boundingBox = component.boundingBox ?? component.bbox;
  if (isRecord(boundingBox) || Array.isArray(boundingBox)) return boundingBox;

  return null;
};

const buildPrompt = (scenarioId?: string): string => {
  const focus = scenarioId
    ? `The user is working on the repair scenario "${scenarioId}". Prioritise components relevant to that repair, but only if you can actually see them.`
    : 'No repair scenario was supplied. Simply report what is visible.';

  return `You are the vision component of an electronics repair assistant. Analyse the supplied photograph of a device or an opened device interior.

${focus}

Return ONLY a JSON object with this exact shape:
{
  "device": {
    "type": "<broad category, e.g. laptop, desktop pc, smartphone, router, tablet, monitor, circuit board>",
    "brand": "<manufacturer, omit if not legible>",
    "model": "<model name, omit if not legible>",
    "confidence": <number between 0 and 1>
  },
  "components": [
    {
      "name": "<specific hardware component, e.g. RAM slot, cooling fan, battery connector, M.2 slot>",
      "confidence": <number between 0 and 1>,
      "box_2d": [ymin, xmin, ymax, xmax]
    }
  ]
}

Rules:
- box_2d values are integers from 0 to ${BOX_2D_SCALE}, measured from the top-left of the image, ordered [ymin, xmin, ymax, xmax].
- Report ONLY components you can actually see in this image. Do not list components you merely expect to be present.
- If you cannot identify the device, set "device" to null. Do NOT guess a device.
- If you can see no identifiable components, return an empty "components" array.
- "confidence" must reflect your real certainty. Never pad it to look confident.
- Report at most 12 components, most confident first.
- Output raw JSON only, with no markdown fences and no commentary.`;
};

/**
 * Flatten a scenario string before it goes into a prompt.
 *
 * The step text comes from the repository's own `demoScenarios`, not from the
 * request body — the controller looks the scenario up and passes what it found,
 * so an unrecognised id can never reach here. This is defence in depth for the
 * day that data becomes editable: it strips fences and newlines that could
 * restructure the prompt, and caps the length.
 */
const promptSafe = (value: string | undefined, maxLength = 300): string | null => {
  if (typeof value !== 'string') return null;
  const flattened = value.replace(/[`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flattened) return null;
  return flattened.length > maxLength ? flattened.slice(0, maxLength) : flattened;
};

/**
 * Prompt for evaluating ONE predefined repair step.
 *
 * Note what this prompt deliberately does NOT do: it never asks how to repair
 * the device, never asks what the user should do next, and never reveals the
 * other steps in the scenario. The model's entire job is to report whether the
 * evidence in this one frame supports the step already chosen by the repair
 * engine. Instruction selection stays in repairStepService.
 *
 * Exported for unit tests: "only the current step is exposed" is a property
 * worth asserting directly, since it is the architectural rule this phase
 * exists to enforce and it cannot be checked against the live API here.
 */
export const buildStepPrompt = (input: VerifyStepInput): string => {
  const stepTitle = promptSafe(input.step.stepTitle);
  const trigger = promptSafe(input.step.verificationTrigger, 120);

  const criteria = trigger
    ? `The repair system's verification key for this step is "${trigger}". Treat it as a hint about what evidence to look for.`
    : 'No additional verification criteria were supplied.';

  return `You are a visual repair-step verifier for an electronics repair assistant.

The repair system has ALREADY determined the current repair step. You are not choosing it and you are not choosing what comes after it.

Current step:
${stepTitle ?? '(no step description supplied)'}

Relevant verification criteria:
${criteria}

Analyse the supplied image. Determine whether the visible evidence indicates that this current step has been completed.

Return ONLY a JSON object with this exact shape:
{
  "stepCompleted": <true or false>,
  "confidence": <number between 0 and 1>,
  "observations": ["<short factual description of what you actually see>"],
  "components": [
    {
      "name": "<component you can see, e.g. battery connector>",
      "confidence": <number between 0 and 1>,
      "box_2d": [ymin, xmin, ymax, xmax]
    }
  ],
  "warnings": ["<reason the evidence is weak, e.g. the component is out of frame>"]
}

Rules:
- box_2d values are integers from 0 to ${BOX_2D_SCALE}, measured from the top-left of the image, ordered [ymin, xmin, ymax, xmax].
- Do NOT invent components that are not visible in this image.
- Do NOT invent repair instructions, advice, or next steps of any kind.
- Do NOT advance to another repair step or comment on any step other than the one above.
- Do NOT assume the action happened because it would be the logical next thing to do. Judge only the pixels in front of you.
- If the relevant component is hidden, out of frame, blurred or too dark to judge, set "stepCompleted" to false, report a LOW confidence, and say why in "warnings".
- "confidence" must reflect your real certainty about the verdict. Never pad it to look confident.
- Report at most 8 observations and at most 8 components.
- Output raw JSON only, with no markdown fences and no commentary.`;
};

/**
 * Prompt for diagnostic reasoning about a symptom.
 *
 * This prompt is deliberately CONSTRAINED. It asks only for a classification of
 * possible faults into the fixed vocabulary supplied by the caller, plus short
 * factual observations. It explicitly forbids the model from proposing any
 * physical action, test, tool, disassembly, or repair procedure — that decision
 * is made deterministically and safely by the test selector, never by the
 * model. The symptom text is flattened first so a user cannot restructure the
 * prompt via injection.
 *
 * Exported for unit tests: "the model may only use the allowed fault codes and
 * is never asked what the user should physically do" is the architectural rule
 * this prompt enforces, and it cannot be checked against the live API here.
 */
export const buildDiagnosticPrompt = (input: ProposeHypothesesInput): string => {
  const symptom = promptSafe(input.symptom, 600) ?? '(no symptom description supplied)';

  const deviceLine = input.device
    ? `A camera identified the device as type "${input.device.type}"${
        input.device.brand ? `, brand "${input.device.brand}"` : ''
      }${input.device.model ? `, model "${input.device.model}"` : ''} (identification confidence ${input.device.confidence.toFixed(
        2
      )}). Treat this as context, not proof.`
    : 'No device could be identified from an image. Reason from the symptom text alone and stay cautious.';

  const observationLines =
    input.observations.length > 0
      ? input.observations
          .map((o) => promptSafe(o, 200))
          .filter((o): o is string => Boolean(o))
          .map((o) => `- ${o}`)
          .join('\n')
      : '- (none recorded yet)';

  const faultList = input.candidateFaults
    .map((code) => `- "${code}": ${FAULT_LABELS[code] ?? code}`)
    .join('\n');

  return `You are the diagnostic-reasoning component of an electronics repair assistant.

Your ONLY job is to propose which faults could explain the reported symptom. You are NOT choosing what the user should do, and a separate deterministic system decides every physical action.

Reported symptom:
${symptom}

Device context:
${deviceLine}

Prior observations:
${observationLines}

You may ONLY classify faults using these exact codes:
${faultList}

Return ONLY a JSON object with this exact shape:
{
  "observations": ["<short factual interpretation of the symptom or device, no advice>"],
  "hypotheses": [
    {
      "code": "<one of the allowed fault codes above, verbatim>",
      "label": "<short human-readable label for the fault>",
      "confidence": <number between 0 and 1>,
      "rationale": "<one sentence: why this fault could explain the symptom>",
      "supportedBy": ["<which symptom detail or observation supports this>"]
    }
  ]
}

Rules:
- "code" MUST be exactly one of the allowed codes above. Never invent a new code or category.
- Propose at most 5 hypotheses, most likely first. If several faults are plausible, list them; do not force a single answer.
- "confidence" must reflect your real uncertainty. If the symptom is vague or no device was identified, keep confidence low.
- If nothing in the list plausibly applies, return a single hypothesis with code "unknown".
- Do NOT recommend any physical action, diagnostic test, tool, measurement, disassembly, power operation, or repair step of any kind. You classify faults only.
- Do NOT invent device details, part numbers, or observations you cannot justify from the input.
- Output raw JSON only, with no markdown fences and no commentary.`;
};

export class GeminiProvider implements AiProvider {
  public readonly name = 'gemini';

  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly timeoutMs: number;
  private readonly client: GoogleGenerativeAI;

  public constructor(options: GeminiProviderOptions) {
    if (!options.apiKey) {
      throw new GeminiProviderError('Gemini provider requires an API key.');
    }
    this.apiKey = options.apiKey;
    this.modelName = options.model ?? 'gemini-2.0-flash';
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.client = new GoogleGenerativeAI(this.apiKey);
  }

  /**
   * One request, one response, one JSON object. Shared by all provider methods
   * so there is a single place where the model is called, errors are redacted,
   * and latency is recorded.
   *
   * `image` is OPTIONAL: perception calls (analyzeFrame/verifyStep) send a
   * frame, but diagnostic reasoning is text-only — no image is uploaded for it,
   * which keeps perception and reasoning distinct and avoids a second image
   * upload per interaction.
   *
   * `label` only ever identifies which operation ran — no prompt content, no
   * image data, and no credentials are logged.
   */
  private async requestJson(
    label: string,
    prompt: string,
    image?: { data: string; mimeType: string } | null
  ): Promise<Record<string, unknown>> {
    const model = this.client.getGenerativeModel({
      model: this.modelName,
      generationConfig: {
        // Low temperature: this is a perception/classification task, not a
        // creative one.
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    });

    const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [
      { text: prompt }
    ];
    if (image) {
      parts.push({ inlineData: { data: image.data, mimeType: image.mimeType } });
    }

    const startedAt = Date.now();
    let text: string;
    try {
      const result = await model.generateContent(parts, { timeout: this.timeoutMs });
      text = result.response.text();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[geminiProvider] ${label} model round-trip failed after ${Date.now() - startedAt}ms`
      );
      throw new GeminiProviderError(redact(detail, this.apiKey));
    }
    console.info(`[geminiProvider] ${label} model round-trip ${Date.now() - startedAt}ms`);

    if (!text || !text.trim()) {
      throw new GeminiProviderError('Gemini returned an empty response.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonText(text));
    } catch {
      throw new GeminiProviderError('Gemini response was not valid JSON.');
    }

    if (!isRecord(parsed)) {
      throw new GeminiProviderError('Gemini response was not a JSON object.');
    }

    return parsed;
  }

  /** Translate whatever box convention the model used into neutral fractions. */
  private static mapComponents(value: unknown): unknown[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry) => {
      if (!isRecord(entry)) return entry;
      return {
        name: entry.name ?? entry.label,
        confidence: entry.confidence,
        boundingBox: mapBox(entry)
      };
    });
  }

  /**
   * One request, one response. Returns raw (untrusted) output for the
   * normalizer to validate.
   */
  public async analyzeFrame(input: AnalyzeFrameInput): Promise<RawProviderDetection> {
    const parsed = await this.requestJson('analyzeFrame', buildPrompt(input.scenarioId), input.image);

    return {
      device: parsed.device ?? null,
      components: GeminiProvider.mapComponents(parsed.components)
    };
  }

  /**
   * Evaluate the current predefined step against the frame.
   *
   * Returns raw, untrusted output. In particular the completion verdict is
   * passed through as-is for the normalizer to read strictly and for
   * repairStepService to gate on confidence — this method does not decide
   * anything about the repair.
   */
  public async verifyStep(input: VerifyStepInput): Promise<RawStepVerification> {
    const parsed = await this.requestJson('verifyStep', buildStepPrompt(input), input.image);

    return {
      stepCompleted: parsed.stepCompleted ?? parsed.step_completed,
      confidence: parsed.confidence,
      observations: parsed.observations ?? parsed.notes,
      components: GeminiProvider.mapComponents(parsed.components ?? parsed.visibleComponents),
      warnings: parsed.warnings
    };
  }

  /**
   * Propose fault hypotheses for a symptom. Text-only: no image is uploaded
   * here (perception already happened via analyzeFrame), so this is one cheap
   * reasoning round-trip per session.
   *
   * Returns raw, untrusted output. In particular the fault codes are passed
   * through as-is for the normalizer to validate against the allowed
   * vocabulary — this method neither decides an action nor filters codes.
   */
  public async proposeHypotheses(input: ProposeHypothesesInput): Promise<RawDiagnosticReasoning> {
    const parsed = await this.requestJson('proposeHypotheses', buildDiagnosticPrompt(input));

    return {
      observations: parsed.observations ?? parsed.notes,
      hypotheses: parsed.hypotheses ?? parsed.faults
    };
  }
}
