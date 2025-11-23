import mongoose, { Schema, Document } from 'mongoose';

export interface IBugReport extends Document {
  bug: string;
  reported: Date;
}

const BugReportSchema: Schema = new Schema({
  bug: {
    type: String,
    required: true,
    trim: true
  },
  reported: {
    type: Date,
    default: Date.now
  }
});

export const BugReport = mongoose.model<IBugReport>('BugReport', BugReportSchema);