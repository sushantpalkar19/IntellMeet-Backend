import mongoose, { Schema, Model, Document } from 'mongoose';

export enum ParticipantRole {
  HOST = 'host',
  CO_HOST = 'co-host',
  PARTICIPANT = 'participant',
}

export interface IMeetingParticipant extends Document {
  meetingId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  role: ParticipantRole;
  joinedAt: Date;
  leftAt?: Date;
}

const MeetingParticipantSchema: Schema = new Schema(
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
    role: {
      type: String,
      enum: Object.values(ParticipantRole),
      required: true,
      default: ParticipantRole.PARTICIPANT,
    },
    joinedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    leftAt: {
      type: Date,
    },
  },
  {
    timestamps: false,
  }
);

// Compound unique index to prevent duplicate participant entries
MeetingParticipantSchema.index({ meetingId: 1, userId: 1 }, { unique: true });
MeetingParticipantSchema.index({ joinedAt: 1, meetingId: 1 });

const MeetingParticipant: Model<IMeetingParticipant> = mongoose.models.MeetingParticipant || mongoose.model<IMeetingParticipant>('MeetingParticipant', MeetingParticipantSchema);

export default MeetingParticipant;
