import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IMeetingRecordingChunk extends Document {
  recordingId: mongoose.Types.ObjectId; sequence: number; byteLength: number; sha256: string; createdAt: Date;
}
const schema = new Schema<IMeetingRecordingChunk>({
  recordingId: { type: Schema.Types.ObjectId, ref: 'MeetingRecording', required: true, index: true },
  sequence: { type: Number, required: true, min: 0 }, byteLength: { type: Number, required: true, min: 1 },
  sha256: { type: String, required: true, minlength: 64, maxlength: 64 }, createdAt: { type: Date, default: Date.now, required: true },
});
schema.index({ recordingId: 1, sequence: 1 }, { unique: true });
const MeetingRecordingChunk: Model<IMeetingRecordingChunk> = mongoose.models.MeetingRecordingChunk || mongoose.model<IMeetingRecordingChunk>('MeetingRecordingChunk', schema);
export default MeetingRecordingChunk;
