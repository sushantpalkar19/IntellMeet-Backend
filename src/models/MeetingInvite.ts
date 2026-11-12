import mongoose, { Schema, Model, Document } from 'mongoose';

export type MeetingInviteStatus = 'invited' | 'accepted' | 'declined';
export interface IMeetingInvite extends Document {
  meetingId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  invitedBy: mongoose.Types.ObjectId;
  status: MeetingInviteStatus;
  createdAt: Date;
}

const MeetingInviteSchema = new Schema<IMeetingInvite>({
  meetingId: { type: Schema.Types.ObjectId, ref: 'Meeting', required: true },
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['invited', 'accepted', 'declined'], default: 'invited' },
}, { timestamps: { createdAt: true, updatedAt: false } });
MeetingInviteSchema.index({ meetingId: 1, userId: 1 }, { unique: true });
MeetingInviteSchema.index({ workspaceId: 1, userId: 1 });

export default (mongoose.models.MeetingInvite as Model<IMeetingInvite>) || mongoose.model<IMeetingInvite>('MeetingInvite', MeetingInviteSchema);
