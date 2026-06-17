"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = require("mongoose");
const DiagnosticSchema = new mongoose_1.Schema({
    userId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'User'
    },
    deviceName: {
        type: String,
        required: true
    },
    deviceType: {
        type: String,
        required: true
    },
    confidenceScore: {
        type: Number,
        required: true
    },
    componentsDetected: [
        {
            name: { type: String, required: true },
            bbox: { type: [Number], required: true },
            confidence: { type: Number, required: true }
        }
    ],
    difficultyScore: {
        type: Number,
        required: true
    },
    estimatedCost: {
        type: Number,
        required: true
    },
    successProbability: {
        type: Number,
        required: true
    }
}, {
    timestamps: { createdAt: true, updatedAt: false }
});
exports.default = (0, mongoose_1.model)('Diagnostic', DiagnosticSchema);
