import { Schema, model, Document, Types } from 'mongoose';

export interface IRepairStep {
  stepIndex: number;
  stepTitle: string;
  safetyRisk: 'safe' | 'medium' | 'high';
  isCompleted: boolean;
  completedAt?: Date;
}

export interface IRepair extends Document {
  userId: Types.ObjectId;
  diagnosisId?: Types.ObjectId;
  deviceName: string;
  deviceType: string;
  scenarioId: string;
  currentStep: number;
  totalSteps: number;
  status: 'in_progress' | 'completed' | 'failed';
  steps: IRepairStep[];
  createdAt: Date;
  updatedAt: Date;
}

const RepairSchema = new Schema<IRepair>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    diagnosisId: {
      type: Schema.Types.ObjectId,
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
  },
  {
    timestamps: true
  }
);

export default model<IRepair>('Repair', RepairSchema);
