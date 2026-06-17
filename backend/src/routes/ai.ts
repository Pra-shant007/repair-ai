import { Router } from 'express';
import { detectComponents, verifyStep, queryAssistant } from '../controllers/aiController';
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

export default router;
