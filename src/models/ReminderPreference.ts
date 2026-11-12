import mongoose, { Schema, Model, Document } from 'mongoose';

export interface IReminderPreference extends Document {
  userId: mongoose.Types.ObjectId;
  enabled: boolean;
  reminderMinutes: number[];
  updatedAt: Date;
}

const ReminderPreferenceSchema = new Schema<IReminderPreference>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  enabled: { type: Boolean, default: true },
  reminderMinutes: { type: [Number], default: [15, 5], validate: (values: number[]) => values.every((n) => [5, 15, 30].includes(n)) },
}, { timestamps: { createdAt: false, updatedAt: true } });

export default (mongoose.models.ReminderPreference as Model<IReminderPreference>) || mongoose.model<IReminderPreference>('ReminderPreference', ReminderPreferenceSchema);
