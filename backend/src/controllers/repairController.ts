import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { isUsingMockDB, mockDB } from '../config/db';
import Repair from '../models/Repair';
import Report from '../models/Report';
import Diagnostic from '../models/Diagnostic';

// Get Dashboard Statistics
export const getDashboardStats = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    let diagnosticsList: any[] = [];
    let repairsList: any[] = [];

    if (isUsingMockDB) {
      diagnosticsList = mockDB.diagnostics.filter(d => d.userId === userId);
      repairsList = mockDB.repairs.filter(r => r.userId === userId);
    } else {
      diagnosticsList = await Diagnostic.find({ userId }).sort({ createdAt: -1 });
      repairsList = await Repair.find({ userId }).sort({ updatedAt: -1 });
    }

    const completedRepairs = repairsList.filter(r => r.status === 'completed').length;
    const activeRepairs = repairsList.filter(r => r.status === 'in_progress').length;

    // Calculate dynamic health score: based on percentage of completed repairs and success rates
    let totalScore = 95; // Default healthy baseline
    if (repairsList.length > 0) {
      const successCount = repairsList.filter(r => r.status === 'completed').length;
      totalScore = Math.round((successCount / repairsList.length) * 30 + 70); // 70-100 range
    }

    return res.status(200).json({
      repairsCompleted: completedRepairs,
      activeRepairs,
      deviceHealthScore: totalScore,
      diagnosticsCount: diagnosticsList.length,
      history: repairsList,
      diagnostics: diagnosticsList
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to retrieve stats', error: (error as Error).message });
  }
};

// Start a new Repair session
export const startRepair = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  const { diagnosticId, scenarioId, deviceName, deviceType, steps } = req.body;

  if (!userId || !deviceName || !deviceType || !scenarioId || !steps) {
    return res.status(400).json({ message: 'Missing required fields to start repair' });
  }

  try {
    const formattedSteps = steps.map((s: any) => ({
      stepIndex: s.stepIndex,
      stepTitle: s.stepTitle,
      safetyRisk: s.safetyRisk || 'safe',
      isCompleted: false
    }));

    let newRepair: any;

    if (isUsingMockDB) {
      newRepair = {
        _id: `r-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        userId,
        diagnosisId: diagnosticId || null,
        deviceName,
        deviceType,
        scenarioId,
        currentStep: 0,
        totalSteps: formattedSteps.length,
        status: 'in_progress',
        steps: formattedSteps,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      mockDB.repairs.push(newRepair);
    } else {
      newRepair = new Repair({
        userId,
        diagnosisId: diagnosticId || undefined,
        deviceName,
        deviceType,
        scenarioId,
        currentStep: 0,
        totalSteps: formattedSteps.length,
        status: 'in_progress',
        steps: formattedSteps
      });
      await newRepair.save();
    }

    return res.status(201).json(newRepair);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to create repair tracking session', error: (error as Error).message });
  }
};

// Update Step Status
export const updateRepairStep = async (req: AuthenticatedRequest, res: Response) => {
  const { repairId } = req.params;
  const { stepIndex, isCompleted } = req.body;

  if (stepIndex === undefined || isCompleted === undefined) {
    return res.status(400).json({ message: 'Missing stepIndex or isCompleted value' });
  }

  try {
    let repair: any = null;

    if (isUsingMockDB) {
      repair = mockDB.repairs.find(r => r._id === repairId);
      if (repair) {
        const step = repair.steps.find((s: any) => s.stepIndex === stepIndex);
        if (step) {
          step.isCompleted = isCompleted;
          step.completedAt = isCompleted ? new Date() : undefined;
        }

        // Auto-increment current step index if this is completed
        const completedCount = repair.steps.filter((s: any) => s.isCompleted).length;
        repair.currentStep = completedCount;

        if (completedCount === repair.totalSteps) {
          repair.status = 'completed';
        } else {
          repair.status = 'in_progress';
        }
        repair.updatedAt = new Date();
      }
    } else {
      repair = await Repair.findById(repairId);
      if (repair) {
        const step = repair.steps.find((s: any) => s.stepIndex === stepIndex);
        if (step) {
          step.isCompleted = isCompleted;
          step.completedAt = isCompleted ? new Date() : undefined;
        }

        const completedCount = repair.steps.filter((s: any) => s.isCompleted).length;
        repair.currentStep = completedCount;

        if (completedCount === repair.totalSteps) {
          repair.status = 'completed';
        } else {
          repair.status = 'in_progress';
        }
        await repair.save();
      }
    }

    if (!repair) {
      return res.status(404).json({ message: 'Repair session not found' });
    }

    return res.status(200).json(repair);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to update repair step', error: (error as Error).message });
  }
};

// Generate Diagnostic Report
export const saveDiagnosticReport = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  const { diagnosisId, pdfUrl } = req.body;

  if (!userId || !diagnosisId || !pdfUrl) {
    return res.status(400).json({ message: 'Missing diagnosisId or pdfUrl' });
  }

  try {
    let newReport: any;

    if (isUsingMockDB) {
      newReport = {
        _id: `rep-${Date.now()}`,
        userId,
        diagnosisId,
        pdfUrl,
        createdAt: new Date()
      };
      mockDB.reports.push(newReport);
    } else {
      newReport = new Report({
        userId,
        diagnosisId,
        pdfUrl
      });
      await newReport.save();
    }

    return res.status(201).json({ message: 'Report link saved successfully', report: newReport });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to save report', error: (error as Error).message });
  }
};
