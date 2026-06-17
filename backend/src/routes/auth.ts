import { Router } from 'express';
import { signUp, signIn, getProfile, socialLogin } from '../controllers/authController';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Public routes
router.post('/signup', signUp as any);
router.post('/signin', signIn as any);
router.post('/social-login', socialLogin as any);

// Protected routes
router.get('/profile', authMiddleware as any, getProfile as any);

export default router;
