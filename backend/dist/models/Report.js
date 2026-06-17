"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = require("mongoose");
const ReportSchema = new mongoose_1.Schema({
    userId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    diagnosisId: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'Diagnostic',
        required: true
    },
    pdfUrl: {
        type: String,
        required: true
    }
}, {
    timestamps: { createdAt: true, updatedAt: false }
});
exports.default = (0, mongoose_1.model)('Report', ReportSchema);
