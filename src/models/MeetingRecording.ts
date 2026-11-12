import mongoose, { Document, Model, Schema } from 'mongoose';

export enum RecordingStatus {
  AWAITING_CONSENT = 'awaiting_consent', RECORDING = 'recording', PAUSED = 'paused', PROCESSING = 'processing',
  COMPLETED = 'completed', INTERRUPTED = 'interrupted', CONSENT_DENIED = 'consent_denied', FAILED = 'failed',
}
export interface IRecordingConsent { userId: mongoose.Types.ObjectId; decision: 'pending' | 'consented' | 'declined'; decidedAt?: Date; }
export interface IMeetingRecording extends Document {
  meetingId: mongoose.Types.ObjectId; workspaceId: mongoose.Types.ObjectId; hostId: mongoose.Types.ObjectId;
  status: RecordingStatus; storageRef?: string; durationMs: number; fileSize: number; format: string; mimeType: string;
  activeSlot?: string; consent: IRecordingConsent[]; startedAt?: Date; completedAt?: Date; createdAt: Date; updatedAt: Date;
}
const schema = new Schema<IMeetingRecording>({
  meetingId: { type: Schema.Types.ObjectId, ref: 'Meeting', required: true, index: true },
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  hostId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: Object.values(RecordingStatus), required: true, index: true },
  activeSlot: { type: String, maxlength: 24 },
  storageRef: { type: String, maxlength: 180 }, durationMs: { type: Number, min: 0, default: 0 },
  fileSize: { type: Number, min: 0, default: 0 }, format: { type: String, required: true, maxlength: 80 },
  mimeType: { type: String, required: true, maxlength: 100 },
  consent: [{ userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, decision: { type: String, enum: ['pending', 'consented', 'declined'], required: true }, decidedAt: Date }],
  startedAt: Date, completedAt: Date,
}, { timestamps: true });
schema.index({ meetingId: 1, createdAt: -1 });
schema.index({ workspaceId: 1, status: 1, createdAt: -1 });
schema.index({ activeSlot: 1 }, { unique: true, sparse: true });
const MeetingRecording: Model<IMeetingRecording> = mongoose.models.MeetingRecording || mongoose.model<IMeetingRecording>('MeetingRecording', schema);
export default MeetingRecording;
