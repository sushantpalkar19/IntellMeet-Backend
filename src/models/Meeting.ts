import mongoose, { Schema, Model, Document } from 'mongoose';

export enum MeetingStatus {
  SCHEDULED = 'scheduled',
  LIVE = 'live',
  ENDED = 'ended',
  CANCELLED = 'cancelled',
}

export interface IMeeting extends Document {
  workspaceId: mongoose.Types.ObjectId;
  title: string;
  description: string;
  createdBy: mongoose.Types.ObjectId;
  meetingCode: string;
  joinCode: string;
  invitationId: string;
  status: MeetingStatus;
  scheduledAt?: Date;
  endsAt?: Date;
  timeZone: string;
  meetingType: string;
  agenda: string;
  reminderMinutes: number[];
  startedAt?: Date;
  endedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MeetingSchema: Schema = new Schema(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 1000,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    meetingCode: { type: String, required: true, unique: true, index: true },
    joinCode: { type: String, required: true, unique: true, index: true },
    invitationId: { type: String, required: true, unique: true, index: true, select: false },
    status: {
      type: String,
      enum: Object.values(MeetingStatus),
      required: true,
      default: MeetingStatus.SCHEDULED,
    },
    scheduledAt: {
      type: Date,
      index: true,
    },
    endsAt: { type: Date, index: true },
    timeZone: { type: String, default: 'UTC', maxlength: 64 },
    meetingType: { type: String, default: 'team', enum: ['team', 'one_on_one', 'other'] },
    agenda: { type: String, default: '', maxlength: 10000 },
    reminderMinutes: { type: [Number], default: [15, 5] },
    startedAt: {
      type: Date,
    },
    endedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Index for querying meetings by workspace and status
MeetingSchema.index({ workspaceId: 1, status: 1 });
MeetingSchema.index({ workspaceId: 1, createdAt: 1, status: 1 });
MeetingSchema.index({ status: 1, scheduledAt: 1 });

const Meeting: Model<IMeeting> = mongoose.models.Meeting || mongoose.model<IMeeting>('Meeting', MeetingSchema);

export default Meeting;
