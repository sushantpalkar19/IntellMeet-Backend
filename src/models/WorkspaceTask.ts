import mongoose, { Document, Model, Schema } from 'mongoose';

export enum WorkspaceTaskStatus { TODO = 'TODO', IN_PROGRESS = 'IN_PROGRESS', DONE = 'DONE' }
export enum WorkspaceTaskPriority { LOW = 'LOW', MEDIUM = 'MEDIUM', HIGH = 'HIGH', URGENT = 'URGENT' }

export interface IWorkspaceTask extends Document {
  workspaceId: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  title: string;
  description: string;
  assigneeId: mongoose.Types.ObjectId | null;
  createdBy: mongoose.Types.ObjectId;
  updatedBy: mongoose.Types.ObjectId;
  status: WorkspaceTaskStatus;
  priority: WorkspaceTaskPriority;
  dueDate: Date | null;
  statusUpdatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WorkspaceTaskSchema = new Schema<IWorkspaceTask>({
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'WorkspaceProject', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, default: '', trim: true, maxlength: 5000 },
  assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: Object.values(WorkspaceTaskStatus), default: WorkspaceTaskStatus.TODO, required: true },
  priority: { type: String, enum: Object.values(WorkspaceTaskPriority), default: WorkspaceTaskPriority.MEDIUM, required: true },
  dueDate: { type: Date, default: null },
  statusUpdatedAt: { type: Date, default: Date.now },
}, { timestamps: true });
WorkspaceTaskSchema.index({ projectId: 1, status: 1, updatedAt: -1 });
WorkspaceTaskSchema.index({ workspaceId: 1, assigneeId: 1, status: 1 });
WorkspaceTaskSchema.index({ workspaceId: 1, createdAt: 1, status: 1 });

export default (mongoose.models.WorkspaceTask as Model<IWorkspaceTask>) || mongoose.model<IWorkspaceTask>('WorkspaceTask', WorkspaceTaskSchema);
