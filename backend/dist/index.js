"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const db_1 = require("./config/db");
const auth_1 = __importDefault(require("./routes/auth"));
const ai_1 = __importDefault(require("./routes/ai"));
const repairs_1 = __importDefault(require("./routes/repairs"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5000;
// Enable CORS for frontend requests
app.use((0, cors_1.default)({
    origin: '*', // For hackathon demo simplicity, accept all origins
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
// Body parser
app.use(express_1.default.json({ limit: '10mb' })); // Allow image frames in JSON
// Standard status check
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date()
    });
});
// Mounting routes
app.use('/api/auth', auth_1.default);
app.use('/api/ai', ai_1.default);
app.use('/api/repairs', repairs_1.default);
// Database connection & Server bootstrap
const startServer = async () => {
    await (0, db_1.connectDB)();
    app.listen(PORT, () => {
        console.log(`🚀 [Server] RepairAI Copilot Backend running on http://localhost:${PORT}`);
    });
};
startServer().catch(err => {
    console.error('❌ [Server Startup Error] Critical failure:', err);
});
