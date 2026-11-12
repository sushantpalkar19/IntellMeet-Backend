import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IWorkspaceProject extends Document {
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  description: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const WorkspaceProjectSchema = new Schema<IWorkspaceProject>({
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, default: '', trim: true, maxlength: 2000 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
WorkspaceProjectSchema.index({ workspaceId: 1, updatedAt: -1 });

export default (mongoose.models.WorkspaceProject as Model<IWorkspaceProject>) || mongoose.model<IWorkspaceProject>('WorkspaceProject', WorkspaceProjectSchema);
