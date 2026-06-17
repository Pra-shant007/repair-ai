"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveDiagnosticReport = exports.updateRepairStep = exports.startRepair = exports.getDashboardStats = void 0;
const db_1 = require("../config/db");
const Repair_1 = __importDefault(require("../models/Repair"));
const Report_1 = __importDefault(require("../models/Report"));
const Diagnostic_1 = __importDefault(require("../models/Diagnostic"));
// Get Dashboard Statistics
const getDashboardStats = async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    try {
        let diagnosticsList = [];
        let repairsList = [];
        if (db_1.isUsingMockDB) {
            diagnosticsList = db_1.mockDB.diagnostics.filter(d => d.userId === userId);
            repairsList = db_1.mockDB.repairs.filter(r => r.userId === userId);
        }
        else {
            diagnosticsList = await Diagnostic_1.default.find({ userId }).sort({ createdAt: -1 });
            repairsList = await Repair_1.default.find({ userId }).sort({ updatedAt: -1 });
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
    }
    catch (error) {
        return res.status(500).json({ message: 'Failed to retrieve stats', error: error.message });
    }
};
exports.getDashboardStats = getDashboardStats;
// Start a new Repair session
const startRepair = async (req, res) => {
    const userId = req.user?.id;
    const { diagnosticId, scenarioId, deviceName, deviceType, steps } = req.body;
    if (!userId || !deviceName || !deviceType || !scenarioId || !steps) {
        return res.status(400).json({ message: 'Missing required fields to start repair' });
    }
    try {
        const formattedSteps = steps.map((s) => ({
            stepIndex: s.stepIndex,
            stepTitle: s.stepTitle,
            safetyRisk: s.safetyRisk || 'safe',
            isCompleted: false
        }));
        let newRepair;
        if (db_1.isUsingMockDB) {
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
            db_1.mockDB.repairs.push(newRepair);
        }
        else {
            newRepair = new Repair_1.default({
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
    }
    catch (error) {
        return res.status(500).json({ message: 'Failed to create repair tracking session', error: error.message });
    }
};
exports.startRepair = startRepair;
// Update Step Status
const updateRepairStep = async (req, res) => {
    const { repairId } = req.params;
    const { stepIndex, isCompleted } = req.body;
    if (stepIndex === undefined || isCompleted === undefined) {
        return res.status(400).json({ message: 'Missing stepIndex or isCompleted value' });
    }
    try {
        let repair = null;
        if (db_1.isUsingMockDB) {
            repair = db_1.mockDB.repairs.find(r => r._id === repairId);
            if (repair) {
                const step = repair.steps.find((s) => s.stepIndex === stepIndex);
                if (step) {
                    step.isCompleted = isCompleted;
                    step.completedAt = isCompleted ? new Date() : undefined;
                }
                // Auto-increment current step index if this is completed
                const completedCount = repair.steps.filter((s) => s.isCompleted).length;
                repair.currentStep = completedCount;
                if (completedCount === repair.totalSteps) {
                    repair.status = 'completed';
                }
                else {
                    repair.status = 'in_progress';
                }
                repair.updatedAt = new Date();
            }
        }
        else {
            repair = await Repair_1.default.findById(repairId);
            if (repair) {
                const step = repair.steps.find((s) => s.stepIndex === stepIndex);
                if (step) {
                    step.isCompleted = isCompleted;
                    step.completedAt = isCompleted ? new Date() : undefined;
                }
                const completedCount = repair.steps.filter((s) => s.isCompleted).length;
                repair.currentStep = completedCount;
                if (completedCount === repair.totalSteps) {
                    repair.status = 'completed';
                }
                else {
                    repair.status = 'in_progress';
                }
                await repair.save();
            }
        }
        if (!repair) {
            return res.status(404).json({ message: 'Repair session not found' });
        }
        return res.status(200).json(repair);
    }
    catch (error) {
        return res.status(500).json({ message: 'Failed to update repair step', error: error.message });
    }
};
exports.updateRepairStep = updateRepairStep;
// Generate Diagnostic Report
const saveDiagnosticReport = async (req, res) => {
    const userId = req.user?.id;
    const { diagnosisId, pdfUrl } = req.body;
    if (!userId || !diagnosisId || !pdfUrl) {
        return res.status(400).json({ message: 'Missing diagnosisId or pdfUrl' });
    }
    try {
        let newReport;
        if (db_1.isUsingMockDB) {
            newReport = {
                _id: `rep-${Date.now()}`,
                userId,
                diagnosisId,
                pdfUrl,
                createdAt: new Date()
            };
            db_1.mockDB.reports.push(newReport);
        }
        else {
            newReport = new Report_1.default({
                userId,
                diagnosisId,
                pdfUrl
            });
            await newReport.save();
        }
        return res.status(201).json({ message: 'Report link saved successfully', report: newReport });
    }
    catch (error) {
        return res.status(500).json({ message: 'Failed to save report', error: error.message });
    }
};
exports.saveDiagnosticReport = saveDiagnosticReport;
