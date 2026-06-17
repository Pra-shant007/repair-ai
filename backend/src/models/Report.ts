import { Schema, model, Document, Types } from 'mongoose';

export interface IReport extends Document {
  userId: Types.ObjectId;
  diagnosisId: Types.ObjectId;
  pdfUrl: string;
  createdAt: Date;
}

const ReportSchema = new Schema<IReport>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    diagnosisId: {
      type: Schema.Types.ObjectId,
      ref: 'Diagnostic',
      required: true
    },
    pdfUrl: {
      type: String,
      required: true
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false }
  }
);

export default model<IReport>('Report', ReportSchema);
