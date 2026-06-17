"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = require("mongoose");
const RepairSchema = new mongoose_1.Schema({
    userId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    diagnosisId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'Diagnostic'
    },
    deviceName: {
        type: String,
        required: true
    },
    deviceType: {
        type: String,
        required: true
    },
    scenarioId: {
        type: String,
        required: true
    },
    currentStep: {
        type: Number,
        default: 0
    },
    totalSteps: {
        type: Number,
        required: true
    },
    status: {
        type: String,
        enum: ['in_progress', 'completed', 'failed'],
        default: 'in_progress'
    },
    steps: [
        {
            stepIndex: { type: Number, required: true },
            stepTitle: { type: String, required: true },
            safetyRisk: { type: String, enum: ['safe', 'medium', 'high'], default: 'safe' },
            isCompleted: { type: Boolean, default: false },
            completedAt: { type: Date }
        }
    ]
}, {
    timestamps: true
});
exports.default = (0, mongoose_1.model)('Repair', RepairSchema);
