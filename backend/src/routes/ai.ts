import { Router } from 'express';
import { detectComponents, verifyStep, queryAssistant } from '../controllers/aiController';
import {
  diagnose,
  getDiagnosis,
  linkDiagnosisRepair,
  submitDiagnosisResult
} from '../controllers/diagnosticController';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Allow optional auth to support guest scan test runs
const optionalAuth = (req: any, res: any, next: any) => {
  if (req.headers.authorization) {
    return authMiddleware(req, res, next);
  }
  next();
};

router.post('/detect', optionalAuth as any, detectComponents as any);
router.post('/verify', optionalAuth as any, verifyStep as any);
router.post('/chat', optionalAuth as any, queryAssistant as any);

// Diagnostic copilot. Same optionalAuth convention as the routes above so a
// guest can run a diagnosis. The two `:sessionId` sub-routes are declared before
// the bare GET so Express matches the more specific paths first.
router.post('/diagnose', optionalAuth as any, diagnose as any);
router.post('/diagnose/:sessionId/result', optionalAuth as any, submitDiagnosisResult as any);
router.post('/diagnose/:sessionId/repair', optionalAuth as any, linkDiagnosisRepair as any);
router.get('/diagnose/:sessionId', optionalAuth as any, getDiagnosis as any);

export default router;
