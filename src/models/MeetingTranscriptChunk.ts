import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IMeetingTranscriptChunk extends Document {
  meetingId: mongoose.Types.ObjectId;
  speakerId: mongoose.Types.ObjectId;
  sessionId: string;
  sequence: number;
  chunkId: string;
  state: 'processing' | 'complete' | 'failed';
  updatedAt: Date;
}
const schema = new Schema<IMeetingTranscriptChunk>({
  meetingId: { type: Schema.Types.ObjectId, ref: 'Meeting', required: true },
  speakerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: String, required: true, maxlength: 80 },
  sequence: { type: Number, required: true, min: 0 },
  chunkId: { type: String, required: true, maxlength: 128 },
  state: { type: String, enum: ['processing', 'complete', 'failed'], required: true },
  updatedAt: { type: Date, default: Date.now, required: true },
});
schema.index({ meetingId: 1, speakerId: 1, chunkId: 1 }, { unique: true });
const MeetingTranscriptChunk: Model<IMeetingTranscriptChunk> = mongoose.models.MeetingTranscriptChunk || mongoose.model<IMeetingTranscriptChunk>('MeetingTranscriptChunk', schema);
export default MeetingTranscriptChunk;
