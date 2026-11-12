import mongoose, { Document, Model, Schema } from 'mongoose';

export type SummaryGenerationStatus = 'idle' | 'processing' | 'completed' | 'failed';
export interface IMeetingSummary extends Document {
  meetingId: mongoose.Types.ObjectId; workspaceId: mongoose.Types.ObjectId; generatedBy: mongoose.Types.ObjectId;
  meetingTitle: string; meetingDate: Date; overview: string; detailedSummary: string;
  discussionPoints: string[]; decisions: string[]; keyTakeaways: string[]; unresolvedQuestions: string[];
  generationStatus: SummaryGenerationStatus; transcriptSegmentCount: number; generationError?: string;
  generatedAt?: Date; createdAt: Date; updatedAt: Date;
}

const schema = new Schema<IMeetingSummary>({
  meetingId: { type: Schema.Types.ObjectId, ref: 'Meeting', required: true, unique: true, index: true },
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  generatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  meetingTitle: { type: String, required: true, maxlength: 200 }, meetingDate: { type: Date, required: true },
  overview: { type: String, default: '', maxlength: 5000 }, detailedSummary: { type: String, default: '', maxlength: 30000 },
  discussionPoints: { type: [String], default: [] }, decisions: { type: [String], default: [] },
  keyTakeaways: { type: [String], default: [] }, unresolvedQuestions: { type: [String], default: [] },
  generationStatus: { type: String, enum: ['idle', 'processing', 'completed', 'failed'], default: 'idle', index: true },
  transcriptSegmentCount: { type: Number, default: 0, min: 0 }, generationError: { type: String, maxlength: 300 }, generatedAt: Date,
}, { timestamps: true });
schema.index({ workspaceId: 1, generationStatus: 1, createdAt: 1 });
const MeetingSummary: Model<IMeetingSummary> = mongoose.models.MeetingSummary || mongoose.model<IMeetingSummary>('MeetingSummary', schema);
export default MeetingSummary;
