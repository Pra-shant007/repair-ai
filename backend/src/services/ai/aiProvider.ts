import { AnalyzeFrameInput, RawProviderDetection, RawStepVerification, VerifyStepInput } from '../../types/ai';

/**
 * The replaceability boundary for the AI perception layer.
 *
 * Controllers depend on this interface (via aiService), never on a concrete
 * provider. Adding a YOLO/OpenCV/TensorFlow backend later means adding one
 * file that implements this interface — no controller or model changes.
 */
export interface AiProvider {
  /** Short identifier surfaced to clients as `source`, e.g. 'gemini' | 'mock'. */
  readonly name: string;

  /**
   * Analyze a single frame.
   *
   * Returns RAW, UNTRUSTED output. The caller is responsible for passing it
   * through the normalizer — implementations must not be assumed to return a
   * valid DetectionResult.
   */
  analyzeFrame(input: AnalyzeFrameInput): Promise<RawProviderDetection>;

  /**
   * Report visual evidence about ONE predefined repair step.
   *
   * Also returns RAW, UNTRUSTED output for the normalizer to validate.
   *
   * Implementations must confine themselves to describing the supplied frame.
   * They receive only the current step and must not be given, or asked to
   * produce, repair instructions or a next step — that decision belongs to
   * services/repairStepService.ts, which is deterministic.
   */
  verifyStep(input: VerifyStepInput): Promise<RawStepVerification>;
}
