import mongoose, { Schema, Model, Document } from 'mongoose';

export type NotificationType = 'meeting_invitation' | 'meeting_reminder' | 'meeting_rescheduled' | 'meeting_cancelled';
export interface INotification extends Document {
  userId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  meetingId: mongoose.Types.ObjectId;
  type: NotificationType;
  title: string;
  message: string;
  deliveryKey: string;
  scheduledFor: Date;
  deliveredAt?: Date;
  readAt?: Date;
  claimUntil?: Date;
  createdAt: Date;
}

const NotificationSchema = new Schema<INotification>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  meetingId: { type: Schema.Types.ObjectId, ref: 'Meeting', required: true, index: true },
  type: { type: String, enum: ['meeting_invitation', 'meeting_reminder', 'meeting_rescheduled', 'meeting_cancelled'], required: true },
  title: { type: String, required: true, maxlength: 160 },
  message: { type: String, required: true, maxlength: 500 },
  deliveryKey: { type: String, required: true, unique: true },
  scheduledFor: { type: Date, required: true },
  deliveredAt: Date,
  readAt: Date,
  claimUntil: Date,
}, { timestamps: { createdAt: true, updatedAt: false } });
NotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
NotificationSchema.index({ deliveredAt: 1, scheduledFor: 1, claimUntil: 1 });

export default (mongoose.models.Notification as Model<INotification>) || mongoose.model<INotification>('Notification', NotificationSchema);
