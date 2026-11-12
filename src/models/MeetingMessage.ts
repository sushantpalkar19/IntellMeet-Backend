import mongoose, { Schema, Model, Document } from 'mongoose';

export enum MessageType {
  TEXT = 'text',
  SYSTEM = 'system',
}

export interface IMeetingMessage extends Document {
  meetingId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  content: string;
  messageType: MessageType;
  createdAt: Date;
}

const MeetingMessageSchema: Schema = new Schema(
  {
    meetingId: {
      type: Schema.Types.ObjectId,
      ref: 'Meeting',
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    messageType: {
      type: String,
      enum: Object.values(MessageType),
      required: true,
      default: MessageType.TEXT,
    },
  },
  {
    timestamps: false,
  }
);

// Index for querying messages by meeting and time
MeetingMessageSchema.index({ meetingId: 1, createdAt: 1 });

const MeetingMessage: Model<IMeetingMessage> = mongoose.models.MeetingMessage || mongoose.model<IMeetingMessage>('MeetingMessage', MeetingMessageSchema);

export default MeetingMessage;
