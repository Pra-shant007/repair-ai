import { Schema, model, Document, Types } from 'mongoose';

export interface IComponent {
  name: string;
  bbox: [number, number, number, number]; // [x, y, width, height]
  confidence: number;
}

export interface IDiagnostic extends Document {
  userId?: Types.ObjectId;
  deviceName: string;
  deviceType: string;
  confidenceScore: number;
  componentsDetected: IComponent[];
  difficultyScore: number;
  estimatedCost: number;
  successProbability: number;
  createdAt: Date;
}

const DiagnosticSchema = new Schema<IDiagnostic>(
  {
    userId: {
      type: Schema.Types.ObjectId,
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
  },
  {
    timestamps: { createdAt: true, updatedAt: false }
  }
);

export default model<IDiagnostic>('Diagnostic', DiagnosticSchema);
