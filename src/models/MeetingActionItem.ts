import mongoose, { Document, Model, Schema } from 'mongoose';

export enum ActionItemStatus { PENDING = 'PENDING', IN_PROGRESS = 'IN_PROGRESS', COMPLETED = 'COMPLETED' }
export interface IMeetingActionItem extends Document {
  meetingId: mongoose.Types.ObjectId; workspaceId: mongoose.Types.ObjectId; summaryId: mongoose.Types.ObjectId;
  dedupeKey: string; taskDescription: string; assigneeId?: mongoose.Types.ObjectId | null; assigneeName?: string;
  assigneeEvidence?: string; dueDate?: Date | null; dueDateEvidence?: string; evidence: string;
  evidenceSegmentIds: mongoose.Types.ObjectId[]; status: ActionItemStatus; source: 'ai' | 'user';
  createdAt: Date; updatedAt: Date;
}
const schema = new Schema<IMeetingActionItem>({
  meetingId: { type: Schema.Types.ObjectId, ref: 'Meeting', required: true, index: true },
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  summaryId: { type: Schema.Types.ObjectId, ref: 'MeetingSummary', required: true },
  dedupeKey: { type: String, required: true, maxlength: 64 }, taskDescription: { type: String, required: true, trim: true, maxlength: 1000 },
  assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null }, assigneeName: { type: String, maxlength: 200 },
  assigneeEvidence: { type: String, maxlength: 1000 }, dueDate: { type: Date, default: null }, dueDateEvidence: { type: String, maxlength: 1000 },
  evidence: { type: String, required: true, maxlength: 2000 }, evidenceSegmentIds: [{ type: Schema.Types.ObjectId, ref: 'MeetingTranscript' }],
  status: { type: String, enum: Object.values(ActionItemStatus), default: ActionItemStatus.PENDING, required: true },
  source: { type: String, enum: ['ai', 'user'], default: 'ai', required: true },
}, { timestamps: true });
schema.index({ meetingId: 1, dedupeKey: 1 }, { unique: true });
schema.index({ meetingId: 1, status: 1, createdAt: 1 });
schema.index({ workspaceId: 1, createdAt: 1 });
const MeetingActionItem: Model<IMeetingActionItem> = mongoose.models.MeetingActionItem || mongoose.model<IMeetingActionItem>('MeetingActionItem', schema);
export default MeetingActionItem;
