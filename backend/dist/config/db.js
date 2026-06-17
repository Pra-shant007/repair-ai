"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectDB = exports.mockDB = exports.isUsingMockDB = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.isUsingMockDB = false;
// Simulated local datastore when MongoDB is not connected
exports.mockDB = {
    users: [],
    diagnostics: [],
    repairs: [],
    reports: []
};
// Seed initial values for Mock DB to correspond to database/seed.sql
const seedMockDB = () => {
    exports.mockDB.users.push({
        _id: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        email: 'demo.user@repairai.io',
        passwordHash: '$2a$10$X8O5D5P6gW0c9FzD85gqU.727T63T0H3yT7f4g2t6J0N8yW5f8fFe', // bcrypt for 'password123'
        fullName: 'Ashar Prashant',
        createdAt: new Date(),
        updatedAt: new Date()
    });
    const diag1 = {
        _id: 'd1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        userId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        deviceName: 'MacBook Pro 16" (M1)',
        deviceType: 'Laptop',
        confidenceScore: 96.42,
        componentsDetected: [
            { name: 'RAM', bbox: [120, 150, 80, 45], confidence: 0.98 },
            { name: 'SSD', bbox: [220, 180, 100, 30], confidence: 0.95 },
            { name: 'Battery', bbox: [50, 310, 300, 110], confidence: 0.99 }
        ],
        difficultyScore: 45,
        estimatedCost: 180.00,
        successProbability: 92.50,
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    };
    const diag2 = {
        _id: 'd2b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        userId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        deviceName: 'Netgear Nighthawk WiFi 6',
        deviceType: 'Router',
        confidenceScore: 93.10,
        componentsDetected: [
            { name: 'WiFi Board', bbox: [100, 80, 120, 140], confidence: 0.92 },
            { name: 'Power Input Port', bbox: [280, 200, 40, 40], confidence: 0.96 }
        ],
        difficultyScore: 30,
        estimatedCost: 45.00,
        successProbability: 85.00,
        createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    };
    const diag3 = {
        _id: 'd3b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        userId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        deviceName: 'iPhone 13 Pro',
        deviceType: 'Smartphone',
        confidenceScore: 97.80,
        componentsDetected: [
            { name: 'Battery', bbox: [60, 120, 110, 260], confidence: 0.98 },
            { name: 'Charging Port', bbox: [140, 390, 40, 30], confidence: 0.97 }
        ],
        difficultyScore: 75,
        estimatedCost: 65.00,
        successProbability: 78.00,
        createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)
    };
    exports.mockDB.diagnostics.push(diag1, diag2, diag3);
    exports.mockDB.repairs.push({
        _id: 'r1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        userId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        diagnosisId: 'd1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        deviceName: 'MacBook Pro 16" (M1)',
        deviceType: 'Laptop',
        scenarioId: 'laptop_ram_upgrade',
        currentStep: 4,
        totalSteps: 4,
        status: 'completed',
        steps: [
            { stepIndex: 1, stepTitle: 'Remove the bottom panel screws', safetyRisk: 'safe', isCompleted: true, completedAt: new Date() },
            { stepIndex: 2, stepTitle: 'Disconnect the battery connector safety bracket', safetyRisk: 'medium', isCompleted: true, completedAt: new Date() },
            { stepIndex: 3, stepTitle: 'Locate the RAM shield and release side clips', safetyRisk: 'safe', isCompleted: true, completedAt: new Date() },
            { stepIndex: 4, stepTitle: 'Insert the new RAM module at 30 degrees and press down', safetyRisk: 'safe', isCompleted: true, completedAt: new Date() }
        ],
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    }, {
        _id: 'r2b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        userId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        diagnosisId: 'd3b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
        deviceName: 'iPhone 13 Pro',
        deviceType: 'Smartphone',
        scenarioId: 'broken_charging_port',
        currentStep: 2,
        totalSteps: 5,
        status: 'in_progress',
        steps: [
            { stepIndex: 1, stepTitle: 'Heat the screen margins to soften adhesive', safetyRisk: 'medium', isCompleted: true, completedAt: new Date() },
            { stepIndex: 2, stepTitle: 'Apply suction cup and insert opening pick', safetyRisk: 'safe', isCompleted: true, completedAt: new Date() },
            { stepIndex: 3, stepTitle: 'Disconnect display ribbon cables', safetyRisk: 'medium', isCompleted: false },
            { stepIndex: 4, stepTitle: 'Unscrew charging dock shield plate', safetyRisk: 'safe', isCompleted: false },
            { stepIndex: 5, stepTitle: 'Replace charging port flex cable assembly', safetyRisk: 'high', isCompleted: false }
        ],
        createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)
    });
    console.log('[MockDB] Memory seeded successfully.');
};
const connectDB = async () => {
    const mongoURI = process.env.MONGODB_URI;
    if (!mongoURI) {
        console.warn('\n⚠️ [Database Warning] MONGODB_URI is not defined in environment variables.');
        console.warn('⚡ [Fallback System] Activating local memory database...');
        exports.isUsingMockDB = true;
        seedMockDB();
        return;
    }
    try {
        mongoose_1.default.set('strictQuery', true);
        await mongoose_1.default.connect(mongoURI, {
            serverSelectionTimeoutMS: 5000
        });
        console.log('🔌 [Database] MongoDB connected successfully.');
    }
    catch (error) {
        console.error(`\n❌ [Database Error] MongoDB connection failed: ${error.message}`);
        console.warn('⚡ [Fallback System] Activating local memory database...');
        exports.isUsingMockDB = true;
        seedMockDB();
    }
};
exports.connectDB = connectDB;
