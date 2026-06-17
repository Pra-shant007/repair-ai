import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/db';
import authRoutes from './routes/auth';
import aiRoutes from './routes/ai';
import repairRoutes from './routes/repairs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for frontend requests
app.use(cors({
  origin: '*', // For hackathon demo simplicity, accept all origins
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parser
app.use(express.json({ limit: '10mb' })); // Allow image frames in JSON

// Standard status check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date()
  });
});

// Mounting routes
app.use('/api/auth', authRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/repairs', repairRoutes);

// Database connection & Server bootstrap
const startServer = async () => {
  await connectDB();
  
  app.listen(PORT, () => {
    console.log(`🚀 [Server] RepairAI Copilot Backend running on http://localhost:${PORT}`);
  });
};

startServer().catch(err => {
  console.error('❌ [Server Startup Error] Critical failure:', err);
});
