import { Router } from 'express';
import { getDashboardStats, startRepair, updateRepairStep, saveDiagnosticReport } from '../controllers/repairController';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Secure all repair endpoints
router.use(authMiddleware as any);

router.get('/stats', getDashboardStats as any);
router.post('/start', startRepair as any);
router.patch('/:repairId/step', updateRepairStep as any);
router.post('/report', saveDiagnosticReport as any);

export default router;
