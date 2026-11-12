import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IMeetingTranscript extends Document {
  meetingId: mongoose.Types.ObjectId;
  speakerId: mongoose.Types.ObjectId;
  speakerName: string;
  text: string;
  startAt: Date;
  endAt: Date;
  chunkId: string;
  segmentIndex: number;
  sessionId: string;
  sequence: number;
  createdAt: Date;
}

const MeetingTranscriptSchema = new Schema<IMeetingTranscript>({
  meetingId: { type: Schema.Types.ObjectId, ref: 'Meeting', required: true },
  speakerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  speakerName: { type: String, required: true, maxlength: 200 },
  text: { type: String, required: true, maxlength: 10000 },
  startAt: { type: Date, required: true },
  endAt: { type: Date, required: true },
  chunkId: { type: String, required: true, maxlength: 128 },
  segmentIndex: { type: Number, required: true, min: 0, default: 0 },
  sessionId: { type: String, required: true, maxlength: 80 },
  sequence: { type: Number, required: true, min: 0 },
  createdAt: { type: Date, default: Date.now, required: true },
});

MeetingTranscriptSchema.index({ meetingId: 1, speakerId: 1, chunkId: 1, segmentIndex: 1 }, { unique: true });
MeetingTranscriptSchema.index({ meetingId: 1, createdAt: 1 });
MeetingTranscriptSchema.index({ createdAt: 1, meetingId: 1 });

const MeetingTranscript: Model<IMeetingTranscript> = mongoose.models.MeetingTranscript || mongoose.model<IMeetingTranscript>('MeetingTranscript', MeetingTranscriptSchema);
export default MeetingTranscript;
